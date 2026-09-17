import {
  intervalMeanMs,
  selectedCandidatePair,
  requestInteractivePlayout,
  type MediaCounters,
} from "./media-metrics";
import type {
  AppSettings,
  IceCandidatePayload,
  StreamTelemetry,
} from "../../shared/contracts";
import {
  assessNetworkQuality,
  NETWORK_POLICY,
} from "../../shared/network-policy";
import {
  applyKeyboardInput,
  emptyXboxInputFrame,
  isKeyboardControlCode,
  resetXboxInputFrame,
  type XboxButtonName as ButtonName,
  type XboxInputFrame as InputFrame,
} from "./input-schema";
import {
  controllerInputFrame,
  friendlyControllerName,
  selectController,
  tuningForGamepad,
  type GamepadLike,
} from "./controller-input";
import { InputTransitionBuffer, type InputBufferFailure } from "./input-buffer";
import { FrameMetricsTracker } from "./frame-metrics";

export type PlaybackSettings = Pick<
  AppSettings,
  "volume" | "muted" | "videoFit" | "inputPolling"
>;

const defaultPlaybackSettings: PlaybackSettings = {
  volume: 1,
  muted: false,
  videoFit: "fit",
  inputPolling: "responsive",
};

export interface ControllerStatus {
  state: "connected" | "switched" | "disconnected";
  label: string;
}

interface StreamEngineOptions {
  sessionId: string;
  container: HTMLElement;
  keyboardControls: boolean;
  reserveControlChord: boolean;
  playbackSettings?: PlaybackSettings;
  controllerSettings: Pick<
    AppSettings,
    "preferredControllerId" | "controllerDefaults" | "controllerProfiles"
  >;
  onConnected: () => void;
  onInterrupted: () => void;
  onError: (message: string) => void;
  onTelemetry: (telemetry: StreamTelemetry) => void;
  onControllerStatus: (status: ControllerStatus) => void;
  onControlsShortcut: () => void;
}

/**
 * Browser WebRTC transport for Xbox streaming. The protocol shape is
 * derived from Greenlight's MIT-licensed player and kept deliberately small:
 * Chromium owns media decode while Afterglide owns negotiation and input.
 */
export class XboxStreamEngine {
  private readonly peer = new RTCPeerConnection({});
  private readonly channels: Record<
    "chat" | "control" | "input" | "message",
    RTCDataChannel
  >;
  private readonly video: HTMLVideoElement;
  private readonly audio: HTMLAudioElement;
  private readonly frameMetrics: FrameMetricsTracker;
  private readonly inputBuffer = new InputTransitionBuffer();
  private readonly sampledFrame = emptyXboxInputFrame();
  private playbackSettings?: PlaybackSettings;
  private readonly localCandidates: IceCandidatePayload[] = [];
  private readonly localCandidateKeys = new Set<string>();
  private readonly pressedKeys = new Set<string>();
  private destroyed = false;
  private terminal = false;
  private connected = false;
  private inputActive = false;
  private inputSuspended = false;
  private sequence = 0;
  private lastInputAt = 0;
  private inputTimer = 0;
  private neutralPending = false;
  private handshakeAcknowledged = false;
  private telemetryTimer = 0;
  private keepaliveTimer = 0;
  private connectionDeadlineTimer = 0;
  private disconnectedTimer = 0;
  private keepaliveFailures = 0;
  private previousVideo?: MediaCounters;
  private telemetryCollecting = false;
  private previousBytes = 0;
  private previousPacketsReceived = 0;
  private previousPacketsLost = 0;
  private previousStatsAt = 0;
  private activeGamepadIndex?: number;
  private activeGamepadId = "";
  private activeGamepadLabel = "";
  private sampledInput = false;
  private controlsShortcutPressed = false;

