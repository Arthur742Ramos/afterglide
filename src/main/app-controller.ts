import type { BrowserWindow } from "electron";
import type {
  AppSettings,
  AppSnapshot,
  CloudTitle,
  HardwareInfo,
  IceCandidatePayload,
  StreamDescriptor,
  StreamTelemetry,
  XboxConsole,
} from "../shared/contracts";
import { emptyTelemetry, idleSession, IPC } from "../shared/contracts";
import { sanitizeSettingsUpdate } from "../shared/controller-settings";
import { NETWORK_POLICY } from "../shared/network-policy";
import { errorForLog, safeError } from "./errors";
import type { PlatformService, StreamTarget } from "./platform-service";
import type { ReleaseCheckPort } from "./release-checker";
import { SettingsStore } from "./settings-store";
import { PerformanceReport, type DeviceMetrics } from "./performance-report";

interface ActiveSession {
  id: string;
  path: string;
  source: StreamTarget["source"];
  targetId: string;
  targetName: string;
}

interface NamedTarget extends StreamTarget {
  name: string;
}

export class AppController {
  private window?: BrowserWindow;
  private activeSession?: ActiveSession;
  private connectionGeneration = 0;
  private authGeneration = 0;
  private lastTarget?: StreamTarget;
  private updateCheck?: Promise<void>;
  private snapshot: AppSnapshot;
  private readonly performanceReport = new PerformanceReport();
  private deviceMetrics?: DeviceMetrics;
  private recoveryStartedAt?: number;
  private recoveryMs?: number;
  private retryPending = false;
  private startingTarget = false;

