import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  shell,
  session,
  powerMonitor,
  powerSaveBlocker,
  Menu,
  screen,
} from "electron";
import { savePerformanceReport } from "./save-performance-report";
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
  getCredentialStorageInfo,
  SecureTokenStore,
} from "./secure-token-store";
import { SettingsStore } from "./settings-store";
import { readDeviceMetrics } from "./device-metrics";
import { observePlaybackWindow } from "./playback-window";
import { observePowerContext } from "./power-context";
import {
  desktopMenuTemplate,
  restoreWindowPlacement,
  shouldQuitAfterLastWindow,
  syncDisplaySleepBlocker,
} from "./desktop-policy";
import { readWindowState, saveWindowState } from "./window-state";

app.setName("Afterglide Cloud");
app.setPath("userData", join(app.getPath("appData"), "Afterglide Cloud"));
if (process.platform === "win32")
  app.setAppUserModelId("io.github.Arthur742Ramos.AfterglideCloud");

app.commandLine.appendSwitch("enable-accelerated-video-decode");
app.commandLine.appendSwitch("enable-zero-copy");

const isTest = !app.isPackaged && process.env.AFTERGLIDE_CLOUD_E2E === "1";
const isBackgroundTest =
  isTest && process.env.AFTERGLIDE_CLOUD_E2E_HEADED !== "1";

if (isBackgroundTest && process.platform === "darwin")
  app.setActivationPolicy("accessory");

if (isTest && process.env.AFTERGLIDE_CLOUD_E2E_USER_DATA) {
  app.setPath("userData", process.env.AFTERGLIDE_CLOUD_E2E_USER_DATA);
} else if (isTest) {
  app.setPath(
    "userData",
    join(app.getPath("appData"), "Afterglide Cloud Demo"),
  );
}

let mainWindow: BrowserWindow | undefined;
let controller: AppController | undefined;
let preferences: SettingsStore | undefined;
let quitting = false;
let shutdownComplete = false;
let gpuInfoReady = false;
let refreshingHardware = false;
let displaySleepBlockerId: number | undefined;
let playbackWindow: ReturnType<typeof observePlaybackWindow> | undefined;

function syncPowerSave(phase = controller?.getSessionPhase() ?? "idle"): void {
  const activePhase =
    quitting || !mainWindow || mainWindow.isDestroyed() || !controller
      ? "idle"
      : phase;
  playbackWindow?.setPhase(activePhase);
  displaySleepBlockerId = syncDisplaySleepBlocker(
    activePhase,
    displaySleepBlockerId,
    powerSaveBlocker,
  );
}

// Feature status before GPU initialization can incorrectly report software-only.
app.on("gpu-info-update", () => {
  gpuInfoReady = true;
  if (
    !controller ||
    quitting ||
    refreshingHardware ||
    controller.getSnapshot().hardware.videoDecode ===
      String(app.getGPUFeatureStatus().video_decode ?? "unknown")
  )
    return;
  refreshingHardware = true;
  void readHardwareInfo()
    .then((hardware) => controller?.updateHardware(hardware))
    .catch(() => {})
    .finally(() => {
      refreshingHardware = false;
    });
});

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
    ? new MockPlatformService(
        process.env.AFTERGLIDE_CLOUD_E2E_SIGNED_IN === "1",
      )
    : new LivePlatformService(
        new SecureTokenStore(join(userData, "auth.tokens")),
      );
  preferences = new SettingsStore(join(userData, "preferences.json"));
  if (isTest && process.env.AFTERGLIDE_CLOUD_E2E_ONBOARDING !== "show")
    preferences.updateSettings({ onboardingComplete: true });
  const hardware = await readHardwareInfo();
  controller = new AppController(
    platform,
    preferences,
    hardware,
    app.getVersion(),
    undefined,
    syncPowerSave,
  );

  registerIpc(controller);
  configureSessionSecurity();
  app.setAboutPanelOptions({
    applicationName: "Afterglide Cloud",
    applicationVersion: app.getVersion(),
    copyright:
      "Derived from Afterglide \u00a9 2026 Arthur Paulino. Independent client; not affiliated with Microsoft or Xbox.",
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      desktopMenuTemplate(
        process.platform,
        (command) => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          const contents = mainWindow.webContents;
          if (contents.isDestroyed() || contents.isCrashed()) return;
          try {
            contents.send(IPC.desktopCommand, command);
          } catch {
            // A renderer can disappear between the check and IPC delivery.
          }
        },
        () => {
          if (
            mainWindow &&
            !mainWindow.isDestroyed() &&
            mainWindow.webContents.isCrashed()
          )
            mainWindow.webContents.reload();
        },
      ),
    ),
  );
  openMainWindow();
  const stopPowerContext = observePowerContext(
    powerMonitor,
    process.platform,
    (context) => controller?.updatePowerContext(context),
  );
  app.once("will-quit", stopPowerContext);
  await controller.initialize();
  let sampling = false;
  const deviceTimer = setInterval(async () => {
    if (sampling) return;
    const sampleContext = controller?.getDeviceSampleContext();
    if (!sampleContext?.streaming) return;
    sampling = true;
    try {
      const processes = app.getAppMetrics();
      const cpu = processes.length
        ? processes.reduce(
            (total, process) => total + process.cpu.percentCPUUsage,
            0,
          )
        : undefined;
      const metrics = await readDeviceMetrics(cpu);
      const current = controller?.getDeviceSampleContext();
      if (
        sampleContext.sessionId === current?.sessionId &&
        sampleContext.inputPolling === current?.inputPolling &&
        sampleContext.resolution === current?.resolution
      )
        controller?.updateDeviceMetrics(metrics);
    } catch (error) {
      console.error("Device performance sampling failed", error);
    } finally {
      sampling = false;
    }
  }, 5_000);
  deviceTimer.unref();
  app.once("before-quit", () => clearInterval(deviceTimer));
});