  constructor(private readonly options: StreamEngineOptions) {
    this.channels = {
      chat: this.peer.createDataChannel("chat", {
        ordered: true,
        protocol: "chatV1",
      }),
      control: this.peer.createDataChannel("control", {
        ordered: true,
        protocol: "controlV1",
      }),
      input: this.peer.createDataChannel("input", {
        ordered: true,
        protocol: "1.0",
      }),
      message: this.peer.createDataChannel("message", {
        ordered: true,
        protocol: "messageV1",
      }),
    };
    this.channels.input.binaryType = "arraybuffer";
    for (const channel of [this.channels.control, this.channels.input]) {
      channel.addEventListener("open", () => this.activateInput());
    }
    this.channels.input.bufferedAmountLowThreshold = 0;
    this.channels.input.addEventListener("bufferedamountlow", () =>
      this.inputLoop(),
    );
    this.channels.input.addEventListener("message", (event) =>
      this.handleInputMessage(event),
    );
    this.channels.message.addEventListener("open", () =>
      this.sendMessageHandshake(),
    );
    this.channels.message.addEventListener("message", (event) =>
      this.handleMessage(event),
    );

    this.video = document.createElement("video");
    this.video.className = "stream-video";
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute("aria-label", "Xbox remote-play video");
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.setAttribute("aria-hidden", "true");
    options.container.replaceChildren(this.video, this.audio);
    this.setPlaybackSettings(
      options.playbackSettings ?? defaultPlaybackSettings,
    );
    this.frameMetrics = new FrameMetricsTracker(this.video);
    this.frameMetrics.start(document.visibilityState === "visible");

    this.peer.addTransceiver("audio", { direction: "sendrecv" });
    const videoTransceiver = this.peer.addTransceiver("video", {
      direction: "recvonly",
    });
    const codecs = preferredVideoCodecs();
    if (codecs.length > 0) videoTransceiver.setCodecPreferences(codecs);

    this.peer.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      const candidate = candidatePayload(event.candidate);
      if (
        this.localCandidates.length >= NETWORK_POLICY.maxIceCandidates ||
        this.localCandidateKeys.has(candidate.candidate)
      )
        return;
      this.localCandidateKeys.add(candidate.candidate);
      this.localCandidates.push(candidate);
    });
    this.peer.addEventListener("track", (event) => this.attachTrack(event));
    this.peer.addEventListener("connectionstatechange", () =>
      this.handleConnectionState(),
    );
    this.video.addEventListener("playing", () => this.markConnected(), {
      once: true,
    });

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("focus", this.updateInputPolling);
    window.addEventListener("gamepadconnected", this.onGamepadChange);
    window.addEventListener("gamepaddisconnected", this.onGamepadChange);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  async connect(): Promise<void> {
    try {
      this.connectionDeadlineTimer = window.setTimeout(() => {
        if (!this.connected && !this.destroyed) {
          this.notifyError(
            "The video connection timed out. Check your network and try again.",
          );
        }
      }, NETWORK_POLICY.connectionDeadlineMs);
      const offer = await this.peer.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      if (this.destroyed || this.terminal) return;
      if (offer.sdp)
        offer.sdp = offer.sdp.replace(
          "useinbandfec=1",
          "useinbandfec=1; stereo=1",
        );
      await this.peer.setLocalDescription(offer);
      if (this.destroyed || this.terminal) return;

      const answer = await window.afterglide.sendSdp(
        this.options.sessionId,
        offer,
      );
      if (this.destroyed || this.terminal) return;
      await this.peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      if (this.destroyed || this.terminal) return;

      await waitForIceGathering(
        this.peer,
        NETWORK_POLICY.iceGatheringTimeoutMs,
      );

      if (this.destroyed || this.terminal) return;
      const remoteCandidates = await window.afterglide.sendIce(
        this.options.sessionId,
        this.localCandidates,
      );
      if (this.destroyed || this.terminal) return;
      await Promise.all(
        remoteCandidates
          .flatMap(withTeredoFallback)
          .map((candidate) => this.addIceCandidate(candidate)),
      );

      if (this.destroyed || this.terminal) return;
      this.keepaliveTimer = window.setInterval(() => {
        void window.afterglide
          .keepalive(this.options.sessionId)
          .then(() => {
            this.keepaliveFailures = 0;
          })
          .catch(() => {
            this.keepaliveFailures += 1;
            if (
              this.keepaliveFailures >= NETWORK_POLICY.keepaliveFailureThreshold
            )
              this.notifyInterrupted();
          });
      }, NETWORK_POLICY.keepaliveIntervalMs);
      this.telemetryTimer = window.setInterval(
        () => void this.collectTelemetry(),
        NETWORK_POLICY.telemetryIntervalMs,
      );
      this.updateInputPolling();
    } catch (error) {
      if (this.destroyed) return;
      this.notifyError(streamErrorMessage(error));
    }
  }

  setInputSuspended(suspended: boolean): void {
    if (suspended === this.inputSuspended) return;
    this.inputSuspended = suspended;
    if (suspended) this.releaseInput();
    this.updateInputPolling();
  }

  setPlaybackSettings(settings: PlaybackSettings): void {
    if (
      this.playbackSettings?.volume === settings.volume &&
      this.playbackSettings.muted === settings.muted &&
      this.playbackSettings.videoFit === settings.videoFit &&
      this.playbackSettings.inputPolling === settings.inputPolling
    )
      return;
    const pollingChanged =
      this.playbackSettings?.inputPolling !== settings.inputPolling;
    this.playbackSettings = { ...settings };
    this.audio.volume = settings.volume;
    this.audio.muted = settings.muted;
    this.video.style.objectFit =
      settings.videoFit === "fill" ? "cover" : "contain";
    if (pollingChanged) this.updateInputPolling();
  }

  setControllerSettings(
    settings: StreamEngineOptions["controllerSettings"],
  ): void {
    const relevant = (value: StreamEngineOptions["controllerSettings"]) =>
      JSON.stringify([
        value.preferredControllerId,
        value.controllerDefaults,
        value.controllerProfiles,
      ]);
    if (relevant(settings) === relevant(this.options.controllerSettings))
      return;
    this.options.controllerSettings = settings;
    // A live mapping/profile change must not leave old logical buttons held.
    this.releaseInput();
  }

  private updateInputPolling = (): void => {
    clearInterval(this.inputTimer);
    this.inputTimer = 0;
    if (this.destroyed || (!this.inputActive && !this.neutralPending)) return;
    if (this.terminal && !this.neutralPending) return;
    const active =
      !this.terminal &&
      !this.inputSuspended &&
      document.hasFocus() &&
      document.visibilityState === "visible";
    // Paused/hidden streams only retry neutral. Wake promptly on focus/visibility.
    if (!active && !this.neutralPending) return;
    const idle =
      this.sampledInput &&
      this.activeGamepadIndex === undefined &&
      this.pressedKeys.size === 0;
    this.inputTimer = window.setInterval(
      this.inputLoop,
      active && !idle
        ? this.playbackSettings?.inputPolling === "efficient"
          ? 8
          : 4
        : 50,
    );
  };

  private onBlur = (): void => {
    this.releaseInput();
    this.updateInputPolling();
  };

  private onGamepadChange = (): void => {
    this.sampledInput = false;
    this.updateInputPolling();
    this.inputLoop();
  };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.inputTimer);
    clearInterval(this.telemetryTimer);
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.connectionDeadlineTimer);
    clearTimeout(this.disconnectedTimer);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("focus", this.updateInputPolling);
    window.removeEventListener("gamepadconnected", this.onGamepadChange);
    window.removeEventListener("gamepaddisconnected", this.onGamepadChange);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.releaseInput();
    this.inputBuffer.clear();
    this.neutralPending = false;
    this.frameMetrics.stop();
    Object.values(this.channels).forEach((channel) => channel.close());
    this.peer.getReceivers().forEach((receiver) => receiver.track?.stop());
    this.peer.close();
    this.video.srcObject = null;
    this.audio.srcObject = null;
    this.options.container.replaceChildren();
  }

  private attachTrack(event: RTCTrackEvent): void {
    requestInteractivePlayout(event.receiver);
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    if (event.track.kind === "video") this.video.srcObject = stream;
    if (event.track.kind === "audio") this.audio.srcObject = stream;
  }

  private handleConnectionState(): void {
    if (this.destroyed) return;
    if (this.peer.connectionState === "connected") {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = 0;
      // Transport connectivity alone does not prove video is decoding.
      // Keep the startup deadline until the video element actually plays.
      return;
    }
    if (this.connected && this.peer.connectionState === "disconnected") {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = window.setTimeout(() => {
        if (!this.destroyed && this.peer.connectionState === "disconnected")
          this.notifyInterrupted();
      }, NETWORK_POLICY.disconnectedGraceMs);
    }
    if (this.connected && this.peer.connectionState === "failed")
      this.notifyInterrupted();
    if (!this.connected && this.peer.connectionState === "failed")
      this.notifyError("A usable route to the Xbox was not found.");
  }

  private markConnected(): void {
    if (this.connected || this.destroyed || this.terminal) return;
    this.connected = true;
    clearTimeout(this.connectionDeadlineTimer);
    this.options.onConnected();
  }

  private sendMessageHandshake(): void {
    this.send(this.channels.message, {
      type: "Handshake",
      version: "messageV1",
      id: "be0bfc6d-1e83-4c8a-90ed-fa8601c5a179",
      cv: "0",
    });
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(String(event.data)) as {
        type?: string;
        target?: string;
        id?: string;
        content?: string;
      };
      if (data.type === "HandshakeAck") {
        this.handshakeAcknowledged = true;
        this.activateInput();
        this.sendClientConfiguration();
      } else if (
        data.target ===
        "/streaming/sessionLifetimeManagement/serverInitiatedDisconnect"
      ) {
        this.send(this.channels.message, {
          type: "TransactionComplete",
          content: '""',
          id: data.id,
          cv: "",
        });
        this.notifyInterrupted();
      } else if (data.type === "TransactionStart" && data.id) {
        this.send(this.channels.message, {
          type: "TransactionComplete",
          content: JSON.stringify({ Result: 1 }),
          id: data.id,
          cv: "",
        });
      }
    } catch {
      // Ignore messages from newer server capabilities that this client does not advertise.
    }
  }

  private activateInput(): void {
    if (
      this.destroyed ||
      this.terminal ||
      this.inputActive ||
      !this.handshakeAcknowledged ||
      this.channels.control.readyState !== "open" ||
      this.channels.input.readyState !== "open"
    )
      return;
    this.authorizeControl();
    this.startInput();
  }

  private authorizeControl(): void {
    this.send(this.channels.control, {
      message: "authorizationRequest",
      accessKey: "4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E",
    });
    this.send(this.channels.control, {
      message: "gamepadChanged",
      gamepadIndex: 0,
      wasAdded: true,
    });
  }

  private startInput(): void {
    const bytes = new Uint8Array(15);
    const packet = new DataView(bytes.buffer);
    packet.setUint16(0, 8, true);
    packet.setUint32(2, this.nextSequence(), true);
    packet.setFloat64(6, performance.now(), true);
    packet.setUint8(14, Math.max(1, navigator.maxTouchPoints));
    this.channels.input.send(packet);
    this.inputActive = true;
    this.updateInputPolling();
  }

  private sendClientConfiguration(): void {
    const message = (target: string, content: unknown) => ({
      type: "Message",
      content: JSON.stringify(content),
      id: crypto.randomUUID(),
      target,
      cv: "",
    });
    this.send(
      this.channels.message,
      message("/streaming/systemUi/configuration", {
        version: [0, 2, 0],
        systemUis: [],
      }),
    );
    this.send(
      this.channels.message,
      message("/streaming/properties/clientappinstallidchanged", {
        clientAppInstallId: crypto.randomUUID(),
      }),
    );
    this.send(
      this.channels.message,
      message("/streaming/characteristics/orientationchanged", {
        orientation: 0,
      }),
    );
    this.send(
      this.channels.message,
      message("/streaming/characteristics/touchinputenabledchanged", {
        touchInputEnabled: false,
      }),
    );
    this.send(
      this.channels.message,
      message("/streaming/characteristics/clientdevicecapabilities", {}),
    );
    this.send(
      this.channels.message,
      message("/streaming/characteristics/dimensionschanged", {
        horizontal: 1920,
        vertical: 1080,
        preferredWidth: 1920,
        preferredHeight: 1080,
        safeAreaLeft: 0,
        safeAreaTop: 0,
        safeAreaRight: 1920,
        safeAreaBottom: 1080,
        supportsCustomResolution: true,
      }),
    );
  }

  private inputLoop = (): void => {
    if (this.destroyed) return;
    if (this.neutralPending && this.inputActive) {
      if (!this.sendInputFrame(emptyXboxInputFrame())) return;
      this.neutralPending = false;
      this.updateInputPolling();
    }
    if (this.terminal) return;
    if (
      this.inputActive &&
      !this.inputSuspended &&
      document.hasFocus() &&
      document.visibilityState === "visible"
    ) {
      this.sendCurrentInput(
        performance.now() - this.lastInputAt >= NETWORK_POLICY.inputHeartbeatMs,
      );
    }
  };

  private sendCurrentInput(heartbeatDue = false): void {
    if (
      !this.inputActive ||
      this.inputSuspended ||
      this.terminal ||
      this.destroyed ||
      this.neutralPending ||
      !document.hasFocus() ||
      document.visibilityState !== "visible"
    )
      return;
    const gamepad = this.resolveGamepad();
    this.updateControlsShortcut(gamepad);
    if (!this.sampledInput) {
      this.sampledInput = true;
      this.updateInputPolling();
    }
    if (this.neutralPending) return;
    const frame =
      readInputFrame(
        gamepad,
        this.pressedKeys,
        gamepad
          ? tuningForGamepad(this.options.controllerSettings, gamepad)
          : undefined,
        this.options.reserveControlChord,
        this.sampledFrame,
      ) ?? resetXboxInputFrame(this.sampledFrame);
    const now = performance.now();
    const failure =
      this.inputBuffer.observe(frame, now) ??
      this.inputBuffer.flush(
        now,
        (next) => {
          if (!this.sendInputFrame(next)) return false;
          this.lastInputAt = now;
          return true;
        },
        heartbeatDue,
      );
    if (failure) this.failInputBuffer(failure);
  }

  private failInputBuffer(reason: InputBufferFailure): void {
    this.notifyError(
      reason === "overflow"
        ? "Controller input congestion exceeded 32 queued button/trigger transitions. The stream stopped to avoid losing controls; reconnect to continue."
        : "Controller input was delayed over 250 ms. The stream stopped rather than replaying stale controls; reconnect to continue.",
    );
  }

  private sendInputFrame(frame: InputFrame): boolean {
    // The bounded digital buffer sits above SCTP; never add historical analog
    // positions to the browser's reliable, ordered transport queue.
    if (
      this.channels.input.readyState !== "open" ||
      this.channels.input.bufferedAmount > 0
    )
      return false;
    const bytes = new Uint8Array(38);
    const packet = new DataView(bytes.buffer);
    packet.setUint16(0, 2, true);
    packet.setUint32(2, this.nextSequence(), true);
    packet.setFloat64(6, performance.now(), true);
    packet.setUint8(14, 1);
    writeGamepad(packet, 15, frame);
    try {
      this.channels.input.send(packet);
      return true;
    } catch {
      return false;
    }
  }

  private releaseInput = (): void => {
    this.pressedKeys.clear();
    this.inputBuffer.clear();
    if (this.inputActive)
      this.neutralPending = !this.sendInputFrame(emptyXboxInputFrame());
    this.updateInputPolling();
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") this.releaseInput();
    this.frameMetrics.setVisible(document.visibilityState === "visible");
    this.updateInputPolling();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (
      !this.options.keyboardControls ||
      this.inputSuspended ||
      !isKeyboardControlCode(event.code) ||
      !document.hasFocus()
    )
      return;
    if (event.repeat) {
      event.preventDefault();
      return;
    }
    this.pressedKeys.add(event.code);
    this.updateInputPolling();
    this.sendCurrentInput();
    event.preventDefault();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (!this.options.keyboardControls || !isKeyboardControlCode(event.code))
      return;
    this.pressedKeys.delete(event.code);
    this.updateInputPolling();
    if (this.inputSuspended) return;
    this.sendCurrentInput();
    event.preventDefault();
  };

  private handleInputMessage(event: MessageEvent): void {
    if (
      this.destroyed ||
      this.terminal ||
      this.inputSuspended ||
      !document.hasFocus()
    )
      return;
    if (!(event.data instanceof ArrayBuffer)) return;
    const report = new DataView(event.data);
    if (report.byteLength < 13 || report.getUint8(0) !== 128) return;
    const gamepad = this.resolveGamepad();
    const tuning = gamepad
      ? tuningForGamepad(this.options.controllerSettings, gamepad)
      : undefined;
    if (!gamepad || !tuning || tuning.rumble === "off") return;
    const actuator = gamepad?.vibrationActuator;
    if (!actuator || !("playEffect" in actuator)) return;
    const intensity = tuning.rumble === "low" ? 0.45 : 1;
    void actuator
      .playEffect("dual-rumble", {
        startDelay: report.getUint16(10, true),
        duration: report.getUint16(8, true),
        weakMagnitude: (report.getUint8(5) / 100) * intensity,
        strongMagnitude: (report.getUint8(4) / 100) * intensity,
      })
      .catch(() => {
        /* Devices may disconnect during vibration. */
      });
  }

  private resolveGamepad(): GamepadLike | undefined {
    const previousIndex = this.activeGamepadIndex;
    const previousLabel = this.activeGamepadLabel;
    const gamepad = selectController(
      navigator.getGamepads(),
      this.options.controllerSettings.preferredControllerId,
      previousIndex,
    );
    if (
      gamepad?.index === previousIndex &&
      (gamepad?.id ?? "") === this.activeGamepadId
    )
      return gamepad;
    if (previousIndex !== undefined && this.inputActive) {
      this.releaseInput();
    }
    this.activeGamepadIndex = gamepad?.index;
    this.activeGamepadId = gamepad?.id ?? "";
    this.activeGamepadLabel = gamepad ? friendlyControllerName(gamepad.id) : "";
    this.updateInputPolling();
    if (gamepad) {
      this.options.onControllerStatus({
        state: previousIndex === undefined ? "connected" : "switched",
        label: this.activeGamepadLabel,
      });
    } else if (previousIndex !== undefined) {
      this.options.onControllerStatus({
        state: "disconnected",
        label: previousLabel || "Controller",
      });
    }
    return gamepad;
  }

  private updateControlsShortcut(gamepad: GamepadLike | undefined): void {
    const pressed =
      this.options.reserveControlChord &&
      Boolean(gamepad?.buttons[10]?.pressed && gamepad.buttons[11]?.pressed);
    if (pressed && !this.controlsShortcutPressed)
      this.options.onControlsShortcut();
    this.controlsShortcutPressed = pressed;
  }

  private async collectTelemetry(): Promise<void> {
    if (this.destroyed || this.terminal || this.telemetryCollecting) return;
    this.telemetryCollecting = true;
    try {
      const reports = await this.peer.getStats();
      if (this.destroyed || this.terminal) return;
      let resolution = "Waiting for video";
      let fps = 0;
      let rtt = 0;
      let packetLoss = 0;
      let codec = "H.264";
      let bytes = 0;
      let packetsReceived = 0;
      let packetsLost = 0;
      let remoteCandidateId = "";
      let videoReport: MediaCounters | undefined;
      let connection: StreamTelemetry["connection"] = "unknown";
      const records = new Map<string, Record<string, unknown>>();
      reports.forEach((report) =>
        records.set(report.id, report as unknown as Record<string, unknown>),
      );
      reports.forEach((report) => {
        const record = report as unknown as Record<string, unknown>;
        if (
          record.type === "inbound-rtp" &&
          (record.kind === "video" || record.mediaType === "video")
        ) {
          videoReport = record;
          const width = Number(record.frameWidth ?? 0);
          const height = Number(record.frameHeight ?? 0);
          if (width && height) resolution = `${width} × ${height}`;
          fps = Number(record.framesPerSecond ?? 0);
          bytes = Number(record.bytesReceived ?? 0);
          packetsReceived = Number(record.packetsReceived ?? 0);
          packetsLost = Number(record.packetsLost ?? 0);
          const codecReport = records.get(String(record.codecId ?? ""));
          if (codecReport?.mimeType)
            codec = String(codecReport.mimeType).replace("video/", "");
        }
      });
      const pair = selectedCandidatePair(records);
      if (pair) {
        rtt = Number(pair.currentRoundTripTime ?? 0) * 1000;
        remoteCandidateId = String(pair.remoteCandidateId ?? "");
      }
      const remote = records.get(remoteCandidateId);
      if (remote?.address)
        connection = isPrivateAddress(String(remote.address))
          ? "local"
          : "remote";
      const now = performance.now();
      const seconds = this.previousStatsAt
        ? (now - this.previousStatsAt) / 1_000
        : 0;
      const bitrate =
        seconds > 0
          ? ((bytes - this.previousBytes) * 8) / seconds / 1_000_000
          : 0;
      const receivedDelta = Math.max(
        0,
        packetsReceived - this.previousPacketsReceived,
      );
      const lostDelta = Math.max(0, packetsLost - this.previousPacketsLost);
      packetLoss =
        receivedDelta + lostDelta > 0
          ? (lostDelta / (receivedDelta + lostDelta)) * 100
          : 0;
      this.previousBytes = bytes;
      this.previousPacketsReceived = packetsReceived;
      this.previousPacketsLost = packetsLost;
      this.previousStatsAt = now;
      this.options.onTelemetry({
        resolution,
        framesPerSecond: fps,
        roundTripMs: rtt,
        packetLossPercent: packetLoss,
        bitrateMbps: Math.max(0, bitrate),
        codec,
        connection,
        videoDecoder:
          typeof videoReport?.decoderImplementation === "string"
            ? videoReport.decoderImplementation
            : "Not reported",
        decodeMs: videoReport
          ? intervalMeanMs(
              videoReport,
              this.previousVideo,
              "totalDecodeTime",
              "framesDecoded",
            )
          : undefined,
        jitterBufferMs: videoReport
          ? intervalMeanMs(
              videoReport,
              this.previousVideo,
              "jitterBufferDelay",
              "jitterBufferEmittedCount",
            )
          : undefined,
        inputQueueBytes: this.channels.input.bufferedAmount,
        ...this.frameMetrics.snapshot(videoReport),
        networkQuality: assessNetworkQuality(rtt, packetLoss, fps),
        updatedAt: Date.now(),
      });
      this.previousVideo = videoReport;
    } catch {
      // A stats failure during shutdown must not interrupt play or reject unhandled.
    } finally {
      this.telemetryCollecting = false;
    }
  }

  private async addIceCandidate(candidate: IceCandidatePayload): Promise<void> {
    if (!candidate.candidate || candidate.candidate === "a=end-of-candidates")
      return;
    try {
      await this.peer.addIceCandidate(candidate);
    } catch {
      // Server candidate sets can include routes unavailable on this host.
    }
  }

  private send(channel: RTCDataChannel, value: unknown): void {
    if (channel.readyState !== "open") return;
    channel.send(typeof value === "string" ? value : JSON.stringify(value));
  }

  private notifyInterrupted(): void {
    if (this.destroyed || this.terminal) return;
    this.terminal = true;
    this.releaseInput();
    this.frameMetrics.stop();
    clearTimeout(this.disconnectedTimer);
    clearInterval(this.keepaliveTimer);
    clearInterval(this.telemetryTimer);
    this.options.onInterrupted();
  }

  private notifyError(message: string): void {
    if (this.destroyed || this.terminal) return;
    this.terminal = true;
    this.releaseInput();
    this.frameMetrics.stop();
    clearTimeout(this.connectionDeadlineTimer);
    clearTimeout(this.disconnectedTimer);
    clearInterval(this.keepaliveTimer);
    clearInterval(this.telemetryTimer);
    this.options.onError(message);
  }

  private nextSequence(): number {
    this.sequence = (this.sequence + 1) >>> 0;
    return this.sequence;
  }
}

