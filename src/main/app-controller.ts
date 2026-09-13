import type { BrowserWindow } from "electron";
import type {
  AppSettings,
  AppSnapshot,
  HardwareInfo,
  IceCandidatePayload,
  StreamDescriptor,
  StreamTelemetry,
  XboxConsole,
} from "../shared/contracts";
import { emptyTelemetry, idleSession, IPC } from "../shared/contracts";
import { errorForLog, safeError } from "./errors";
import type { PlatformService } from "./platform-service";
import { SettingsStore } from "./settings-store";

interface ActiveSession {
  id: string;
  path: string;
  consoleId: string;
}

export class AppController {
  private window?: BrowserWindow;
  private activeSession?: ActiveSession;
  private connectionGeneration = 0;
  private authGeneration = 0;
  private lastConsoleId?: string;
  private snapshot: AppSnapshot;

  constructor(
    private readonly platform: PlatformService,
    private readonly preferences: SettingsStore,
    hardware: HardwareInfo,
    version: string,
  ) {
    this.snapshot = {
      auth: { status: "restoring" },
      consoles: [],
      consolesStatus: "idle",
      selectedConsoleId: preferences.selectedConsoleId,
      session: idleSession(),
      settings: preferences.settings,
      telemetry: { ...emptyTelemetry },
      hardware,
      environment: platform.mock ? "test" : "live",
      version,
    };
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window;
  }

  async initialize(): Promise<void> {
    this.patch({ auth: { status: "restoring" } });
    const restored = await this.platform.restore();
    if (!restored) {
      this.patch({ auth: { status: "signed-out" }, consolesStatus: "idle" });
      return;
    }
    this.patch({ auth: { status: "signed-in" } });
    await this.refreshConsoles();
  }

  getSnapshot(): AppSnapshot {
    return structuredClone(this.snapshot);
  }

  async beginSignIn(): Promise<void> {
    const generation = ++this.authGeneration;
    this.platform.cancelAuthentication();
    this.patch({ auth: { status: "waiting" } });
    try {
      const protocolCode = (await this.platform.beginDeviceCode()) as Awaited<
        ReturnType<PlatformService["beginDeviceCode"]>
      > & {
        internalDeviceCode?: string;
      };
      const { internalDeviceCode, ...publicCode } = protocolCode;
      if (!internalDeviceCode)
        throw new Error("Device-code response is incomplete.");
      if (generation !== this.authGeneration) return;
      this.patch({ auth: { status: "waiting", deviceCode: publicCode } });

      void this.platform
        .pollDeviceCode(
          internalDeviceCode,
          Math.max(1_000, publicCode.expiresAt - Date.now()),
        )
        .then(async () => {
          if (generation !== this.authGeneration) return;
          this.patch({ auth: { status: "signed-in" } });
          await this.refreshConsoles();
        })
        .catch((error: unknown) => {
          if (generation !== this.authGeneration) return;
          const safe = safeError(error);
          if (safe.code === "AUTH_CANCELLED") return;
          console.error("Authentication failed", errorForLog(error));
          this.patch({ auth: { status: "error", error: safe.message } });
        });
    } catch (error) {
      const safe = safeError(error);
      console.error("Could not start authentication", errorForLog(error));
      this.patch({ auth: { status: "error", error: safe.message } });
    }
  }

  async cancelSignIn(): Promise<void> {
    this.authGeneration += 1;
    this.platform.cancelAuthentication();
    this.patch({ auth: { status: "signed-out" } });
  }

  async signOut(): Promise<void> {
    await this.stopStream();
    this.authGeneration += 1;
    await this.platform.signOut();
    this.preferences.setSelectedConsole(undefined);
    this.patch({
      auth: { status: "signed-out" },
      consoles: [],
      consolesStatus: "idle",
      selectedConsoleId: undefined,
      session: idleSession(),
      telemetry: { ...emptyTelemetry },
    });
  }

  async refreshConsoles(): Promise<void> {
    this.patch({ consolesStatus: "loading", consolesError: undefined });
    try {
      const consoles = await this.platform.listConsoles();
      const selected = chooseConsole(consoles, this.snapshot.selectedConsoleId);
      this.preferences.setSelectedConsole(selected?.id);
      this.patch({
        consoles,
        consolesStatus: "ready",
        selectedConsoleId: selected?.id,
        session: idleSession(),
      });
    } catch (error) {
      const safe = safeError(error);
      console.error("Console discovery failed", errorForLog(error));
      this.patch({ consolesStatus: "error", consolesError: safe.message });
    }
  }

