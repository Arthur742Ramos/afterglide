import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  shell,
  session,
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AppSettings,
  HardwareInfo,
  IceCandidatePayload,
  StreamTelemetry,
} from "../shared/contracts";
import { IPC } from "../shared/contracts";
import { AppController } from "./app-controller";
import { LivePlatformService } from "./live-platform-service";
import { MockPlatformService } from "./mock-platform-service";
import type { PlatformService } from "./platform-service";
import {
  GitHubReleaseChecker,
  isAfterglideReleaseUrl,
} from "./release-checker";
import type { ReleaseCheckPort } from "./release-checker";
import {
  getCredentialStorageInfo,
  SecureTokenStore,
} from "./secure-token-store";
import { SettingsStore } from "./settings-store";

app.commandLine.appendSwitch("enable-accelerated-video-decode");
app.commandLine.appendSwitch("enable-zero-copy");

const isTest = !app.isPackaged && process.env.AFTERGLIDE_E2E === "1";
const isBackgroundTest = isTest && process.env.AFTERGLIDE_E2E_HEADED !== "1";

if (isBackgroundTest && process.platform === "darwin")
  app.setActivationPolicy("accessory");

if (isTest && process.env.AFTERGLIDE_E2E_USER_DATA) {
  app.setPath("userData", process.env.AFTERGLIDE_E2E_USER_DATA);
}

let mainWindow: BrowserWindow | undefined;
let controller: AppController | undefined;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

app.on("second-instance", () => {
  if (!mainWindow || isBackgroundTest) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const platform: PlatformService = isTest
    ? new MockPlatformService(process.env.AFTERGLIDE_E2E_SIGNED_IN === "1")
    : new LivePlatformService(
        new SecureTokenStore(join(userData, "auth.tokens")),
      );
  const preferences = new SettingsStore(join(userData, "preferences.json"));
  if (isTest && process.env.AFTERGLIDE_E2E_ONBOARDING !== "show")
    preferences.updateSettings({ onboardingComplete: true });
  const hardware = await readHardwareInfo();
  const releaseChecker: ReleaseCheckPort | undefined = isTest
    ? process.env.AFTERGLIDE_E2E_SCENARIO === "update-available"
      ? {
          check: async () => ({
            status: "available",
            checkedAt: Date.now(),
            version: "0.3.0-alpha.2",
            releaseUrl:
              "https://github.com/Arthur742Ramos/afterglide/releases/tag/v0.3.0-alpha.2",
            publishedAt: "2026-09-14T12:00:00Z",
          }),
        }
      : undefined
    : new GitHubReleaseChecker();
  controller = new AppController(
    platform,
    preferences,
    hardware,
    app.getVersion(),
    releaseChecker,
  );

  registerIpc(controller);
  configureSessionSecurity();
  mainWindow = createWindow(preferences.settings.launchFullscreen);
  controller.attachWindow(mainWindow);
  await controller.initialize();
  if (releaseChecker) {
    const updateTimer = setTimeout(
      () => void controller?.checkForUpdates(),
      750,
    );
    updateTimer.unref();
  }
});

app.on("window-all-closed", () => app.quit());

function createWindow(fullscreen: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    focusable: !isBackgroundTest,
    skipTaskbar: isBackgroundTest,
    fullscreen: fullscreen && !isBackgroundTest,
    autoHideMenuBar: true,
    backgroundColor: "#090a0f",
    title: "Afterglide",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // Hidden E2E windows still need animation frames and renderer timers.
      backgroundThrottling: !isBackgroundTest,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  if (!isBackgroundTest) window.once("ready-to-show", () => window.show());

  const developmentUrl = process.env.AFTERGLIDE_DEV_URL;
  if (developmentUrl && !app.isPackaged) void window.loadURL(developmentUrl);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
  return window;
}

function configureSessionSecurity(): void {
  const connectSources = app.isPackaged
    ? "'self'"
    : "'self' http://127.0.0.1:5173 ws://127.0.0.1:5173";
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.microsoft.com https://*.s-microsoft.com https://*.xboxlive.com; media-src 'self' blob:; connect-src ${connectSources}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
        ],
      },
    });
  });
}