export function streamErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Video negotiation failed.";
  return message.replace(
    /^Error invoking remote method '[^']+':\s*(?:AfterglideError|Error):\s*/,
    "",
  );
}

function preferredVideoCodecs(): RTCRtpCodec[] {
  const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
  const h264Main = codecs.filter(
    (codec) =>
      codec.mimeType.toLowerCase().includes("h264") &&
      codec.sdpFmtpLine?.includes("profile-level-id=4d"),
  );
  const h264Constrained = codecs.filter(
    (codec) =>
      codec.mimeType.toLowerCase().includes("h264") &&
      codec.sdpFmtpLine?.includes("profile-level-id=42e"),
  );
  const h264Baseline = codecs.filter(
    (codec) =>
      codec.mimeType.toLowerCase().includes("h264") &&
      codec.sdpFmtpLine?.includes("profile-level-id=420"),
  );
  const fallbacks = codecs.filter((codec) =>
    /(?:ulpfec|flexfec|vp8|vp9)/i.test(codec.mimeType),
  );
  return [...h264Main, ...h264Constrained, ...h264Baseline, ...fallbacks];
}

function candidatePayload(candidate: RTCIceCandidate): IceCandidatePayload {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

function waitForIceGathering(
  peer: RTCPeerConnection,
  timeoutMs: number,
): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onChange);
    function onChange(): void {
      if (peer.iceGatheringState === "complete") done();
    }
    function done(): void {
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
  });
}