app.on("window-all-closed", () => {
  if (shouldQuitAfterLastWindow(process.platform, isTest)) app.quit();
});

app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) openMainWindow();
  else if (!isBackgroundTest) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("before-quit", (event) => {
  if (shutdownComplete || !controller) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  syncPowerSave();
  if (controller.getSnapshot().auth.status === "waiting")
    void controller.cancelSignIn();
  const finish = () => {
    if (shutdownComplete) return;
    shutdownComplete = true;
    app.quit();
  };
  const timeout = setTimeout(finish, 3000);
  void controller
    .stopStream()
    .catch(() => {
      console.warn("Cloud session cleanup could not finish before exit.");
    })
    .finally(() => {
      clearTimeout(timeout);
      finish();
    });
});

function openMainWindow(): void {
  if (!controller || !preferences || quitting) return;
  const window = createWindow(preferences.settings.launchFullscreen);
  mainWindow = window;
  controller.attachWindow(window);
  const observation = observePlaybackWindow(
    window,
    powerMonitor,
    (state) => controller?.updatePlaybackWindow(state),
    isBackgroundTest,
  );
  playbackWindow = observation;
  observation.setPhase(controller.getSessionPhase());
  controller.setFullscreenState(window.isFullScreen());
  window.on("enter-full-screen", () => controller?.setFullscreenState(true));
  window.on("leave-full-screen", () => controller?.setFullscreenState(false));
  window.on("closed", () => {
    observation.dispose();
    if (playbackWindow === observation) playbackWindow = undefined;
    if (mainWindow === window) mainWindow = undefined;
    syncPowerSave();
    if (process.platform === "darwin" && !quitting && !isTest) {
      if (controller?.getSnapshot().auth.status === "waiting")
        void controller.cancelSignIn();
      void controller
        ?.stopStream()
        .catch(() =>
          console.warn(
            "Cloud session cleanup could not finish after closing the window.",
          ),
        );
    }
  });
}

function createWindow(fullscreen: boolean): BrowserWindow {
  const statePath = join(app.getPath("userData"), "window-state.json");
  const placement = restoreWindowPlacement(
    readWindowState(statePath),
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
  );
  const window = new BrowserWindow({
    ...placement.bounds,
    minWidth: placement.minWidth,
    minHeight: placement.minHeight,
    show: false,
    focusable: !isBackgroundTest,
    skipTaskbar: isBackgroundTest,
    // Explicit fullscreen:false disables native fullscreen on macOS.
    ...(fullscreen && !isBackgroundTest ? { fullscreen: true } : {}),
    fullscreenable: !isBackgroundTest,
    autoHideMenuBar: true,
    backgroundColor: "#090a0f",
    title: "Afterglide Cloud",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      additionalArguments: isTest ? ["--afterglide-cloud-test=1"] : [],
      spellcheck: false,
      // Hidden E2E windows still need animation frames and renderer timers.
      backgroundThrottling: !isBackgroundTest,
      // Render independently of native-window visibility, including under Xvfb.
      offscreen: isBackgroundTest,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const rendererLost = () => {
    void controller?.rendererLost().catch(() => {
      console.warn("The interrupted renderer launch could not be cleaned up.");
    });
  };
  window.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) rendererLost();
  });
  // Recover the UI once per window. A persistent renderer failure must not
  // cause an unbounded reload loop or automatically replace an Xbox session.
  let crashReloaded = false;
  window.webContents.on("did-finish-load", () => {
    const reload = Menu.getApplicationMenu()?.getMenuItemById(
      "desktop-reload-controls",
    );
    if (reload) reload.enabled = false;
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    if (quitting || window.isDestroyed()) return;
    rendererLost();
    const reload = Menu.getApplicationMenu()?.getMenuItemById(
      "desktop-reload-controls",
    );
    if (reload) reload.enabled = true;
    if (
      !crashReloaded &&
      ["crashed", "oom", "abnormal-exit", "killed"].includes(details.reason)
    ) {
      crashReloaded = true;
      window.webContents.reload();
    }
  });
  if (placement.maximized && !fullscreen && !isBackgroundTest)
    window.maximize();
  window.on("close", () => {
    try {
      saveWindowState(
        statePath,
        window.getNormalBounds(),
        window.isMaximized(),
      );
    } catch {
      console.warn("Window placement could not be saved.");
    }
  });
  window.on("page-title-updated", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  if (!isBackgroundTest) window.once("ready-to-show", () => window.show());

  const developmentUrl = process.env.AFTERGLIDE_CLOUD_DEV_URL;
  if (developmentUrl && !app.isPackaged) void window.loadURL(developmentUrl);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
  return window;
}

