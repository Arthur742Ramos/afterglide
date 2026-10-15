import { AdaptivePlayoutPolicy, applyPlayoutTarget } from "./adaptive-playout";
import { preferredVideoCodecs } from "./video-codecs";
import { extractStreamStats, type StreamStatsSample } from "./telemetry";
import type {
  AppSettings,
  PlaybackWindowState,
  IceCandidatePayload,
  StreamTelemetry,
} from "../../shared/contracts";
import { NETWORK_POLICY } from "../../shared/network-policy";
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
  connectedGamepads,
  controllerSupportsRumble,
  ControllerInputReleaseGate,
  friendlyControllerName,
  selectController,
  tuningForGamepad,
  type GamepadLike,
} from "./controller-input";
import { InputTransitionBuffer, type InputBufferFailure } from "./input-buffer";
import { FrameMetricsTracker } from "./frame-metrics";
import { InputPollingMetrics } from "./input-polling-metrics";
import { ControllerChordInput } from "./controller-chord";

export type PlaybackSettings = Pick<
  AppSettings,
  "volume" | "muted" | "videoFit" | "inputPolling" | "playbackMode"
>;

const defaultPlaybackSettings: PlaybackSettings = {
  volume: 1,
  muted: false,
  videoFit: "fit",
  inputPolling: "responsive",
  playbackMode: "automatic",
};