  async selectConsole(consoleId: string): Promise<void> {
    if (!this.snapshot.consoles.some((console) => console.id === consoleId))
      return;
    this.preferences.setSelectedConsole(consoleId);
    this.patch({ selectedConsoleId: consoleId });
  }

  async startStream(consoleId: string): Promise<StreamDescriptor> {
    const selectedConsole = this.snapshot.consoles.find(
      (candidate) => candidate.id === consoleId,
    );
    if (!selectedConsole)
      throw new Error("Choose an Xbox before starting remote play.");
    if (!selectedConsole.remotePlayEnabled) {
      this.failSession(
        "REMOTE_PLAY_DISABLED",
        "Remote play is disabled on this Xbox. Enable it under Devices & connections.",
        false,
      );
      throw new Error("Remote play is disabled on this Xbox.");
    }

    const generation = ++this.connectionGeneration;
    this.lastConsoleId = consoleId;
    this.preferences.setSelectedConsole(consoleId);
    this.patch({
      selectedConsoleId: consoleId,
      telemetry: { ...emptyTelemetry },
    });

    try {
      if (selectedConsole.power !== "on") {
        this.setSession(
          "waking",
          "Waking your Xbox",
          "Sending a wake request to the console.",
          14,
          consoleId,
        );
        await this.platform.wakeConsole(consoleId);
        this.assertCurrent(generation);
      }

      this.setSession(
        "provisioning",
        "Preparing remote play",
        "Xbox is reserving a secure streaming session.",
        34,
        consoleId,
      );
      const started = await this.platform.startSession(
        consoleId,
        this.snapshot.settings.resolution,
      );
      this.assertCurrent(generation);
      this.activeSession = {
        id: started.sessionId,
        path: started.sessionPath,
        consoleId,
      };

      let authorized = false;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        this.assertCurrent(generation);
        const state = await this.platform.getSessionState(started.sessionPath);
        this.assertCurrent(generation);

        if (state.state === "Provisioned") {
          this.setSession(
            "negotiating",
            "Starting video",
            "Finding the fastest route between this device and your Xbox.",
            78,
            consoleId,
            started.sessionId,
          );
          return {
            sessionId: started.sessionId,
            consoleId,
            mock: this.platform.mock,
          };
        }
        if (state.state === "ReadyToConnect" && !authorized) {
          authorized = true;
          this.setSession(
            "authorizing",
            "Securing the connection",
            "Confirming this remote-play session with Xbox.",
            58,
            consoleId,
            started.sessionId,
          );
          await this.platform.authorizeSession(started.sessionPath);
        } else if (state.state === "Failed") {
          throw new Error(
            state.errorDetails?.message ??
              "Xbox could not provision the remote-play session.",
          );
        } else {
          this.setSession(
            "provisioning",
            "Preparing remote play",
            "Xbox is reserving a secure streaming session.",
            42,
            consoleId,
            started.sessionId,
          );
        }
        await delay(this.platform.mock ? 40 : 750);
      }
      throw new Error("Remote-play provisioning timed out.");
    } catch (error) {
      if (generation !== this.connectionGeneration)
        throw new Error("Connection cancelled.");
      const safe = safeError(error);
      console.error("Stream start failed", errorForLog(error));
      this.failSession(safe.code, safe.message, safe.recoverable, consoleId);
      throw safe;
    }
  }

  async retryStream(): Promise<StreamDescriptor> {
    const consoleId = this.lastConsoleId ?? this.snapshot.selectedConsoleId;
    if (!consoleId) throw new Error("Choose an Xbox before retrying.");
    await this.stopActiveSession();
    return this.startStream(consoleId);
  }

  async sendSdp(
    sessionId: string,
    offer: RTCSessionDescriptionInit,
  ): Promise<{ sdp: string }> {
    const session = this.requireSession(sessionId);
    const exchange = await this.platform.exchangeSdp(session.path, offer);
    const answer = JSON.parse(exchange) as { sdp?: string };
    if (typeof answer.sdp !== "string")
      throw new Error("The Xbox returned an invalid video response.");
    return { sdp: answer.sdp };
  }

  async sendIce(
    sessionId: string,
    candidates: IceCandidatePayload[],
  ): Promise<IceCandidatePayload[]> {
    const session = this.requireSession(sessionId);
    const payload = candidates.map((candidate) => JSON.stringify(candidate));
    const exchange = await this.platform.exchangeIce(session.path, payload);
    return JSON.parse(exchange) as IceCandidatePayload[];
  }

  async keepalive(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.platform.keepalive(session.path);
  }

  async reportStreamEvent(
    sessionId: string,
    event: "connected" | "interrupted" | "failed",
    detail?: string,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    if (event === "connected") {
      this.setSession(
        "streaming",
        "Streaming",
        "Video and controls are live.",
        100,
        session.consoleId,
        session.id,
      );
      return;
    }
    if (event === "interrupted") {
      this.setSession(
        "recovering",
        "Restoring the stream",
        "The connection changed. Afterglide is reconnecting.",
        28,
        session.consoleId,
        session.id,
      );
      return;
    }
    this.failSession(
      "MEDIA_FAILED",
      detail ?? "Video could not start. Try the connection again.",
      true,
      session.consoleId,
    );
  }

  async stopStream(): Promise<void> {
    this.connectionGeneration += 1;
    await this.stopActiveSession();
    this.patch({ session: idleSession(), telemetry: { ...emptyTelemetry } });
  }

  updateTelemetry(telemetry: StreamTelemetry): void {
    this.patch({
      telemetry: {
        resolution: String(telemetry.resolution).slice(0, 32),
        framesPerSecond: clamp(telemetry.framesPerSecond, 0, 240),
        roundTripMs: clamp(telemetry.roundTripMs, 0, 10_000),
        packetLossPercent: clamp(telemetry.packetLossPercent, 0, 100),
        bitrateMbps: clamp(telemetry.bitrateMbps, 0, 500),
        codec: String(telemetry.codec).slice(0, 48),
        connection: telemetry.connection,
        videoDecoder: String(telemetry.videoDecoder).slice(0, 80),
        updatedAt: Date.now(),
      },
    });
  }

  updateSettings(update: Partial<AppSettings>): void {
    const allowed: Partial<AppSettings> = {};
    if (update.resolution === 720 || update.resolution === 1080)
      allowed.resolution = update.resolution;
    for (const key of [
      "reducedMotion",
      "showPerformance",
      "keyboardControls",
      "launchFullscreen",
    ] as const) {
      if (typeof update[key] === "boolean") allowed[key] = update[key];
    }
    this.patch({ settings: this.preferences.updateSettings(allowed) });
  }

  simulateNetworkDrop(): void {
    if (!this.platform.mock || !this.activeSession) return;
    const session = this.activeSession;
    this.setSession(
      "recovering",
      "Restoring the stream",
      "A test interruption was detected. Reconnecting now.",
      28,
      session.consoleId,
      session.id,
    );
  }

  private async stopActiveSession(): Promise<void> {
    const session = this.activeSession;
    this.activeSession = undefined;
    if (session) await this.platform.stopSession(session.path);
  }

  private requireSession(sessionId: string): ActiveSession {
    if (!this.activeSession || this.activeSession.id !== sessionId)
      throw new Error("Remote-play session is no longer active.");
    return this.activeSession;
  }

  private setSession(
    phase: AppSnapshot["session"]["phase"],
    label: string,
    detail: string,
    progress: number,
    consoleId?: string,
    sessionId?: string,
  ): void {
    this.patch({
      session: { phase, label, detail, progress, consoleId, sessionId },
    });
  }

  private failSession(
    code: string,
    message: string,
    recoverable: boolean,
    consoleId?: string,
  ): void {
    this.patch({
      session: {
        phase: "error",
        label: "Couldn’t start remote play",
        detail: message,
        progress: 0,
        errorCode: code,
        recoverable,
        consoleId,
      },
    });
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.connectionGeneration)
      throw new Error("Connection cancelled.");
  }

  private patch(update: Partial<AppSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    if (!this.window?.isDestroyed())
      this.window?.webContents.send(IPC.snapshot, this.getSnapshot());
  }
}

function chooseConsole(
  consoles: XboxConsole[],
  preferred?: string,
): XboxConsole | undefined {
  return (
    consoles.find((console) => console.id === preferred) ??
    consoles.find((console) => console.power === "on") ??
    consoles[0]
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