function configureSessionSecurity(): void {
  const connectSources = app.isPackaged
    ? "'self'"
    : "'self' http://127.0.0.1:5174 ws://127.0.0.1:5174";
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
  handle(IPC.signOut, async () => {
    try {
      await appController.signOut();
    } finally {
      syncPowerSave();
    }
  });
  handle(IPC.refreshCloudTitles, () => appController.refreshCloudTitles());
  handle(IPC.searchCloudTitles, (query: string) =>
    appController.searchCloudTitles(query),
  );
  handle(IPC.cancelCloudSearch, () => appController.cancelCloudSearch());
  handle(IPC.selectCloudTitle, (titleId: string) =>
    appController.selectCloudTitle(titleId),
  );
  handle(IPC.startCloudStream, async (titleId: string) => {
    try {
      return await appController.startCloudStream(titleId);
    } finally {
      syncPowerSave();
    }
  });
  handle(IPC.retryStream, async () => {
    try {
      return await appController.retryStream();
    } finally {
      syncPowerSave();
    }
  });
  handle(IPC.sendSdp, (sessionId: string, offer: RTCSessionDescriptionInit) =>
    appController.sendSdp(sessionId, offer),
  );
  handle(IPC.sendIce, (sessionId: string, candidates: IceCandidatePayload[]) =>
    appController.sendIce(sessionId, candidates),
  );
  handle(
    IPC.reportStreamEvent,
    async (
      sessionId: string,
      event: "connected" | "interrupted" | "lost" | "failed",
      detail?: string,
    ) => {
      try {
        await appController.reportStreamEvent(sessionId, event, detail);
      } finally {
        syncPowerSave();
      }
    },
  );
  handle(IPC.stopStream, async () => {
    try {
      await appController.stopStream();
    } finally {
      syncPowerSave();
    }
  });
  ipcMain.on(IPC.updateTelemetry, (event, telemetry: StreamTelemetry) => {
    const url = event.senderFrame?.url ?? event.sender.getURL();
    if (!isTrustedRendererUrl(url)) {
      console.warn("Ignored telemetry from an untrusted IPC sender.");
      return;
    }
    appController.updateTelemetry(telemetry);
  });
  handle(IPC.updateSettings, (settings: Partial<AppSettings>) =>
    appController.updateSettings(settings),
  );
  handle(IPC.checkForUpdates, () => appController.checkForUpdates());
  let exporting = false;
  handle(IPC.exportPerformanceReport, async () => {
    if (exporting) throw new Error("A performance export is already open.");
    if (!mainWindow || mainWindow.isDestroyed())
      throw new Error("The application window is unavailable.");
    exporting = true;
    try {
      const report = appController.exportPerformanceReport();
      return await savePerformanceReport(app.getPath("downloads"), report);
    } finally {
      exporting = false;
    }
  });
  handle(IPC.setFullscreen, (fullscreen: boolean) => {
    if (!isBackgroundTest) mainWindow?.setFullScreen(Boolean(fullscreen));
    else appController.setFullscreenState(Boolean(fullscreen));
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
    if (!microsoft) throw new Error("This external link is not allowed.");
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
    return new URL(url).origin === "http://127.0.0.1:5174";
  } catch {
    return false;
  }
}

async function readHardwareInfo(): Promise<HardwareInfo> {
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
  const decode = gpuInfoReady
    ? String(app.getGPUFeatureStatus().video_decode ?? "unknown")
    : "unknown";
  const acceleration =
    decode === "unknown"
      ? "unknown"
      : decode === "enabled"
        ? "enabled"
        : decode.includes("disabled")
          ? "disabled"
          : "limited";
  const credentialStorage = getCredentialStorageInfo();
  return {
    acceleration,
    videoDecode: decode,
    gpu,
    secureStorage: credentialStorage.secure,
    credentialStorage: credentialStorage.storage,
  };
}