  constructor(
    private readonly platform: PlatformService,
    private readonly preferences: SettingsStore,
    hardware: HardwareInfo,
    private readonly version: string,
    private readonly releaseChecker?: ReleaseCheckPort,
  ) {
    this.snapshot = {
      auth: { status: "restoring" },
      consoles: [],
      consolesStatus: "idle",
      selectedConsoleId: preferences.selectedConsoleId,
      cloud: {
        available: false,
        titles: [],
        status: "idle",
      },
      session: idleSession(),
      settings: preferences.settings,
      telemetry: { ...emptyTelemetry },
      hardware,
      update: { status: "idle" },
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
    await Promise.all([this.refreshConsoles(), this.refreshCloudTitles()]);
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
          await Promise.all([
            this.refreshConsoles(),
            this.refreshCloudTitles(),
          ]);
        })
        .catch((error: unknown) => {
          if (generation !== this.authGeneration) return;
          const safe = safeError(error);
          if (safe.code === "AUTH_CANCELLED") return;
          console.error("Authentication failed", errorForLog(error));
          this.patch({ auth: { status: "error", error: safe.message } });
        });
    } catch (error) {
      if (generation !== this.authGeneration) return;
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
    this.lastTarget = undefined;
    this.authGeneration += 1;
    await this.platform.signOut();
    this.preferences.setSelectedConsole(undefined);
    this.patch({
      auth: { status: "signed-out" },
      consoles: [],
      consolesStatus: "idle",
      selectedConsoleId: undefined,
      cloud: {
        available: false,
        titles: [],
        status: "idle",
      },
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

  async refreshCloudTitles(): Promise<void> {
    if (
      !this.platform.cloudAvailable &&
      this.snapshot.cloud.status === "idle"
    ) {
      this.patch({
        cloud: {
          available: false,
          titles: [],
          status: "unavailable",
          error: "Cloud gaming requires a supported account and region.",
        },
      });
      return;
    }
    this.patch({
      cloud: {
        ...this.snapshot.cloud,
        available: this.platform.cloudAvailable,
        status: "loading",
        error: undefined,
      },
    });
    try {
      const titles = await this.platform.listCloudTitles();
      const selectedTitleId = chooseCloudTitle(
        titles,
        this.snapshot.cloud.selectedTitleId,
      )?.id;
      this.patch({
        cloud: {
          available: true,
          titles,
          status: "ready",
          selectedTitleId,
        },
      });
    } catch (error) {
      const safe = safeError(error);
      console.error("Cloud title discovery failed", errorForLog(error));
      this.patch({
        cloud: {
          ...this.snapshot.cloud,
          available: this.platform.cloudAvailable,
          status: safe.code === "XCLOUD_UNAVAILABLE" ? "unavailable" : "error",
          error: safe.message,
        },
      });
    }
  }

  async selectCloudTitle(titleId: string): Promise<void> {
    if (!this.snapshot.cloud.titles.some((title) => title.id === titleId))
      return;
    this.patch({
      cloud: { ...this.snapshot.cloud, selectedTitleId: titleId },
    });
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
        { source: "home", id: consoleId, name: selectedConsole.name },
      );
      throw new Error("Remote play is disabled on this Xbox.");
    }

    this.preferences.setSelectedConsole(consoleId);
    this.patch({
      selectedConsoleId: consoleId,
      telemetry: { ...emptyTelemetry },
    });

    return this.startTarget(
      { source: "home", id: consoleId, name: selectedConsole.name },
      selectedConsole.power !== "on",
    );
  }

  async startCloudStream(titleId: string): Promise<StreamDescriptor> {
    const title = this.snapshot.cloud.titles.find(
      (candidate) => candidate.id === titleId,
    );
    if (!title) throw new Error("Choose a cloud game before starting.");
    this.patch({
      cloud: { ...this.snapshot.cloud, selectedTitleId: titleId },
      telemetry: { ...emptyTelemetry },
    });
    return this.startTarget(
      { source: "cloud", id: titleId, name: title.name },
      false,
    );
  }

  private async startTarget(
    target: NamedTarget,
    shouldWake: boolean,
  ): Promise<StreamDescriptor> {
    if (this.startingTarget)
      throw new Error(
        "The previous connection is still finishing. Try again shortly.",
      );
    this.startingTarget = true;
    const generation = ++this.connectionGeneration;
    this.lastTarget = { source: target.source, id: target.id };
    if (this.recoveryStartedAt === undefined) {
      this.performanceReport.reset(target.source);
      this.recoveryMs = undefined;
    }
    this.deviceMetrics = undefined;

    try {
      if (shouldWake) {
        this.setSession(
          "waking",
          "Waking your Xbox",
          "Sending a wake request to the console.",
          14,
          target,
        );
        await this.platform.wakeConsole(target.id);
        this.assertCurrent(generation);
      }

      this.setSession(
        "provisioning",
        target.source === "cloud"
          ? "Launching from the cloud"
          : "Preparing remote play",
        target.source === "cloud"
          ? "Xbox Cloud Gaming is finding capacity for your game."
          : "Xbox is reserving a secure streaming session.",
        34,
        target,
      );
      const started = await this.platform.startSession(
        target,
        this.snapshot.settings.resolution,
      );
      if (generation !== this.connectionGeneration) {
        await this.platform.stopSession(started.sessionPath);
      }
      this.assertCurrent(generation);
      this.activeSession = {
        id: started.sessionId,
        path: started.sessionPath,
        source: target.source,
        targetId: target.id,
        targetName: target.name,
      };

      let authorized = false;
      const deadline =
        Date.now() + (target.source === "cloud" ? 180_000 : 60_000);
      while (Date.now() < deadline) {
        this.assertCurrent(generation);
        const state = await this.platform.getSessionState(started.sessionPath);
        this.assertCurrent(generation);

        if (state.state === "Provisioned") {
          this.setSession(
            "negotiating",
            "Starting video",
            target.source === "cloud"
              ? "Connecting this device to the Xbox cloud stream."
              : "Finding the fastest route between this device and your Xbox.",
            78,
            target,
            started.sessionId,
          );
          return {
            sessionId: started.sessionId,
            source: target.source,
            targetId: target.id,
            displayName: target.name,
            ...(target.source === "home"
              ? { consoleId: target.id }
              : { titleId: target.id }),
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
            target,
            started.sessionId,
          );
          await this.platform.authorizeSession(started.sessionPath);
        } else if (state.state === "Failed") {
          throw new Error(
            state.errorDetails?.message ??
              "Xbox could not provision the streaming session.",
          );
        } else {
          this.setSession(
            "provisioning",
            target.source === "cloud"
              ? "Launching from the cloud"
              : "Preparing remote play",
            target.source === "cloud"
              ? "Xbox Cloud Gaming is finding capacity for your game."
              : "Xbox is reserving a secure streaming session.",
            42,
            target,
            started.sessionId,
          );
        }
        await delay(this.platform.mock ? 40 : 750);
      }
      throw new Error("Xbox streaming provisioning timed out.");
    } catch (error) {
      if (generation !== this.connectionGeneration)
        throw new Error("Connection cancelled.");
      const safe = safeError(error);
      console.error("Stream start failed", errorForLog(error));
      this.failSession(safe.code, safe.message, safe.recoverable, target);
      throw safe;
    } finally {
      this.startingTarget = false;
    }
  }

  async retryStream(): Promise<StreamDescriptor> {
    const target = this.lastTarget;
    if (!target) throw new Error("Choose something to play before retrying.");
    if (this.retryPending)
      throw new Error("A reconnection is already running.");
    this.retryPending = true;
    const generation = ++this.connectionGeneration;
    try {
      await this.stopActiveSession();
      this.assertCurrent(generation);
      return await (target.source === "home"
        ? this.startStream(target.id)
        : this.startCloudStream(target.id));
    } finally {
      this.retryPending = false;
    }
  }

  async sendSdp(
    sessionId: string,
    offer: RTCSessionDescriptionInit,
  ): Promise<{ sdp: string }> {
    const session = this.requireSession(sessionId);
    if ((offer.sdp?.length ?? 0) > NETWORK_POLICY.maxSdpBytes)
      throw new Error("The video offer is too large.");
    const exchange = await this.platform.exchangeSdp(session.path, offer);
    if (exchange.length > NETWORK_POLICY.maxSdpBytes)
      throw new Error("The Xbox returned an oversized video response.");
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
    const bounded = candidates.slice(0, NETWORK_POLICY.maxIceCandidates);
    const payload = bounded.map((candidate) => JSON.stringify(candidate));
    if (payload.join("").length > NETWORK_POLICY.maxIcePayloadBytes)
      throw new Error("The network route list is too large.");
    const exchange = await this.platform.exchangeIce(session.path, payload);
    if (exchange.length > NETWORK_POLICY.maxIcePayloadBytes)
      throw new Error("The Xbox returned too many network routes.");
    const parsed = JSON.parse(exchange) as unknown;
    if (!Array.isArray(parsed))
      throw new Error("The Xbox returned invalid network routes.");
    return parsed
      .filter(isIceCandidatePayload)
      .slice(0, NETWORK_POLICY.maxIceCandidates);
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
    const session = this.activeSession;
    if (!session || session.id !== sessionId) return;
    if (event === "connected") {
      if (!["negotiating", "streaming"].includes(this.snapshot.session.phase))
        return;
      if (this.snapshot.session.phase === "negotiating")
        this.performanceReport.connected();
      if (this.recoveryStartedAt !== undefined) {
        this.recoveryMs = Math.max(0, Date.now() - this.recoveryStartedAt);
        this.performanceReport.recovered(
          this.recoveryStartedAt,
          this.recoveryMs,
        );
        this.recoveryStartedAt = undefined;
      }
      this.setSession(
        "streaming",
        "Streaming",
        "Video and controls are live.",
        100,
        {
          source: session.source,
          id: session.targetId,
          name: session.targetName,
        },
        session.id,
      );
      return;
    }
    if (event === "interrupted") {
      if (this.snapshot.session.phase !== "streaming") return;
      this.recoveryStartedAt ??= Date.now();
      this.setSession(
        "recovering",
        "Restoring the stream",
        "The connection changed. Afterglide will try a new streaming connection. Cloud game progress may not be preserved.",
        28,
        {
          source: session.source,
          id: session.targetId,
          name: session.targetName,
        },
        session.id,
      );
      return;
    }
    this.failSession(
      "MEDIA_FAILED",
      detail ?? "Video could not start. Try the connection again.",
      true,
      {
        source: session.source,
        id: session.targetId,
        name: session.targetName,
      },
    );
  }

  async stopStream(): Promise<void> {
    this.connectionGeneration += 1;
    this.recoveryStartedAt = undefined;
    this.recoveryMs = undefined;
    this.deviceMetrics = undefined;
    this.patch({ session: idleSession() });
    await this.stopActiveSession();
  }

  handleSystemResume(): void {
    if (this.activeSession && this.snapshot.session.phase === "streaming")
      void this.reportStreamEvent(this.activeSession.id, "interrupted");
  }

  updateDeviceMetrics(metrics: DeviceMetrics): void {
    if (this.snapshot.session.phase === "streaming")
      this.deviceMetrics = structuredClone(metrics);
  }

  getDeviceSampleContext() {
    return {
      streaming: this.snapshot.session.phase === "streaming",
      sessionId: this.snapshot.session.sessionId,
      inputPolling: this.snapshot.settings.inputPolling,
      resolution: this.snapshot.settings.resolution,
    };
  }

  exportPerformanceReport() {
    return this.performanceReport.export(
      this.version,
      this.snapshot.environment,
      this.snapshot.hardware,
    );
  }

  updateTelemetry(telemetry: StreamTelemetry): void {
    const sanitized: StreamTelemetry = {
      resolution: String(telemetry.resolution).slice(0, 32),
      framesPerSecond: clamp(telemetry.framesPerSecond, 0, 240),
      roundTripMs: clamp(telemetry.roundTripMs, 0, 10_000),
      packetLossPercent: clamp(telemetry.packetLossPercent, 0, 100),
      bitrateMbps: clamp(telemetry.bitrateMbps, 0, 500),
      codec: String(telemetry.codec).slice(0, 48),
      connection: isConnectionType(telemetry.connection)
        ? telemetry.connection
        : "unknown",
      videoDecoder: String(telemetry.videoDecoder).slice(0, 80),
      decodeMs: optionalMeasurement(telemetry.decodeMs, 10_000),
      jitterBufferMs: optionalMeasurement(telemetry.jitterBufferMs, 10_000),
      inputQueueBytes: optionalMeasurement(
        telemetry.inputQueueBytes,
        16_777_216,
      ),
      frameIntervalP95Ms: optionalMeasurement(
        telemetry.frameIntervalP95Ms,
        60_000,
      ),
      frameIntervalP99Ms: optionalMeasurement(
        telemetry.frameIntervalP99Ms,
        60_000,
      ),
      framesDropped: optionalMeasurement(
        telemetry.framesDropped,
        Number.MAX_SAFE_INTEGER,
      ),
      freezeCount: optionalMeasurement(
        telemetry.freezeCount,
        Number.MAX_SAFE_INTEGER,
      ),
      freezeDurationMs: optionalMeasurement(
        telemetry.freezeDurationMs,
        Number.MAX_SAFE_INTEGER,
      ),
      recoveryMs: this.recoveryMs,
      networkQuality: isNetworkQuality(telemetry.networkQuality)
        ? telemetry.networkQuality
        : "measuring",
      updatedAt: Date.now(),
    };
    // Telemetry is a one-way high-frequency path. Keep it for reports and later
    // snapshots without cloning and rebroadcasting the full application state.
    this.snapshot = { ...this.snapshot, telemetry: sanitized };
    if (this.activeSession && this.snapshot.session.phase === "streaming")
      this.performanceReport.add(
        sanitized,
        this.snapshot.settings,
        this.deviceMetrics,
      );
  }

  updateSettings(update: Partial<AppSettings>): void {
    const allowed = sanitizeSettingsUpdate(update, this.snapshot.settings);
    if (
      (allowed.inputPolling !== undefined &&
        allowed.inputPolling !== this.snapshot.settings.inputPolling) ||
      (allowed.resolution !== undefined &&
        allowed.resolution !== this.snapshot.settings.resolution)
    )
      this.deviceMetrics = undefined;
    this.patch({ settings: this.preferences.updateSettings(allowed) });
  }

  checkForUpdates(): Promise<void> {
    if (this.updateCheck) return this.updateCheck;
    if (!this.releaseChecker) {
      this.patch({ update: { status: "current", checkedAt: Date.now() } });
      return Promise.resolve();
    }
    this.patch({ update: { status: "checking" } });
    this.updateCheck = this.releaseChecker
      .check(this.version)
      .then((update) => this.patch({ update }))
      .finally(() => {
        this.updateCheck = undefined;
      });
    return this.updateCheck;
  }

  simulateNetworkDrop(): void {
    if (!this.platform.mock || !this.activeSession) return;
    void this.reportStreamEvent(this.activeSession.id, "interrupted");
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
    target?: NamedTarget,
    sessionId?: string,
  ): void {
    this.patch({
      session: {
        phase,
        label,
        detail,
        progress,
        sessionId,
        source: target?.source,
        targetName: target?.name,
        ...(target?.source === "home"
          ? { consoleId: target.id }
          : target?.source === "cloud"
            ? { titleId: target.id }
            : {}),
      },
    });
  }

  private failSession(
    code: string,
    message: string,
    recoverable: boolean,
    target?: NamedTarget,
  ): void {
    this.patch({
      session: {
        phase: "error",
        label:
          code === "MEDIA_FAILED"
            ? "The stream stopped"
            : target?.source === "cloud"
              ? "Couldn’t start cloud play"
              : "Couldn’t start remote play",
        detail: message,
        progress: 0,
        errorCode: code,
        recoverable,
        source: target?.source,
        targetName: target?.name,
        ...(target?.source === "home"
          ? { consoleId: target.id }
          : target?.source === "cloud"
            ? { titleId: target.id }
            : {}),
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

function chooseCloudTitle(
  titles: CloudTitle[],
  preferred?: string,
): CloudTitle | undefined {
  return (
    titles.find((title) => title.id === preferred) ??
    titles.find((title) => title.recentlyPlayed) ??
    titles[0]
  );
}

function isIceCandidatePayload(value: unknown): value is IceCandidatePayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IceCandidatePayload>;
  return (
    typeof candidate.candidate === "string" &&
    candidate.candidate.length <= 8_192 &&
    (candidate.sdpMid === null || typeof candidate.sdpMid === "string") &&
    (candidate.sdpMLineIndex === null ||
      typeof candidate.sdpMLineIndex === "number")
  );
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

function isConnectionType(
  value: unknown,
): value is StreamTelemetry["connection"] {
  return value === "local" || value === "remote" || value === "unknown";
}

function isNetworkQuality(
  value: unknown,
): value is StreamTelemetry["networkQuality"] {
  return (
    value === "measuring" ||
    value === "excellent" ||
    value === "good" ||
    value === "unstable"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function optionalMeasurement(
  value: unknown,
  maximum: number,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, maximum)
    : undefined;
}