function readInputFrame(
  gamepad: GamepadLike | undefined,
  keys: ReadonlySet<string>,
  tuning: ReturnType<typeof tuningForGamepad> | undefined,
  reserveControlChord = true,
  target = emptyXboxInputFrame(),
): InputFrame | undefined {
  if (!gamepad && keys.size === 0) return undefined;
  const frame =
    gamepad && tuning
      ? controllerInputFrame(gamepad, tuning, target)
      : resetXboxInputFrame(target);
  applyKeyboardInput(frame, keys);
  normalizeInputChords(frame, reserveControlChord);
  return frame;
}

function normalizeInputChords(
  frame: InputFrame,
  reserveControlChord = true,
): void {
  // In the built-in mode, prevent Afterglide's L3 + R3 shortcut from leaking.
  if (reserveControlChord && frame.LeftThumb > 0 && frame.RightThumb > 0) {
    frame.LeftThumb = 0;
    frame.RightThumb = 0;
  }
  if (frame.View > 0 && frame.Menu > 0) {
    frame.View = 0;
    frame.Menu = 0;
    frame.Nexus = 1;
  }
}

function chooseInputUpdate(
  frame: InputFrame | undefined,
  lastSignature: string,
  heartbeatDue: boolean,
): { frame: InputFrame; signature: string } | undefined {
  if (!frame)
    return lastSignature
      ? { frame: emptyXboxInputFrame(), signature: "" }
      : undefined;
  const signature = JSON.stringify(frame);
  return signature !== lastSignature || heartbeatDue
    ? { frame, signature }
    : undefined;
}