export interface ControllerStatus {
  state: "connected" | "switched" | "disconnected" | "unsupported";
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
  private readonly playout = new AdaptivePlayoutPolicy();
  private readonly mediaReceivers = new Set<RTCRtpReceiver>();
  private readonly inputBuffer = new InputTransitionBuffer();
  private readonly inputPollingMetrics = new InputPollingMetrics();
  private readonly sampledFrame = emptyXboxInputFrame();
  private playbackSettings?: PlaybackSettings;
  private playbackWindow?: PlaybackWindowState;
  private readonly localCandidates: IceCandidatePayload[] = [];
  private readonly localCandidateKeys = new Set<string>();
  private readonly pressedKeys = new Set<string>();
  private destroyed = false;
  private terminal = false;
  private connected = false;
  private videoPlaying = false;
  private inputActive = false;
  private inputSuspended = false;
  private transportDisconnected = false;
  private sequence = 0;
  private lastInputAt = 0;
  private inputTimer = 0;
  private neutralPending = false;
  private handshakeAcknowledged = false;
  private telemetryTimer = 0;
  private keepaliveTimer = 0;
  private keepaliveInFlight = false;
  private connectionDeadlineTimer = 0;
  private disconnectedTimer = 0;
  private keepaliveFailures = 0;
  private previousStats?: StreamStatsSample;
  private telemetryCollecting = false;
  private activeGamepadIndex?: number;
  private activeGamepadId = "";
  private activeGamepadLabel = "";
  private sampledInput = false;
  private readonly controlsShortcut = new ControllerChordInput();
  private readonly gamepadRelease = new ControllerInputReleaseGate();
  private unsupportedControllerKey = "";
  private unsupportedControllerLabel = "";
  private rumbleActuator?: GamepadLike["vibrationActuator"];

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
    for (const name of ["control", "input", "message"] as const) {
      const channel = this.channels[name];
      channel.addEventListener("open", () => this.activateInput());
      channel.addEventListener("close", () => this.failRequiredChannel(name));
      channel.addEventListener("error", () => this.failRequiredChannel(name));
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
    this.video.disablePictureInPicture = true;
    this.video.disableRemotePlayback = true;
    this.video.setAttribute("aria-label", "Xbox remote-play video");
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.setAttribute("aria-hidden", "true");
    options.container.replaceChildren(this.video, this.audio);
    this.setPlaybackSettings(
      options.playbackSettings ?? defaultPlaybackSettings,
    );
    this.frameMetrics = new FrameMetricsTracker(this.video);
    this.frameMetrics.start(this.isPlaybackVisible());

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
    this.video.addEventListener("playing", () => {
      this.videoPlaying = true;
      this.markConnected();
    });
    for (const event of ["waiting", "pause", "ended"]) {
      this.video.addEventListener(event, () => {
        this.videoPlaying = false;
        this.suspendPlayout(event === "waiting" && this.isPlaybackVisible());
      });
    }

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("focus", this.onFocus);
    window.addEventListener("gamepadconnected", this.onGamepadChange);
    window.addEventListener("gamepaddisconnected", this.onGamepadChange);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  async connect(): Promise<void> {
    try {
      this.connectionDeadlineTimer = window.setTimeout(() => {
        if (!this.connected && !this.destroyed) {
          this.notifyError(
            this.videoPlaying
              ? "The Xbox input connection timed out. Reconnect to try again."
              : "The video connection timed out. Check your network and try again.",
            true,
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

      const answer = await window.afterglideCloud.sendSdp(
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
      const remoteCandidates = await window.afterglideCloud.sendIce(
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
        if (this.destroyed || this.terminal || this.keepaliveInFlight) return;
        this.keepaliveInFlight = true;
        void window.afterglideCloud
          .keepalive(this.options.sessionId)
          .then(() => {
            if (this.destroyed || this.terminal) return;
            this.keepaliveFailures = 0;
          })
          .catch(() => {
            if (this.destroyed || this.terminal) return;
            this.keepaliveFailures += 1;
            if (
              this.keepaliveFailures >= NETWORK_POLICY.keepaliveFailureThreshold
            )
              this.notifyInterrupted();
          })
          .finally(() => {
            this.keepaliveInFlight = false;
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
    this.controlsShortcut.reset();
    if (suspended) this.releaseInput();
    else this.primeControllerRelease();
    this.updateInputPolling();
  }

  setPlaybackSettings(settings: PlaybackSettings): void {
    if (
      this.playbackSettings?.volume === settings.volume &&
      this.playbackSettings.muted === settings.muted &&
      this.playbackSettings.videoFit === settings.videoFit &&
      this.playbackSettings.inputPolling === settings.inputPolling &&
      this.playbackSettings.playbackMode === settings.playbackMode
    )
      return;
    const pollingChanged =
      this.playbackSettings?.inputPolling !== settings.inputPolling;
    this.playout.setMode(settings.playbackMode);
    for (const receiver of this.mediaReceivers)
      applyPlayoutTarget(receiver, this.playout.target);
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
    if (
      this.destroyed ||
      (!this.inputActive && !this.neutralPending) ||
      (this.terminal && !this.neutralPending)
    ) {
      this.inputPollingMetrics.reset();
      return;
    }
    const active =
      !this.terminal &&
      !this.inputSuspended &&
      !this.transportDisconnected &&
      this.hasPlaybackFocus() &&
      this.isPlaybackVisible();
    // Paused/hidden streams only retry neutral. Wake promptly on focus/visibility.
    if (!active && !this.neutralPending) {
      this.inputPollingMetrics.reset();
      return;
    }
    const idle =
      this.sampledInput &&
      this.activeGamepadIndex === undefined &&
      this.pressedKeys.size === 0;
    const interval =
      active && !idle
        ? this.playbackSettings?.inputPolling === "efficient"
          ? 8
          : 4
        : 50;
    this.inputPollingMetrics.restart(
      interval === 4 || interval === 8 ? interval : undefined,
    );
    this.inputTimer = window.setInterval(() => {
      // Only timer-driven polls count; keyboard/drain/hotplug callbacks do not.
      this.inputLoop(true);
    }, interval);
  };

  private onBlur = (): void => {
    this.controlsShortcut.reset();
    this.releaseInput();
    this.updateInputPolling();
  };

  private onFocus = (): void => {
    this.primeControllerRelease();
    this.updateInputPolling();
  };

  private onGamepadChange = (event: Event): void => {
    const changed = (event as GamepadEvent).gamepad;
    if (
      (event.type === "gamepaddisconnected" &&
        (!changed || changed.index === this.activeGamepadIndex)) ||
      (event.type === "gamepadconnected" &&
        changed?.index === this.activeGamepadIndex &&
        changed?.id === this.activeGamepadId)
    )
      this.releaseInput();
    this.sampledInput = false;
    this.updateInputPolling();
    this.inputLoop();
  };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.inputPollingMetrics.reset();
    clearInterval(this.inputTimer);
    clearInterval(this.telemetryTimer);
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.connectionDeadlineTimer);
    clearTimeout(this.disconnectedTimer);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("focus", this.onFocus);
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
    this.mediaReceivers.clear();
    this.options.container.replaceChildren();
  }

  private suspendPlayout(mediaDisturbance = false): void {
    this.playout.suspend(mediaDisturbance);
    for (const receiver of this.mediaReceivers)
      applyPlayoutTarget(receiver, null);
  }

  private attachTrack(event: RTCTrackEvent): void {
    this.mediaReceivers.add(event.receiver);
    applyPlayoutTarget(event.receiver, this.playout.target);
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    if (event.track.kind === "video") this.video.srcObject = stream;
    if (event.track.kind === "audio") this.audio.srcObject = stream;
  }

  private handleConnectionState(): void {
    if (this.destroyed) return;
    if (this.peer.connectionState === "connected") {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = 0;
      if (this.transportDisconnected) {
        this.transportDisconnected = false;
        this.primeControllerRelease();
        this.updateInputPolling();
      }
      // Transport connectivity alone does not prove video is decoding.
      // Keep the startup deadline until video and input are both usable.
      return;
    }
    if (this.connected && this.peer.connectionState === "disconnected") {
      this.transportDisconnected = true;
      this.suspendPlayout();
      this.releaseInput();
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = window.setTimeout(() => {
        if (!this.destroyed && this.peer.connectionState === "disconnected")
          this.notifyInterrupted();
      }, NETWORK_POLICY.disconnectedGraceMs);
    }
    if (this.connected && this.peer.connectionState === "failed") {
      this.suspendPlayout();
      this.notifyInterrupted();
    }
    if (!this.connected && this.peer.connectionState === "failed")
      this.notifyError("A usable route to the Xbox was not found.");
  }

  private markConnected(): void {
    if (
      this.connected ||
      this.destroyed ||
      this.terminal ||
      !this.videoPlaying ||
      !this.inputActive ||
      this.channels.control.readyState !== "open" ||
      this.channels.input.readyState !== "open" ||
      this.channels.message.readyState !== "open"
    )
      return;
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
    if (this.destroyed || this.terminal) return;
    try {
      const data = JSON.parse(String(event.data)) as {
        type?: string;
        target?: string;
        id?: string;
        content?: string;
      };
      if (data.type === "HandshakeAck") {
        this.handshakeAcknowledged = true;
        this.sendClientConfiguration();
        this.activateInput();
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
      this.channels.input.readyState !== "open" ||
      this.channels.message.readyState !== "open"
    )
      return;
    if (!this.authorizeControl()) return;
    try {
      this.startInput();
      this.markConnected();
    } catch {
      this.failRequiredChannel("input");
    }
  }

  private authorizeControl(): boolean {
    if (
      !this.send(this.channels.control, {
        message: "authorizationRequest",
        accessKey: "4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E",
      })
    )
      return false;
    return this.send(this.channels.control, {
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
    // Seed while startup controls are still held, before the first input tick.
    if (this.hasPlaybackFocus() && this.isPlaybackVisible()) {
      const gamepad = this.resolveGamepad();
      if (gamepad)
        this.gamepadRelease.prime(
          gamepad,
          tuningForGamepad(this.options.controllerSettings, gamepad),
        );
    }
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

  private inputLoop = (fromTimer = false): void => {
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
      !this.transportDisconnected &&
      this.hasPlaybackFocus() &&
      this.isPlaybackVisible()
    ) {
      this.sendCurrentInput(
        performance.now() - this.lastInputAt >= NETWORK_POLICY.inputHeartbeatMs,
        fromTimer,
      );
    }
  };

  private sendCurrentInput(heartbeatDue = false, fromTimer = false): void {
    if (
      !this.inputActive ||
      this.inputSuspended ||
      this.transportDisconnected ||
      this.terminal ||
      this.destroyed ||
      this.neutralPending ||
      !this.hasPlaybackFocus() ||
      !this.isPlaybackVisible()
    )
      return;
    if (fromTimer) this.inputPollingMetrics.observe(performance.now());
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
        this.gamepadRelease,
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
    this.gamepadRelease.arm();
    this.controlsShortcut.reset();
    this.stopRumble();
    this.primeControllerRelease();
    this.pressedKeys.clear();
    this.inputBuffer.clear();
    if (this.inputActive)
      this.neutralPending = !this.sendInputFrame(emptyXboxInputFrame());
    this.updateInputPolling();
  };

  private primeControllerRelease(): void {
    if (
      this.inputActive &&
      !this.inputSuspended &&
      !this.transportDisconnected &&
      !this.destroyed &&
      !this.terminal &&
      this.hasPlaybackFocus() &&
      this.isPlaybackVisible()
    ) {
      const gamepad = selectController(
        navigator.getGamepads(),
        this.options.controllerSettings.preferredControllerId,
        this.activeGamepadIndex,
      );
      if (gamepad)
        this.gamepadRelease.prime(
          gamepad,
          tuningForGamepad(this.options.controllerSettings, gamepad),
        );
    }
  }

  private hasPlaybackFocus(): boolean {
    return document.hasFocus() && this.playbackWindow?.focused !== false;
  }

  private isPlaybackVisible(): boolean {
    const state = this.playbackWindow;
    return (
      document.visibilityState === "visible" &&
      (!state ||
        (state.visible &&
          !state.minimized &&
          !state.screenLocked &&
          !state.suspended))
    );
  }

  setPlaybackWindow(state: PlaybackWindowState | undefined): void {
    const wasVisible = this.isPlaybackVisible();
    const wasFocused = this.playbackWindow?.focused;
    this.playbackWindow = state;
    if (wasVisible !== this.isPlaybackVisible()) this.onVisibilityChange();
    if (state?.focused === false && wasFocused !== false) this.onBlur();
    else if (state?.focused === true && wasFocused === false) this.onFocus();
  }

  private onVisibilityChange = (): void => {
    if (!this.isPlaybackVisible()) {
      this.suspendPlayout();
      this.controlsShortcut.reset();
      this.releaseInput();
    } else this.primeControllerRelease();
    this.frameMetrics.setVisible(this.isPlaybackVisible());
    this.updateInputPolling();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (
      !this.options.keyboardControls ||
      this.inputSuspended ||
      this.transportDisconnected ||
      !isKeyboardControlCode(event.code) ||
      !this.isPlaybackVisible() ||
      !this.hasPlaybackFocus()
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
    if (this.inputSuspended || this.transportDisconnected) return;
    this.sendCurrentInput();
    event.preventDefault();
  };

  private handleInputMessage(event: MessageEvent): void {
    if (
      this.destroyed ||
      this.terminal ||
      this.inputSuspended ||
      this.transportDisconnected ||
      !this.inputActive ||
      !this.hasPlaybackFocus() ||
      !this.isPlaybackVisible()
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
    if (!controllerSupportsRumble(gamepad)) return;
    const actuator = gamepad.vibrationActuator!;
    const intensity = tuning.rumble === "low" ? 0.45 : 1;
    if (this.rumbleActuator && this.rumbleActuator !== actuator)
      this.stopRumble();
    this.rumbleActuator = actuator;
    const duration = Math.min(5000, report.getUint16(8, true));
    try {
      // The browser preempts older dual-rumble effects. Never queue a replay.
      void Promise.resolve(
        actuator.playEffect("dual-rumble", {
          startDelay: Math.min(5000 - duration, report.getUint16(10, true)),
          duration,
          weakMagnitude: Math.min(1, report.getUint8(5) / 100) * intensity,
          strongMagnitude: Math.min(1, report.getUint8(4) / 100) * intensity,
        }),
      ).catch(() => {
        // Unsupported, hidden or disconnected devices do not interrupt play.
      });
    } catch {
      // Legacy implementations may throw synchronously instead of rejecting.
    }
  }

  private stopRumble(): void {
    const actuator = this.rumbleActuator;
    this.rumbleActuator = undefined;
    if (!actuator) return;
    try {
      const stopped =
        typeof actuator.reset === "function"
          ? actuator.reset()
          : actuator.playEffect("dual-rumble", {
              duration: 0,
              startDelay: 0,
              weakMagnitude: 0,
              strongMagnitude: 0,
            });
      void Promise.resolve(stopped).catch(() => {});
    } catch {
      // Removal and visibility changes can make haptics unavailable immediately.
    }
  }

  private resolveGamepad(): GamepadLike | undefined {
    const previousIndex = this.activeGamepadIndex;
    const previousLabel = this.activeGamepadLabel;
    const gamepads = navigator.getGamepads();
    const gamepad = selectController(
      gamepads,
      this.options.controllerSettings.preferredControllerId,
      previousIndex,
    );
    const unsupported =
      !gamepad &&
      connectedGamepads(gamepads).find(
        (candidate) =>
          !this.options.controllerSettings.preferredControllerId ||
          candidate.id ===
            this.options.controllerSettings.preferredControllerId,
      );
    const unsupportedKey = unsupported
      ? JSON.stringify([unsupported.id, unsupported.index, unsupported.mapping])
      : "";
    if (unsupportedKey !== this.unsupportedControllerKey) {
      const previousUnsupportedLabel = this.unsupportedControllerLabel;
      this.unsupportedControllerKey = unsupportedKey;
      this.unsupportedControllerLabel = unsupported
        ? friendlyControllerName(unsupported.id)
        : "";
      if (unsupported)
        this.options.onControllerStatus({
          state: "unsupported",
          label: this.unsupportedControllerLabel,
        });
      else if (!gamepad && previousUnsupportedLabel)
        this.options.onControllerStatus({
          state: "disconnected",
          label: previousUnsupportedLabel,
        });
    }
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
    } else if (previousIndex !== undefined && !unsupported) {
      this.options.onControllerStatus({
        state: "disconnected",
        label: previousLabel || "Controller",
      });
    }
    return gamepad;
  }

  private updateControlsShortcut(gamepad: GamepadLike | undefined): void {
    if (
      this.destroyed ||
      this.terminal ||
      this.inputSuspended ||
      !this.options.reserveControlChord ||
      !this.hasPlaybackFocus() ||
      !this.isPlaybackVisible()
    ) {
      this.controlsShortcut.reset();
      return;
    }
    if (this.controlsShortcut.consume(gamepad))
      this.options.onControlsShortcut();
  }

  private async collectTelemetry(): Promise<void> {
    if (this.destroyed || this.terminal || this.telemetryCollecting) return;
    this.telemetryCollecting = true;
    try {
      const reports = await this.peer.getStats();
      if (this.destroyed || this.terminal) return;
      const records = new Map<string, Record<string, unknown>>();
      reports.forEach((report) =>
        records.set(report.id, report as unknown as Record<string, unknown>),
      );
      const { telemetry: statsTelemetry, sample } = extractStreamStats(
        records,
        this.previousStats,
        performance.now(),
      );
      const telemetry = {
        ...statsTelemetry,
        ...this.frameMetrics.snapshot(sample.video, sample.observedAt),
      };
      if (
        this.videoPlaying &&
        !this.transportDisconnected &&
        this.isPlaybackVisible()
      )
        this.playout.update(sample.video, telemetry, sample.observedAt);
      else this.playout.suspend();
      let videoTargetAccepted: boolean | undefined;
      for (const receiver of this.mediaReceivers) {
        const accepted = applyPlayoutTarget(receiver, this.playout.target);
        if (receiver.track.kind === "video") videoTargetAccepted = accepted;
      }
      this.options.onTelemetry({
        ...telemetry,
        playoutMode:
          this.playout.target === null
            ? "automatic"
            : this.playout.target === 0
              ? "low-delay"
              : "smooth",
        playoutTargetMs: this.playout.target ?? undefined,
        playoutTargetAccepted: videoTargetAccepted,
        inputQueueBytes: this.channels.input.bufferedAmount,
        inputPolling: this.inputPollingMetrics.snapshot(),
        playbackVisible: this.isPlaybackVisible(),
        documentVisible: document.visibilityState === "visible",
        playbackFocused: this.hasPlaybackFocus(),
        updatedAt: Date.now(),
      });
      this.previousStats = sample;
    } catch {
      // A stats failure during shutdown must not interrupt play or reject unhandled.
      if (!this.destroyed && !this.terminal) this.suspendPlayout();
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

  private send(channel: RTCDataChannel, value: unknown): boolean {
    if (this.destroyed || this.terminal || channel.readyState !== "open")
      return false;
    try {
      channel.send(typeof value === "string" ? value : JSON.stringify(value));
      return true;
    } catch {
      this.failRequiredChannel(
        channel === this.channels.control ? "control" : "message",
      );
      return false;
    }
  }

  private failRequiredChannel(name: "control" | "input" | "message"): void {
    if (this.destroyed || this.terminal) return;
    // Neutral is attempted before closing the remaining transport. A closed
    // required channel cannot recover within the same peer connection.
    if (this.connected) this.notifyInterrupted(true);
    else
      this.notifyError(
        `The Xbox ${name} connection was lost before the stream was ready. Reconnect to try again.`,
        true,
      );
  }

  private notifyInterrupted(closeTransport = false): void {
    if (this.destroyed || this.terminal) return;
    this.terminal = true;
    if (closeTransport) this.destroy();
    else this.releaseInput();
    this.frameMetrics.stop();
    clearTimeout(this.disconnectedTimer);
    clearInterval(this.keepaliveTimer);
    clearInterval(this.telemetryTimer);
    this.options.onInterrupted();
  }

  private notifyError(message: string, closeTransport = false): void {
    if (this.destroyed || this.terminal) return;
    this.terminal = true;
    if (closeTransport) this.destroy();
    else this.releaseInput();
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
  releaseGate?: ControllerInputReleaseGate,
): InputFrame | undefined {
  if (!gamepad && keys.size === 0) return undefined;
  const frame =
    gamepad && tuning
      ? controllerInputFrame(gamepad, tuning, target, releaseGate)
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

const gamepadButtonMasks: ReadonlyArray<readonly [ButtonName, number]> = [
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

function writeGamepad(
  packet: DataView,
  offset: number,
  frame: InputFrame,
): void {
  packet.setUint8(offset, frame.GamepadIndex);
  let mask = 0;
  gamepadButtonMasks.forEach(([name, value]) => {
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
