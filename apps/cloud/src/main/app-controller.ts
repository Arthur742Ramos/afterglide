import type { BrowserWindow } from "electron";
import type {
  AppSettings,
  AppSnapshot,
  CloudTitle,
  HardwareInfo,
  IceCandidatePayload,
  StreamDescriptor,
  StreamTelemetry,
  InputPollingTelemetry,
  PowerContext,
} from "../shared/contracts";
import { emptyTelemetry, idleSession, IPC } from "../shared/contracts";
import { sanitizeSettingsUpdate } from "../shared/controller-settings";
import { NETWORK_POLICY } from "../shared/network-policy";
import { errorForLog, safeError } from "./errors";
import type {
  PlatformService,
  SessionStart,
  StreamTarget,
} from "./platform-service";
import type { ReleaseCheckPort } from "./release-checker";
import { SettingsStore } from "./settings-store";
import { PerformanceReport, type DeviceMetrics } from "./performance-report";
import {
  CloudOperation,
  CLOUD_OPERATION_LIMITS,
  operationCancelled,
} from "./operation-context";

interface ActiveSession {
  id: string;
  path: string;
  source: StreamTarget["source"];
  targetId: string;
  targetName: string;
  controller: AbortController;
}

interface NamedTarget extends StreamTarget {
  name: string;
}

export class AppController {
  private window?: BrowserWindow;
  private lastBroadcastTitles?: CloudTitle[];
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
  private retryPending?: object;
  private startingTarget?: AbortController;
  private catalogOperation?: AbortController;
  private searchOperation?: AbortController;

  constructor(
    private readonly platform: PlatformService,
    private readonly preferences: SettingsStore,
    hardware: HardwareInfo,
    private readonly version: string,
    private readonly releaseChecker?: ReleaseCheckPort,
    private readonly onSessionPhaseChanged?: (
      phase: AppSnapshot["session"]["phase"],
    ) => void,
  ) {
    this.snapshot = {
      revision: 0,
      auth: { status: "restoring" },
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
      fullscreen: false,
      version,
    };
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window;
    this.lastBroadcastTitles = undefined;
  }

  setFullscreenState(fullscreen: boolean): void {
    this.patch({ fullscreen });
  }

  updateHardware(hardware: HardwareInfo): void {
    if (JSON.stringify(hardware) !== JSON.stringify(this.snapshot.hardware))
      this.patch({ hardware });
  }

  async initialize(): Promise<void> {
    const generation = this.authGeneration;
    this.patch({ auth: { status: "restoring" } });
    const restored = await this.platform.restore();
    if (generation !== this.authGeneration) return;
    if (!restored) {
      this.patch({ auth: { status: "signed-out" } });
      return;
    }
    this.patch({ auth: { status: "signed-in" } });
    await this.refreshCloudTitles();
  }

  getSnapshot(): AppSnapshot {
    return structuredClone(this.snapshot);
  }

  getSessionPhase(): AppSnapshot["session"]["phase"] {
    return this.snapshot.session.phase;
  }

  async beginSignIn(): Promise<void> {
    this.cancelCatalogOperations();
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
          this.patch({
            auth: { status: "signed-in" },
            cloud: { available: false, titles: [], status: "idle" },
          });
          await this.refreshCloudTitles();
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
    this.cancelCatalogOperations();
    this.authGeneration += 1;
    this.platform.cancelAuthentication();
    this.patch({ auth: { status: "signed-out" } });
  }

  async signOut(): Promise<void> {
    const generation = ++this.authGeneration;
    this.cancelCatalogOperations();
    const cleanup = this.stopStream().catch((error: unknown) => {
      console.warn(
        "Could not stop the remote Xbox session",
        errorForLog(error),
      );
    });
    this.lastTarget = undefined;
    try {
      // Revoke local credentials before waiting on captured remote cleanup.
      // A newer sign-in owns the snapshot as soon as its generation changes.
      await this.platform.signOut();
      if (generation !== this.authGeneration) return;
      this.patch({
        auth: { status: "signed-out" },
        cloud: {
          available: false,
          titles: [],
          status: "idle",
        },
        session: idleSession(),
        regionSelection: undefined,
        telemetry: { ...emptyTelemetry },
      });
    } finally {
      await cleanup;
    }
  }

  private cancelCatalogOperations(): void {
    this.catalogOperation?.abort();
    this.catalogOperation = undefined;
    this.cancelCloudSearch();
    if (this.snapshot.cloud.hydrating)
      this.patch({ cloud: { ...this.snapshot.cloud, hydrating: false } });
  }