function writeGamepad(
  packet: DataView,
  offset: number,
  frame: InputFrame,
): void {
  packet.setUint8(offset, frame.GamepadIndex);
  let mask = 0;
  const masks: Array<[ButtonName, number]> = [
    ["Nexus", 2],
    ["Menu", 4],
    ["View", 8],
    ["A", 16],
    ["B", 32],
    ["X", 64],
    ["Y", 128],
    ["DPadUp", 256],
    ["DPadDown", 512],
    ["DPadLeft", 1_024],
    ["DPadRight", 2_048],
    ["LeftShoulder", 4_096],
    ["RightShoulder", 8_192],
    ["LeftThumb", 16_384],
    ["RightThumb", 32_768],
  ];
  masks.forEach(([name, value]) => {
    if (frame[name] > 0) mask |= value;
  });
  packet.setUint16(offset + 1, mask, true);
  packet.setInt16(offset + 3, normalizeAxis(frame.LeftThumbXAxis), true);
  packet.setInt16(offset + 5, normalizeAxis(-frame.LeftThumbYAxis), true);
  packet.setInt16(offset + 7, normalizeAxis(frame.RightThumbXAxis), true);
  packet.setInt16(offset + 9, normalizeAxis(-frame.RightThumbYAxis), true);
  packet.setUint16(offset + 11, normalizeTrigger(frame.LeftTrigger), true);
  packet.setUint16(offset + 13, normalizeTrigger(frame.RightTrigger), true);
  packet.setUint32(offset + 15, 1, true);
  packet.setUint32(offset + 19, 1, false);
}