function registerIpc(appController: AppController): void {
  const handle = <T extends unknown[]>(
    channel: string,
    fn: (...args: T) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args: T) => {
      assertTrustedSender(event.senderFrame?.url ?? event.sender.getURL());
      return fn(...args);
    });
  };

  handle(IPC.getSnapshot, () => appController.getSnapshot());
  handle(IPC.beginSignIn, () => appController.beginSignIn());
  handle(IPC.cancelSignIn, () => appController.cancelSignIn());
  handle(IPC.signOut, () => appController.signOut());
  handle(IPC.refreshConsoles, () => appController.refreshConsoles());
  handle(IPC.refreshCloudTitles, () => appController.refreshCloudTitles());
  handle(IPC.selectConsole, (consoleId: string) =>
    appController.selectConsole(consoleId),
  );
  handle(IPC.selectCloudTitle, (titleId: string) =>
    appController.selectCloudTitle(titleId),
  );
  handle(IPC.startStream, (consoleId: string) =>
    appController.startStream(consoleId),
  );
  handle(IPC.startCloudStream, (titleId: string) =>
    appController.startCloudStream(titleId),
  );
  handle(IPC.retryStream, () => appController.retryStream());
  handle(IPC.sendSdp, (sessionId: string, offer: RTCSessionDescriptionInit) =>
    appController.sendSdp(sessionId, offer),
  );
  handle(IPC.sendIce, (sessionId: string, candidates: IceCandidatePayload[]) =>
    appController.sendIce(sessionId, candidates),
  );
  handle(IPC.keepalive, (sessionId: string) =>
    appController.keepalive(sessionId),
  );
  handle(
    IPC.reportStreamEvent,
    (
      sessionId: string,
      event: "connected" | "interrupted" | "failed",
      detail?: string,
    ) => appController.reportStreamEvent(sessionId, event, detail),
  );
  handle(IPC.stopStream, () => appController.stopStream());
  handle(IPC.updateTelemetry, (telemetry: StreamTelemetry) =>
    appController.updateTelemetry(telemetry),
  );
  handle(IPC.updateSettings, (settings: Partial<AppSettings>) =>
    appController.updateSettings(settings),
  );
  handle(IPC.checkForUpdates, () => appController.checkForUpdates());
  handle(IPC.setFullscreen, (fullscreen: boolean) => {
    if (!isBackgroundTest) mainWindow?.setFullScreen(Boolean(fullscreen));
  });
  handle(IPC.quit, () => app.quit());
  handle(IPC.copyText, (text: string) =>
    clipboard.writeText(String(text).slice(0, 2_048)),
  );
  handle(IPC.openExternal, async (url: string) => {
    const parsed = new URL(url);
    const microsoft =
      parsed.protocol === "https:" &&
      ["microsoft.com", "www.microsoft.com", "login.live.com"].includes(
        parsed.hostname,
      );
    if (!microsoft && !isAfterglideReleaseUrl(parsed.toString()))
      throw new Error("This external link is not allowed.");
    await shell.openExternal(parsed.toString());
  });
  handle(IPC.testNetworkDrop, () => appController.simulateNetworkDrop());
  handle(IPC.testGamepad, (action: string) => {
    if (appController.getSnapshot().environment !== "test") return;
    mainWindow?.webContents.send(`${IPC.testGamepad}:event`, action);
  });
}

function assertTrustedSender(url: string): void {
  if (!isTrustedRendererUrl(url)) throw new Error("Untrusted IPC sender.");
}

function isTrustedRendererUrl(url: string): boolean {
  const productionEntry = pathToFileURL(
    join(__dirname, "../renderer/index.html"),
  ).toString();
  if (url === productionEntry) return true;
  if (app.isPackaged) return false;
  try {
    return new URL(url).origin === "http://127.0.0.1:5173";
  } catch {
    return false;
  }
}

async function readHardwareInfo(): Promise<HardwareInfo> {
  const featureStatus = app.getGPUFeatureStatus();
  const decode = String(featureStatus.video_decode ?? "unknown");
  const acceleration =
    decode === "enabled"
      ? "enabled"
      : decode.includes("disabled")
        ? "disabled"
        : "limited";
  let gpu = "Detected by Chromium";
  try {
    const info = (await app.getGPUInfo("basic")) as {
      gpuDevice?: Array<{ deviceString?: string }>;
    };
    gpu =
      info.gpuDevice?.find((device) => device.deviceString)?.deviceString ??
      gpu;
  } catch {
    // The feature status still provides useful evidence on unsupported drivers.
  }
  const credentialStorage = getCredentialStorageInfo();
  return {
    acceleration,
    videoDecode: decode,
    gpu,
    secureStorage: credentialStorage.secure,
    credentialStorage: credentialStorage.storage,
  };
}