  cancelCloudSearch(): void {
    this.searchOperation?.abort();
    this.searchOperation = undefined;
  }

  async refreshCloudTitles(): Promise<void> {
    const generation = this.authGeneration;
    if (
      this.snapshot.auth.status !== "signed-in" ||
      this.snapshot.cloud.hydrating
    )
      return;
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
        status: this.snapshot.cloud.titles.length ? "ready" : "loading",
        hydrating: true,
        error: undefined,
      },
    });
    const cancellation = new AbortController();
    this.catalogOperation = cancellation;
    const operation = new CloudOperation(
      { signal: cancellation.signal },
      CLOUD_OPERATION_LIMITS.catalogMs,
    );
    try {
      const titles = await operation.wait(() =>
        this.platform.listCloudTitles((titles) => {
          if (generation !== this.authGeneration || operation.signal.aborted)
            return;
          this.patch({
            cloud: {
              available: true,
              titles: mergeCloudTitles(this.snapshot.cloud.titles, titles),
              status: "ready",
              hydrating: true,
              selectedTitleId: chooseCloudTitle(
                titles,
                this.snapshot.cloud.selectedTitleId ??
                  this.preferences.selectedTitleId,
              )?.id,
            },
          });
        }, operation),
      );
      if (generation !== this.authGeneration) return;
      const selectedTitleId = chooseCloudTitle(
        titles,
        this.snapshot.cloud.selectedTitleId ?? this.preferences.selectedTitleId,
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
      if (generation !== this.authGeneration) return;
      console.error("Cloud title discovery failed", errorForLog(error));
      this.patch({
        cloud: {
          ...this.snapshot.cloud,
          available: this.platform.cloudAvailable,
          status: safe.code === "XCLOUD_UNAVAILABLE" ? "unavailable" : "error",
          hydrating: false,
          error: safe.message,
        },
      });
    } finally {
      if (this.catalogOperation === cancellation)
        this.catalogOperation = undefined;
      operation.dispose();
    }
  }

  async searchCloudTitles(query: string): Promise<CloudTitle[]> {
    if (typeof query !== "string" || query.length > 128)
      throw new Error("Enter a search of up to 128 characters.");
    const generation = this.authGeneration;
    this.cancelCloudSearch();
    if (this.snapshot.auth.status !== "signed-in") return [];
    if (!query.trim()) return [];
    const cancellation = new AbortController();
    this.searchOperation = cancellation;
    const operation = new CloudOperation(
      { signal: cancellation.signal },
      CLOUD_OPERATION_LIMITS.searchMs,
    );
    try {
      const titles = this.platform.searchCloudTitles
        ? await operation.wait(() =>
            this.platform.searchCloudTitles!(query, operation),
          )
        : this.snapshot.cloud.titles.filter((title) =>
            `${title.name} ${title.publisher}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
          );
      if (generation !== this.authGeneration || cancellation.signal.aborted)
        return [];
      this.patch({
        cloud: {
          ...this.snapshot.cloud,
          titles: mergeCloudTitles(this.snapshot.cloud.titles, titles),
        },
      });
      return titles;
    } catch (error) {
      if (cancellation.signal.aborted || generation !== this.authGeneration)
        return [];
      throw error;
    } finally {
      if (this.searchOperation === cancellation)
        this.searchOperation = undefined;
      operation.dispose();
    }
  }

  async selectCloudTitle(titleId: string): Promise<void> {
    if (!this.snapshot.cloud.titles.some((title) => title.id === titleId))
      return;
    this.preferences.setSelectedTitle(titleId);
    this.patch({
      cloud: { ...this.snapshot.cloud, selectedTitleId: titleId },
    });
  }

  async startCloudStream(titleId: string): Promise<StreamDescriptor> {
    if (this.snapshot.auth.status !== "signed-in")
      throw new Error("Sign in before launching a cloud game.");
    if (this.activeSession || this.startingTarget)
      throw new Error(
        "Leave the current stream before launching another game.",
      );
    const title = this.snapshot.cloud.titles.find(
      (candidate) => candidate.id === titleId,
    );
    if (!title) throw new Error("Choose a cloud game before starting.");
    this.preferences.setSelectedTitle(titleId);
    this.patch({
      cloud: { ...this.snapshot.cloud, selectedTitleId: titleId },
      telemetry: { ...emptyTelemetry },
    });
    return this.startTarget({ source: "cloud", id: titleId, name: title.name });
  }

  private async startTarget(target: NamedTarget): Promise<StreamDescriptor> {
    if (this.activeSession)
      throw new Error(
        "Leave the current stream before launching another game.",
      );
    if (this.startingTarget)
      throw new Error(
        "The previous connection is still finishing. Try again shortly.",
      );
    const cancellation = new AbortController();
    this.startingTarget = cancellation;
    const generation = ++this.connectionGeneration;
    const operation = new CloudOperation(
      { signal: cancellation.signal },
      CLOUD_OPERATION_LIMITS.provisioningMs,
    );
    this.lastTarget = { source: target.source, id: target.id };
    if (this.recoveryStartedAt === undefined) {
      this.performanceReport.reset(target.source);
      this.recoveryMs = undefined;
    }
    this.deviceMetrics = undefined;
    this.patch({ regionSelection: undefined });
    let receivedCreation: SessionStart | undefined;
    let creationCleanupStarted = false;
    const cleanupCreation = () => {
      if (!receivedCreation || creationCleanupStarted) return;
      creationCleanupStarted = true;
      const late = receivedCreation;
      void this.platform
        .stopSession(late.sessionPath, late.sessionId)
        .catch((error: unknown) => {
          console.warn(
            "Could not stop the remote Xbox session",
            errorForLog(error),
          );
        });
    };

    try {
      this.setSession(
        "provisioning",
        "Launching from the cloud",
        "Comparing region latency, then asking Xbox to find capacity for your game.",
        34,
        target,
      );
      const creation = this.platform.startSession(
        target,
        this.snapshot.settings.resolution,
        { signal: cancellation.signal, deadline: operation.deadline },
      );
      // An adapter may ignore cancellation and return a created session late.
      // Cleanup uses both path and ID so it cannot stop a newer reused path.
      void creation
        .then((late) => {
          receivedCreation = late;
          if (
            generation !== this.connectionGeneration ||
            cancellation.signal.aborted ||
            Date.now() >= operation.deadline
          )
            cleanupCreation();
        })
        .catch(() => {});
      const started = await operation.wait(() => creation);
      this.assertCurrent(generation);
      this.patch({ regionSelection: started.regionSelection });
      if (started.regionSelection)
        this.performanceReport.recordRegionSelection(started.regionSelection);
      this.activeSession = {
        id: started.sessionId,
        path: started.sessionPath,
        source: target.source,
        targetId: target.id,
        targetName: target.name,
        controller: cancellation,
      };
      // From here, stopActiveSession owns cleanup of the adopted session.
      receivedCreation = undefined;

      let authorized = false;
      while (true) {
        operation.check();
        this.assertCurrent(generation);
        const state = await operation.wait(() =>
          this.platform.getSessionState(started.sessionPath, operation),
        );
        this.assertCurrent(generation);

        if (state.state === "Provisioned") {
          this.setSession(
            "negotiating",
            "Starting video",
            "Connecting this device to the Xbox cloud stream.",
            78,
            target,
            started.sessionId,
          );
          return {
            sessionId: started.sessionId,
            source: target.source,
            targetId: target.id,
            displayName: target.name,
            titleId: target.id,
            mock: this.platform.mock,
          };
        }
        if (state.state === "ReadyToConnect" && !authorized) {
          authorized = true;
          this.setSession(
            "authorizing",
            "Securing the connection",
            "Confirming this cloud session with Xbox.",
            58,
            target,
            started.sessionId,
          );
          await operation.wait(() =>
            this.platform.authorizeSession(started.sessionPath, operation),
          );
        } else if (state.state === "Failed") {
          throw new Error(
            state.errorDetails?.message ??
              "Xbox could not provision the streaming session.",
          );
        } else {
          this.setSession(
            "provisioning",
            "Launching from the cloud",
            "Xbox Cloud Gaming is finding capacity for your game.",
            42,
            target,
            started.sessionId,
          );
        }
        await operation.delay(this.platform.mock ? 40 : 750);
      }
    } catch (error) {
      cleanupCreation();
      if (generation !== this.connectionGeneration) throw operationCancelled();
      const safe = safeError(error);
      cancellation.abort();
      console.error("Stream start failed", errorForLog(error));
      void this.stopActiveSession().catch((cleanupError: unknown) => {
        console.warn(
          "Could not stop the remote Xbox session",
          errorForLog(cleanupError),
        );
      });
      this.failSession(safe.code, safe.message, safe.recoverable, target);
      throw safe;
    } finally {
      if (this.startingTarget === cancellation) this.startingTarget = undefined;
      operation.dispose();
    }
  }

  async retryStream(): Promise<StreamDescriptor> {
    const target = this.lastTarget;
    if (!target) throw new Error("Choose something to play before retrying.");
    if (this.retryPending)
      throw new Error("A reconnection is already running.");
    const retry = {};
    this.retryPending = retry;
    const generation = ++this.connectionGeneration;
    try {
      await this.stopActiveSession();
      this.assertCurrent(generation);
      return await this.startCloudStream(target.id);
    } finally {
      if (this.retryPending === retry) this.retryPending = undefined;
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
    this.startingTarget?.abort();
    this.startingTarget = undefined;
    this.retryPending = undefined;
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

  updatePowerContext(context: PowerContext): void {
    this.patch({ powerContext: { ...context } });
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
      framesPerSecond: optionalMeasurement(telemetry.framesPerSecond, 240),
      incomingFramesPerSecond: optionalMeasurement(
        telemetry.incomingFramesPerSecond,
        240,
      ),
      decodedFramesPerSecond: optionalMeasurement(
        telemetry.decodedFramesPerSecond,
        240,
      ),
      displayedFramesPerSecond: optionalMeasurement(
        telemetry.displayedFramesPerSecond,
        240,
      ),
      displayedFpsSource:
        telemetry.displayedFpsSource === "webrtc" ||
        telemetry.displayedFpsSource === "video-callback"
          ? telemetry.displayedFpsSource
          : undefined,
      presentationCallbacksSkipped: optionalMeasurement(
        telemetry.presentationCallbacksSkipped,
        Number.MAX_SAFE_INTEGER,
      ),
      presentationIntervalSamples: optionalMeasurement(
        telemetry.presentationIntervalSamples,
        600,
      ),
      playbackVisible:
        typeof telemetry.playbackVisible === "boolean"
          ? telemetry.playbackVisible
          : undefined,
      playbackFocused:
        typeof telemetry.playbackFocused === "boolean"
          ? telemetry.playbackFocused
          : undefined,
      roundTripMs: optionalMeasurement(telemetry.roundTripMs, 10_000),
      packetLossPercent: optionalMeasurement(telemetry.packetLossPercent, 100),
      bitrateMbps: optionalMeasurement(telemetry.bitrateMbps, 500),
      codec:
        typeof telemetry.codec === "string" && telemetry.codec.trim()
          ? telemetry.codec.slice(0, 48)
          : undefined,
      connection: isConnectionType(telemetry.connection)
        ? telemetry.connection
        : "unknown",
      videoDecoder:
        typeof telemetry.videoDecoder === "string" &&
        telemetry.videoDecoder.trim()
          ? telemetry.videoDecoder.slice(0, 80)
          : undefined,
      powerEfficientDecoder:
        typeof telemetry.powerEfficientDecoder === "boolean"
          ? telemetry.powerEfficientDecoder
          : undefined,
      inputPolling: sanitizeInputPolling(telemetry.inputPolling),
      powerContext: this.snapshot.powerContext,
      decodeMs: optionalMeasurement(telemetry.decodeMs, 10_000),
      jitterBufferMs: optionalMeasurement(telemetry.jitterBufferMs, 10_000),
      retransmittedPacketsReceived: optionalMeasurement(
        telemetry.retransmittedPacketsReceived,
        Number.MAX_SAFE_INTEGER,
      ),
      retransmittedBytesReceived: optionalMeasurement(
        telemetry.retransmittedBytesReceived,
        Number.MAX_SAFE_INTEGER,
      ),
      nackCount: optionalMeasurement(
        telemetry.nackCount,
        Number.MAX_SAFE_INTEGER,
      ),
      pliCount: optionalMeasurement(
        telemetry.pliCount,
        Number.MAX_SAFE_INTEGER,
      ),
      firCount: optionalMeasurement(
        telemetry.firCount,
        Number.MAX_SAFE_INTEGER,
      ),
      receiverFramesDropped: optionalMeasurement(
        telemetry.receiverFramesDropped,
        Number.MAX_SAFE_INTEGER,
      ),
      retransmittedPacketsPerSecond: optionalMeasurement(
        telemetry.retransmittedPacketsPerSecond,
        Number.MAX_SAFE_INTEGER,
      ),
      jitterBufferTargetMs: optionalMeasurement(
        telemetry.jitterBufferTargetMs,
        Number.MAX_SAFE_INTEGER,
      ),
      jitterBufferMinimumMs: optionalMeasurement(
        telemetry.jitterBufferMinimumMs,
        Number.MAX_SAFE_INTEGER,
      ),
      playoutTargetMs: optionalMeasurement(telemetry.playoutTargetMs, 4_000),
      playoutTargetAccepted:
        typeof telemetry.playoutTargetAccepted === "boolean"
          ? telemetry.playoutTargetAccepted
          : undefined,
      jitterMs: optionalMeasurement(telemetry.jitterMs, 10_000),
      playoutMode:
        telemetry.playoutMode === "automatic" ||
        telemetry.playoutMode === "low-delay" ||
        telemetry.playoutMode === "smooth"
          ? telemetry.playoutMode
          : undefined,
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
      networkQuality:
        optionalMeasurement(telemetry.roundTripMs, 10_000) !== undefined &&
        optionalMeasurement(telemetry.packetLossPercent, 100) !== undefined &&
        optionalMeasurement(telemetry.framesPerSecond, 240) !== undefined &&
        optionalMeasurement(telemetry.bitrateMbps, 500) !== undefined &&
        isNetworkQuality(telemetry.networkQuality)
          ? telemetry.networkQuality
          : "measuring",
      updatedAt: Date.now(),
    };
    // Telemetry is a one-way high-frequency path. Keep it for reports and later
    // snapshots without cloning and rebroadcasting the full application state.
    this.snapshot = {
      ...this.snapshot,
      telemetry: sanitized,
      revision: this.snapshot.revision + 1,
    };
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
      this.patch({ update: { status: "idle", checkedAt: Date.now() } });
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
    session?.controller.abort();
    if (session) await this.platform.stopSession(session.path, session.id);
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
        titleId: target?.id,
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
            : "Couldn't start cloud play",
        detail: message,
        progress: 0,
        errorCode: code,
        recoverable,
        source: target?.source,
        targetName: target?.name,
        titleId: target?.id,
      },
    });
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.connectionGeneration)
      throw new Error("Connection cancelled.");
  }

  private patch(update: Partial<AppSnapshot>): void {
    const previousPhase = this.snapshot.session.phase;
    this.snapshot = {
      ...this.snapshot,
      ...update,
      revision: this.snapshot.revision + 1,
    };
    if (this.snapshot.session.phase !== previousPhase)
      this.onSessionPhaseChanged?.(this.snapshot.session.phase);
    if (!this.window || this.window.isDestroyed()) return;
    const { cloud, ...state } = this.snapshot;
    const { titles, ...metadata } = cloud;
    // Electron serializes the payload: no extra deep clone before IPC is needed.
    this.window.webContents.send(IPC.snapshot, {
      ...state,
      cloud: titles === this.lastBroadcastTitles ? metadata : cloud,
    });
    this.lastBroadcastTitles = titles;
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

function optionalMeasurement(
  value: unknown,
  maximum: number,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, maximum)
    : undefined;
}

function sanitizeInputPolling(
  value: InputPollingTelemetry | undefined,
): InputPollingTelemetry | undefined {
  if (!value || (value.targetMs !== 4 && value.targetMs !== 8))
    return undefined;
  const result: InputPollingTelemetry = {
    targetMs: value.targetMs,
  } as InputPollingTelemetry;
  for (const key of [
    "samples",
    "windowMs",
    "meanIntervalMs",
    "p95UpperMs",
    "maxIntervalMs",
    "meanJitterMs",
    "longGaps",
  ] as const) {
    const number = value[key];
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      number < 0 ||
      number > Number.MAX_SAFE_INTEGER
    )
      return undefined;
    result[key] = number;
  }
  if (
    !Number.isSafeInteger(result.samples) ||
    result.samples < 1 ||
    !Number.isSafeInteger(result.longGaps) ||
    result.longGaps > result.samples ||
    result.windowMs <= 0 ||
    result.meanIntervalMs <= 0
  )
    return undefined;
  return result;
}

function mergeCloudTitles(
  previous: CloudTitle[],
  incoming: CloudTitle[],
): CloudTitle[] {
  return [
    ...new Map(
      [...previous, ...incoming].map((title) => [title.id, title]),
    ).values(),
  ].sort((a, b) =>
    a.recentlyPlayed === b.recentlyPlayed
      ? a.name.localeCompare(b.name)
      : a.recentlyPlayed
        ? -1
        : 1,
  );
}