function normalizeAxis(value: number): number {
  return Math.max(-32_767, Math.min(32_767, Math.round(value * 32_767)));
}

function normalizeTrigger(value: number): number {
  return Math.max(
    value > 0 ? 1 : 0,
    Math.min(65_535, Math.round(value * 65_535)),
  );
}

function withTeredoFallback(
  candidate: IceCandidatePayload,
): IceCandidatePayload[] {
  const parts = candidate.candidate.split(" ");
  const address = parts[4];
  if (!address?.toLowerCase().startsWith("2001:")) return [candidate];
  const teredo = decodeTeredo(address);
  if (!teredo) return [candidate];
  return [
    {
      ...candidate,
      candidate: `candidate:10 1 UDP 1 ${teredo.address} 9002 typ host`,
    },
    {
      ...candidate,
      candidate: `candidate:11 1 UDP 1 ${teredo.address} ${teredo.port} typ host`,
    },
    candidate,
  ];
}

function decodeTeredo(
  address: string,
): { address: string; port: number } | undefined {
  const groups = expandIpv6(address);
  if (!groups || groups.length !== 8) return undefined;
  const port = parseInt(groups[5], 16) ^ 0xffff;
  const bytes = [
    groups[6].slice(0, 2),
    groups[6].slice(2),
    groups[7].slice(0, 2),
    groups[7].slice(2),
  ].map((value) => parseInt(value, 16) ^ 0xff);
  return { address: bytes.join("."), port };
}

function expandIpv6(address: string): string[] | undefined {
  const [left = "", right = ""] = address.split("::");
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  if (!address.includes("::") && leftGroups.length !== 8) return undefined;
  const missing = 8 - leftGroups.length - rightGroups.length;
  if (missing < 0) return undefined;
  return [
    ...leftGroups,
    ...Array.from({ length: missing }, () => "0"),
    ...rightGroups,
  ].map((group) => group.padStart(4, "0"));
}

function isPrivateAddress(address: string): boolean {
  return (
    address.startsWith("10.") ||
    address.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    address.startsWith("fc") ||
    address.startsWith("fd")
  );
}

export function encodeGamepadPacketForTest(
  input: Partial<InputFrame>,
  sequence = 1,
  timestamp = 0,
): Uint8Array {
  const bytes = new Uint8Array(38);
  const packet = new DataView(bytes.buffer);
  packet.setUint16(0, 2, true);
  packet.setUint32(2, sequence, true);
  packet.setFloat64(6, timestamp, true);
  packet.setUint8(14, 1);
  writeGamepad(packet, 15, { ...emptyXboxInputFrame(), ...input });
  return bytes;
}

export const streamProtocolTestUtils = {
  decodeTeredo,
  withTeredoFallback,
  chooseInputUpdate: (
    input: Partial<InputFrame> | undefined,
    lastSignature = "",
    heartbeatDue = false,
  ) =>
    chooseInputUpdate(
      input ? { ...emptyXboxInputFrame(), ...input } : undefined,
      lastSignature,
      heartbeatDue,
    ),
  keyboardInput: (codes: string[]) => {
    const frame = emptyXboxInputFrame();
    applyKeyboardInput(frame, new Set(codes));
    return frame;
  },
  normalizedInput: (input: Partial<InputFrame>, reserveControlChord = true) => {
    const frame = { ...emptyXboxInputFrame(), ...input };
    normalizeInputChords(frame, reserveControlChord);
    return frame;
  },
};
