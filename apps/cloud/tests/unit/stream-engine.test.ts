import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  XboxStreamEngine,
  type ControllerStatus,
} from "../../src/renderer/stream/stream-engine";
import {
  defaultControllerTuning,
  type StreamTelemetry,
} from "../../src/shared/contracts";

class Channel extends EventTarget {
  readyState = "connecting";
  bufferedAmount = 0;
  failSend = false;
  closeCalls = 0;
  sent: unknown[] = [];
  send(value: unknown) {
    if (this.failSend) throw new Error("send failed");
    this.sent.push(value);
  }
  close() {
    this.closeCalls += 1;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
}
class Peer extends EventTarget {
  closeCalls = 0;
  receivers: RTCRtpReceiver[] = [];
  channels: Record<string, Channel> = {};
  channelOptions: Record<string, RTCDataChannelInit> = {};
  stats = new Map<string, Record<string, unknown>>();
  iceGatheringState = "complete";
  connectionState = "new";
  createDataChannel(name: string, options: RTCDataChannelInit) {
    this.channelOptions[name] = options;
    return (this.channels[name] = new Channel());
  }
  addTransceiver() {
    return { setCodecPreferences() {} };
  }
  async createOffer() {
    return { type: "offer", sdp: "" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  getReceivers() {
    return this.receivers;
  }
  async getStats() {
    return this.stats;
  }
  close() {
    this.closeCalls += 1;
  }
}
class Media extends EventTarget {
  style = { objectFit: "" };
  volume = 1;
  muted = false;
  frameCallback?: VideoFrameRequestCallback;
  frameCallbackCount = 0;
  cancelledCallback?: number;
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
    this.frameCallback = callback;
    return ++this.frameCallbackCount;
  }
  cancelVideoFrameCallback(id: number) {
    this.cancelledCallback = id;
  }
  setAttribute() {}
}
let peer: Peer;
let engine: XboxStreamEngine;
let onConnected = vi.fn<() => void>();
let onInterrupted = vi.fn<() => void>();
let onError = vi.fn<(message: string) => void>();
let media: Media[];
let focused: boolean;
let button: number;
let padIndex: number;
let padId: string;
let padMapping: string;
let padConnected: boolean;
let vibrationActuator: GamepadHapticActuator | undefined;
let axis: number;
let trigger: number;
let controlsShortcut: boolean;
let onTelemetry = vi.fn<(telemetry: StreamTelemetry) => void>();
let onControlsShortcut = vi.fn<() => void>();
let onControllerStatus = vi.fn<(status: ControllerStatus) => void>();
let win: EventTarget;
let doc: EventTarget & { visibilityState: string };

beforeEach(async () => {
  vi.useFakeTimers();
  focused = true;
  button = 0;
  padIndex = 0;
  padId = "pad";
  padMapping = "standard";
  padConnected = true;
  vibrationActuator = undefined;
  axis = 0;
  trigger = 0;
  controlsShortcut = false;
  peer = new Peer();
  media = [];
  onConnected = vi.fn();
  onInterrupted = vi.fn();
  onError = vi.fn();
  onTelemetry = vi.fn();
  onControlsShortcut = vi.fn();
  onControllerStatus = vi.fn();
  win = Object.assign(new EventTarget(), {
    setInterval,
    setTimeout,
    afterglideCloud: {
      sendSdp: async () => ({ sdp: "" }),
      sendIce: async () => [],
      keepalive: async () => {},
    },
  });
  doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => focused,
    createElement: () => {
      const element = new Media();
      media.push(element);
      return element;
    },
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", {
    maxTouchPoints: 0,
    getGamepads: () =>
      padConnected
        ? [
            {
              id: padId,
              index: padIndex,
              connected: true,
              mapping: padMapping,
              vibrationActuator,
              axes: [axis, 0, 0, 0],
              buttons: Array.from({ length: 17 }, (_, i) => ({
                value:
                  i === 0
                    ? button
                    : i === 7
                      ? trigger
                      : controlsShortcut && (i === 10 || i === 11)
                        ? 1
                        : 0,
                pressed:
                  (i === 0 && button > 0) ||
                  (i === 7 && trigger > 0) ||
                  (controlsShortcut && (i === 10 || i === 11)),
              })),
            },
          ]
        : [],
  });
  vi.stubGlobal(
    "RTCPeerConnection",
    class {
      constructor() {
        return peer;
      }
    },
  );
  vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => ({ codecs: [] }) });
  engine = new XboxStreamEngine({
    sessionId: "test",
    container: { replaceChildren() {} } as unknown as HTMLElement,
    keyboardControls: true,
    reserveControlChord: true,
    controllerSettings: {
      preferredControllerId: "",
      controllerDefaults: defaultControllerTuning,
      controllerProfiles: [],
    },
    onConnected,
    onInterrupted,
    onError,
    onTelemetry,
    onControllerStatus,
    onControlsShortcut,
  });
  await engine.connect();
});
afterEach(() => {
  engine.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function ack() {
  peer.channels.message.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ type: "HandshakeAck" }),
    }),
  );
}
function ready() {
  peer.channels.message.open();
  peer.channels.control.open();
  peer.channels.input.open();
  ack();
}
function frames() {
  return peer.channels.input.sent.filter(
    (value): value is DataView =>
      value instanceof DataView && value.byteLength === 38,
  );
}
function a(frame: DataView) {
  return Boolean(frame.getUint16(16, true) & 16);
}

function rumble(strong = 50, weak = 25, duration = 100, delay = 0) {
  const bytes = new Uint8Array(13);
  const report = new DataView(bytes.buffer);
  report.setUint8(0, 128);
  report.setUint8(4, strong);
  report.setUint8(5, weak);
  report.setUint16(8, duration, true);
  report.setUint16(10, delay, true);
  peer.channels.input.dispatchEvent(
    new MessageEvent("message", { data: bytes.buffer }),
  );
}

function actuator() {
  return {
    type: "dual-rumble" as const,
    effects: ["dual-rumble"],
    playEffect: vi.fn(async () => "complete" as GamepadHapticsResult),
    reset: vi.fn(async () => "complete" as GamepadHapticsResult),
  };
}

describe("real stream engine input lifecycle", () => {
  it.each(["waiting", "hidden", "disconnected", "stats-failure"] as const)(
    "keeps both receivers automatic on startup, adapts after healthy video, and resets on %s",
    async (reason) => {
      let at = 0;
      vi.spyOn(performance, "now").mockImplementation(() => at);
      const receivers = ["video", "audio"].map((kind) => ({
        jitterBufferTarget: 0 as number | null,
        track: { kind, stop() {} },
      })) as unknown as RTCRtpReceiver[];
      peer.receivers = receivers;
      for (const receiver of receivers)
        peer.dispatchEvent(
          Object.assign(new Event("track"), {
            receiver,
            track: receiver.track,
            streams: [{}],
          }),
        );
      expect(receivers.map((receiver) => receiver.jitterBufferTarget)).toEqual([
        null,
        null,
      ]);
      ready();
      media[0].dispatchEvent(new Event("playing"));
      peer.stats.set("t", {
        id: "t",
        type: "transport",
        selectedCandidatePairId: "p",
      });
      peer.stats.set("p", {
        id: "p",
        type: "candidate-pair",
        currentRoundTripTime: 0.035,
      });
      for (let second = 0; second <= 11; second++) {
        at = second * 1000;
        peer.stats.set("v", {
          id: "v",
          type: "inbound-rtp",
          kind: "video",
          timestamp: at,
          framesDecoded: second * 60,
          framesPerSecond: 60,
          packetsReceived: second * 100,
          packetsLost: 0,
          bytesReceived: second * 10000,
          jitter: 0.002,
          freezeCount: 0,
          framesDropped: 0,
        });
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(receivers.map((receiver) => receiver.jitterBufferTarget)).toEqual([
        0, 0,
      ]);
      expect(onTelemetry).toHaveBeenLastCalledWith(
        expect.objectContaining({ jitterMs: 2, playoutMode: "low-delay" }),
      );
      if (reason === "waiting") media[0].dispatchEvent(new Event("waiting"));
      else if (reason === "hidden") {
        doc.visibilityState = "hidden";
        doc.dispatchEvent(new Event("visibilitychange"));
      } else if (reason === "disconnected") {
        peer.connectionState = "disconnected";
        peer.dispatchEvent(new Event("connectionstatechange"));
      } else {
        vi.spyOn(peer, "getStats").mockRejectedValue(
          new Error("Stats unavailable"),
        );
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(receivers.map((receiver) => receiver.jitterBufferTarget)).toEqual([
        null,
        null,
      ]);
      await vi.advanceTimersByTimeAsync(1000);
      if (reason !== "stats-failure")
        expect(onTelemetry).toHaveBeenLastCalledWith(
          expect.objectContaining({ playoutMode: "automatic" }),
        );
    },
  );
  it.each([
    "Xbox Wireless Controller",
    "DualSense Wireless Controller (Vendor: 054c Product: 0ce6)",
  ])(
    "preserves Xbox wire buttons, axis signs, deadzones and trigger tuning for standard %s",
    (id) => {
      const pad = {
        id,
        index: 0,
        connected: true,
        mapping: "standard",
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({
          pressed: false,
          value: 0,
        })),
      };
      vi.spyOn(navigator, "getGamepads").mockReturnValue([
        pad as unknown as Gamepad,
      ]);
      ready();
      engine.setControllerSettings({
        preferredControllerId: "",
        controllerDefaults: {
          ...defaultControllerTuning,
          stickDeadzone: 0.12,
          triggerRange: 0.5,
        },
        controllerProfiles: [],
      });
      pad.buttons[0] = { pressed: true, value: 1 }; // Xbox A / DualSense Cross
      pad.buttons[1] = { pressed: true, value: 1 }; // Xbox B / DualSense Circle
      pad.buttons[8] = pad.buttons[9] = { pressed: true, value: 1 };
      pad.buttons[6] = { pressed: false, value: 0.25 };
      pad.buttons[7] = { pressed: false, value: 0.5 };
      pad.axes = [0.05, -1, 1, -0.56];
      vi.advanceTimersByTime(4);
      const frame = frames().at(-1)!;
      expect(frame.getUint16(16, true)).toBe(2 | 16 | 32); // Nexus replaces View+Menu
      expect(frame.getInt16(18, true)).toBe(0);
      expect(frame.getInt16(20, true)).toBe(32767); // browser up is negative Y
      expect(frame.getInt16(22, true)).toBe(32767);
      expect(frame.getInt16(24, true)).toBe(16384);
      expect(frame.getUint16(26, true)).toBe(32768);
      expect(frame.getUint16(28, true)).toBe(65535);
    },
  );

  it("keeps startup-held face buttons, triggers and sticks neutral until released", () => {
    button = 1;
    trigger = 0.8;
    axis = 1;
    ready();
    vi.advanceTimersByTime(4);
    expect(frames().length).toBeGreaterThan(0);
    expect(
      frames().every(
        (frame) =>
          !a(frame) &&
          frame.getUint16(28, true) === 0 &&
          frame.getInt16(18, true) === 0,
      ),
    ).toBe(true);
    button = 0;
    trigger = 0;
    axis = 0;
    vi.advanceTimersByTime(4);
    button = 1;
    trigger = 0.8;
    axis = 1;
    vi.advanceTimersByTime(4);
    expect(a(frames().at(-1)!)).toBe(true);
    expect(frames().at(-1)!.getUint16(28, true)).toBeGreaterThan(0);
    expect(frames().at(-1)!.getInt16(18, true)).toBeGreaterThan(0);
  });

  it.each(["blur", "hidden", "capture"])(
    "requires physical release after %s without affecting fresh controls",
    (reason) => {
      ready();
      button = 1;
      trigger = 0.5;
      axis = 1;
      vi.advanceTimersByTime(4);
      if (reason === "blur") {
        focused = false;
        win.dispatchEvent(new Event("blur"));
      } else if (reason === "hidden") {
        doc.visibilityState = "hidden";
        doc.dispatchEvent(new Event("visibilitychange"));
      } else engine.setInputSuspended(true);
      if (reason === "blur") {
        focused = true;
        win.dispatchEvent(new Event("focus"));
      } else if (reason === "hidden") {
        doc.visibilityState = "visible";
        doc.dispatchEvent(new Event("visibilitychange"));
      } else engine.setInputSuspended(false);
      peer.channels.input.sent = [];
      vi.advanceTimersByTime(8);
      expect(frames().length).toBeGreaterThan(0);
      expect(
        frames().every(
          (frame) =>
            !a(frame) &&
            frame.getUint16(28, true) === 0 &&
            frame.getInt16(18, true) === 0,
        ),
      ).toBe(true);
      button = 0;
      trigger = 0;
      axis = 0;
      vi.advanceTimersByTime(4);
      button = 1;
      vi.advanceTimersByTime(4);
      expect(a(frames().at(-1)!)).toBe(true);
    },
  );

  it("handles same-ID same-index reconnect events with a release before new input", () => {
    ready();
    button = 1;
    vi.advanceTimersByTime(4);
    expect(a(frames().at(-1)!)).toBe(true);
    peer.channels.input.sent = [];
    // By the time the disconnect event runs, the snapshot may already expose
    // a replacement of the same model at its reused index.
    win.dispatchEvent(
      Object.assign(new Event("gamepaddisconnected"), {
        gamepad: { index: 0, id: padId },
      }),
    );
    expect(frames().length).toBeGreaterThan(0);
    expect(frames().every((frame) => !a(frame))).toBe(true);
    peer.channels.input.sent = [];
    vi.advanceTimersByTime(4);
    expect(frames().every((frame) => !a(frame))).toBe(true);
    button = 0;
    vi.advanceTimersByTime(4);
    button = 1;
    vi.advanceTimersByTime(4);
    expect(a(frames().at(-1)!)).toBe(true);
  });

  it("keeps unknown mappings neutral, reports unsupported once and allows keyboard input", () => {
    padMapping = "";
    button = 1;
    axis = 1;
    trigger = 1;
    ready();
    vi.advanceTimersByTime(100);
    expect(frames().length).toBeGreaterThan(0);
    expect(frames().every((frame) => !a(frame))).toBe(true);
    expect(onControllerStatus).toHaveBeenCalledTimes(1);
    expect(onControllerStatus).toHaveBeenCalledWith({
      state: "unsupported",
      label: "pad",
    });
    win.dispatchEvent(Object.assign(new Event("keydown"), { code: "Space" }));
    expect(a(frames().at(-1)!)).toBe(true);
    expect(onControlsShortcut).not.toHaveBeenCalled();
    padConnected = false;
    win.dispatchEvent(new Event("gamepaddisconnected"));
    expect(onControllerStatus).toHaveBeenLastCalledWith({
      state: "disconnected",
      label: "pad",
    });
  });

  it("uses only supported dual-rumble, clamps invalid magnitudes and bounds duration", () => {
    const haptics = actuator();
    vibrationActuator = haptics as unknown as GamepadHapticActuator;
    ready();
    rumble(255, 255, 60_000, 60_000);
    expect(haptics.playEffect).toHaveBeenCalledWith("dual-rumble", {
      startDelay: 0,
      duration: 5000,
      weakMagnitude: 1,
      strongMagnitude: 1,
    });
    haptics.effects = ["trigger-rumble"];
    rumble();
    expect(haptics.playEffect).toHaveBeenCalledTimes(1);
  });

  it("does not play rumble before handshake, while unfocused, hidden or captured", () => {
    const haptics = actuator();
    vibrationActuator = haptics as unknown as GamepadHapticActuator;
    rumble();
    expect(haptics.playEffect).not.toHaveBeenCalled();
    ready();
    focused = false;
    win.dispatchEvent(new Event("blur"));
    rumble();
    focused = true;
    win.dispatchEvent(new Event("focus"));
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    rumble();
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    engine.setInputSuspended(true);
    rumble();
    expect(haptics.playEffect).not.toHaveBeenCalled();
    engine.setInputSuspended(false);
    rumble();
    expect(haptics.playEffect).toHaveBeenCalledTimes(1);
  });

  it("uses controller rumble tuning and resets the previous device before a switch", () => {
    const first = actuator();
    const second = actuator();
    vibrationActuator = first as unknown as GamepadHapticActuator;
    ready();
    rumble();
    engine.setControllerSettings({
      preferredControllerId: "",
      controllerDefaults: { ...defaultControllerTuning, rumble: "low" },
      controllerProfiles: [],
    });
    expect(first.reset).toHaveBeenCalledTimes(1);
    padId = "DualSense Wireless Controller";
    padIndex = 1;
    vibrationActuator = second as unknown as GamepadHapticActuator;
    rumble(100, 100);
    expect(second.playEffect).toHaveBeenLastCalledWith(
      "dual-rumble",
      expect.objectContaining({ strongMagnitude: 0.45, weakMagnitude: 0.45 }),
    );
    engine.setControllerSettings({
      preferredControllerId: "",
      controllerDefaults: { ...defaultControllerTuning, rumble: "off" },
      controllerProfiles: [],
    });
    rumble();
    expect(second.reset).toHaveBeenCalledTimes(1);
    expect(second.playEffect).toHaveBeenCalledTimes(1);
  });

  it("stops legacy dual-rumble with a zero effect when reset is unavailable", () => {
    const legacy = {
      type: "dual-rumble",
      playEffect: vi.fn(async () => "complete"),
    };
    vibrationActuator = legacy as unknown as GamepadHapticActuator;
    ready();
    rumble();
    engine.setInputSuspended(true);
    expect(legacy.playEffect).toHaveBeenLastCalledWith("dual-rumble", {
      duration: 0,
      startDelay: 0,
      weakMagnitude: 0,
      strongMagnitude: 0,
    });
  });

  it.each(["blur", "hidden", "capture", "disconnect", "profile", "end"])(
    "resets an active rumble on %s",
    async (reason) => {
      const haptics = actuator();
      vibrationActuator = haptics as unknown as GamepadHapticActuator;
      ready();
      rumble();
      if (reason === "blur") {
        focused = false;
        win.dispatchEvent(new Event("blur"));
      } else if (reason === "hidden") {
        doc.visibilityState = "hidden";
        doc.dispatchEvent(new Event("visibilitychange"));
      } else if (reason === "capture") engine.setInputSuspended(true);
      else if (reason === "disconnect") {
        padConnected = false;
        win.dispatchEvent(new Event("gamepaddisconnected"));
      } else if (reason === "profile")
        engine.setControllerSettings({
          preferredControllerId: "",
          controllerDefaults: { ...defaultControllerTuning, rumble: "off" },
          controllerProfiles: [],
        });
      else engine.destroy();
      await Promise.resolve();
      expect(haptics.reset).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("preempts effects without replaying them after late completion", async () => {
    const haptics = actuator();
    let resolveOld!: (result: GamepadHapticsResult) => void;
    haptics.playEffect.mockImplementationOnce(
      () =>
        new Promise<GamepadHapticsResult>((resolve) => {
          resolveOld = resolve;
        }),
    );
    vibrationActuator = haptics as unknown as GamepadHapticActuator;
    ready();
    rumble();
    rumble(80);
    resolveOld("preempted");
    await Promise.resolve();
    expect(haptics.playEffect).toHaveBeenCalledTimes(2);
    engine.setInputSuspended(true);
    expect(haptics.reset).toHaveBeenCalledTimes(1);
  });

  it("absorbs synchronous and asynchronous haptics/reset failures", async () => {
    const haptics = actuator();
    vibrationActuator = haptics as unknown as GamepadHapticActuator;
    ready();
    haptics.playEffect.mockImplementationOnce(() => {
      throw new Error("unsupported");
    });
    expect(() => rumble()).not.toThrow();
    haptics.playEffect.mockRejectedValueOnce(new Error("disconnected"));
    rumble();
    haptics.reset.mockRejectedValueOnce(new Error("hidden"));
    focused = false;
    win.dispatchEvent(new Event("blur"));
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    focused = true;
    win.dispatchEvent(new Event("focus"));
    rumble();
    haptics.reset.mockImplementationOnce(() => {
      throw new Error("removed");
    });
    expect(() => engine.destroy()).not.toThrow();
  });

  it("requires playing video before reporting a successful stream", () => {
    ready();
    peer.connectionState = "connected";
    peer.dispatchEvent(new Event("connectionstatechange"));
    expect(onConnected).not.toHaveBeenCalled();
    media[0].dispatchEvent(new Event("playing"));
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
  it("keeps the startup deadline when video plays without the input handshake", async () => {
    media[0].dispatchEvent(new Event("playing"));
    expect(onConnected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("input connection timed out"),
    );
    expect(peer.closeCalls).toBe(1);
    ready();
    expect(onConnected).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it("reports playable readiness once when input becomes ready after video", () => {
    media[0].dispatchEvent(new Event("playing"));
    ready();
    ack();
    media[0].dispatchEvent(new Event("playing"));
    expect(onConnected).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onError).not.toHaveBeenCalled();
  });
  it.each(["waiting", "pause", "ended"])(
    "keeps startup pending if video enters %s before input readiness",
    (event) => {
      media[0].dispatchEvent(new Event("playing"));
      media[0].dispatchEvent(new Event(event));
      ready();
      expect(onConnected).not.toHaveBeenCalled();
      media[0].dispatchEvent(new Event("playing"));
      expect(onConnected).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["control", "input", "message"] as const)(
    "does not become playable without the %s channel",
    (missing) => {
      for (const name of ["control", "input", "message"] as const) {
        if (name !== missing) peer.channels[name].open();
      }
      ack();
      media[0].dispatchEvent(new Event("playing"));
      expect(onConnected).not.toHaveBeenCalled();
      peer.channels[missing].open();
      expect(onConnected).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["control", "input", "message"] as const)(
    "fails startup and cleans up once when required %s closes",
    (name) => {
      peer.channels[name].close();
      peer.channels[name].dispatchEvent(new Event("error"));
      media[0].dispatchEvent(new Event("playing"));
      ready();
      vi.advanceTimersByTime(60_000);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.stringContaining(name));
      expect(onConnected).not.toHaveBeenCalled();
      expect(onInterrupted).not.toHaveBeenCalled();
      expect(peer.closeCalls).toBe(1);
    },
  );
  it.each(["control", "input", "message"] as const)(
    "interrupts a playable stream and releases input once when required %s errors",
    (name) => {
      ready();
      media[0].dispatchEvent(new Event("playing"));
      button = 1;
      vi.advanceTimersByTime(4);
      peer.channels[name].dispatchEvent(new Event("error"));
      peer.channels[name].close();
      peer.dispatchEvent(new Event("connectionstatechange"));
      vi.advanceTimersByTime(60_000);
      expect(onInterrupted).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(frames().map(a)).toEqual([true, false]);
      expect(peer.closeCalls).toBe(1);
    },
  );
  it.each(["control", "input"] as const)(
    "fails startup if the %s initialization send throws",
    (name) => {
      peer.channels[name].failSend = true;
      media[0].dispatchEvent(new Event("playing"));
      ready();
      expect(onConnected).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(peer.closeCalls).toBe(1);
    },
  );
  it.each(["control", "input", "message"] as const)(
    "interrupts once when a playable stream's required %s channel closes",
    (name) => {
      ready();
      media[0].dispatchEvent(new Event("playing"));
      button = 1;
      vi.advanceTimersByTime(4);
      peer.channels[name].close();
      expect(onInterrupted).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(peer.closeCalls).toBe(1);
      expect(frames().map(a)).toEqual(
        name === "input" ? [true] : [true, false],
      );
    },
  );
  it("fails startup when the message handshake or configuration cannot be sent", () => {
    peer.channels.message.failSend = true;
    expect(() => ready()).not.toThrow();
    media[0].dispatchEvent(new Event("playing"));
    expect(onConnected).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(peer.closeCalls).toBe(1);
  });
  it("keeps optional chat closure independent and ignores all channels after destruction", () => {
    peer.channels.chat.close();
    ready();
    media[0].dispatchEvent(new Event("playing"));
    expect(onConnected).toHaveBeenCalledTimes(1);
    engine.destroy();
    engine.destroy();
    peer.channels.message.dispatchEvent(new Event("error"));
    expect(onError).not.toHaveBeenCalled();
    expect(onInterrupted).not.toHaveBeenCalled();
    expect(peer.closeCalls).toBe(1);
  });
  it("times out a transport that never delivers video", async () => {
    peer.connectionState = "connected";
    peer.dispatchEvent(new Event("connectionstatechange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onConnected).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("video connection timed out"),
    );
  });
  it("survives a transient transport disconnect within the grace window without expiring input", () => {
    ready();
    media[0].dispatchEvent(new Event("playing"));
    button = 1;
    vi.advanceTimersByTime(4);
    expect(frames().map(a)).toEqual([true]);

    peer.channels.input.bufferedAmount = 38;
    peer.connectionState = "disconnected";
    peer.dispatchEvent(new Event("connectionstatechange"));
    button = 0;
    vi.advanceTimersByTime(500);
    button = 1;
    vi.advanceTimersByTime(1000);
    expect(onError).not.toHaveBeenCalled();
    expect(onInterrupted).not.toHaveBeenCalled();

    peer.channels.input.bufferedAmount = 0;
    peer.connectionState = "connected";
    peer.dispatchEvent(new Event("connectionstatechange"));
    peer.channels.input.dispatchEvent(new Event("bufferedamountlow"));
    vi.advanceTimersByTime(8);
    expect(frames().at(-1)).toBeDefined();
    expect(a(frames().at(-1)!)).toBe(false);
    button = 0;
    vi.advanceTimersByTime(4);
    button = 1;
    vi.advanceTimersByTime(4);
    expect(a(frames().at(-1)!)).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(onInterrupted).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it("deduplicates transport failure and server disconnect for a session", () => {
    ready();
    media[0].dispatchEvent(new Event("playing"));
    peer.connectionState = "failed";
    peer.dispatchEvent(new Event("connectionstatechange"));
    peer.dispatchEvent(new Event("connectionstatechange"));
    peer.channels.message.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "TransactionStart",
          target:
            "/streaming/sessionLifetimeManagement/serverInitiatedDisconnect",
          id: "disconnect",
        }),
      }),
    );
    vi.advanceTimersByTime(60_000);
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
  it("waits for both input channels after an early handshake, and starts once", () => {
    peer.channels.message.open();
    expect(peer.channelOptions.input).toEqual({
      ordered: true,
      protocol: "1.0",
    });
    ack();
    expect(peer.channels.input.sent).toHaveLength(0);
    peer.channels.input.open();
    expect(peer.channels.input.sent).toHaveLength(0);
    peer.channels.control.open();
    expect(peer.channels.input.sent).toHaveLength(1);
    ack();
    expect(peer.channels.input.sent).toHaveLength(1);
  });
  it("captures a short press and release without a rendering frame", () => {
    ready();
    button = 1;
    vi.advanceTimersByTime(4);
    button = 0;
    vi.advanceTimersByTime(4);
    expect(frames().map(a)).toEqual([true, false]);
  });
  it("owns the controls chord edge without forwarding stick clicks", () => {
    ready();
    vi.advanceTimersByTime(4); // discover the controller with a neutral chord
    controlsShortcut = true;
    vi.advanceTimersByTime(4);
    expect(onControlsShortcut).toHaveBeenCalledTimes(1);
    expect(frames()).toHaveLength(1);
    expect(frames()[0].getUint16(16, true) & (16_384 | 32_768)).toBe(0);
    vi.advanceTimersByTime(8);
    expect(onControlsShortcut).toHaveBeenCalledTimes(1);
    controlsShortcut = false;
    vi.advanceTimersByTime(4);
    controlsShortcut = true;
    vi.advanceTimersByTime(4);
    expect(onControlsShortcut).toHaveBeenCalledTimes(2);
  });
  it.each(["blur", "hidden", "suspend"])(
    "requires chord release after %s before opening local controls",
    (reason) => {
      ready();
      vi.advanceTimersByTime(4);
      if (reason === "blur") {
        focused = false;
        win.dispatchEvent(new Event("blur"));
      } else if (reason === "hidden") {
        doc.visibilityState = "hidden";
        doc.dispatchEvent(new Event("visibilitychange"));
      } else engine.setInputSuspended(true);
      controlsShortcut = true;
      vi.advanceTimersByTime(100);
      expect(onControlsShortcut).not.toHaveBeenCalled();
      if (reason === "blur") {
        focused = true;
        win.dispatchEvent(new Event("focus"));
      } else if (reason === "hidden") {
        doc.visibilityState = "visible";
        doc.dispatchEvent(new Event("visibilitychange"));
      } else engine.setInputSuspended(false);
      vi.advanceTimersByTime(8);
      expect(onControlsShortcut).not.toHaveBeenCalled();
      controlsShortcut = false;
      vi.advanceTimersByTime(4);
      controlsShortcut = true;
      vi.advanceTimersByTime(4);
      expect(onControlsShortcut).toHaveBeenCalledTimes(1);
    },
  );
  it("suppresses a chord held on first discovery or same-index controller replacement", () => {
    ready();
    controlsShortcut = true;
    vi.advanceTimersByTime(4);
    expect(onControlsShortcut).not.toHaveBeenCalled();
    controlsShortcut = false;
    vi.advanceTimersByTime(4);
    padId = "Replacement pad";
    controlsShortcut = true;
    win.dispatchEvent(new Event("gamepadconnected"));
    vi.advanceTimersByTime(4);
    expect(onControlsShortcut).not.toHaveBeenCalled();
    controlsShortcut = false;
    vi.advanceTimersByTime(4);
    controlsShortcut = true;
    vi.advanceTimersByTime(4);
    expect(onControlsShortcut).toHaveBeenCalledTimes(1);
  });
  it("does not queue stale state, and retries a focus-loss release while unfocused", () => {
    ready();
    button = 1;
    vi.advanceTimersByTime(4);
    peer.channels.input.bufferedAmount = 38;
    focused = false;
    win.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(20);
    expect(frames().map(a)).toEqual([true]);
    peer.channels.input.bufferedAmount = 0;
    peer.channels.input.dispatchEvent(new Event("bufferedamountlow"));
    expect(frames().map(a)).toEqual([true, false]);
    vi.advanceTimersByTime(20);
    expect(frames().map(a)).toEqual([true, false]);
  });
  it("preserves both edges of a tap during congestion", () => {
    ready();
    peer.channels.input.bufferedAmount = 38;
    button = 1;
    vi.advanceTimersByTime(4);
    button = 0;
    vi.advanceTimersByTime(4);
    expect(frames()).toHaveLength(0);
    peer.channels.input.bufferedAmount = 0;
    vi.advanceTimersByTime(4);
    expect(frames().map(a)).toEqual([true, false]);
  });
  it("captures keyboard taps between polling ticks during congestion", () => {
    ready();
    peer.channels.input.bufferedAmount = 38;
    win.dispatchEvent(Object.assign(new Event("keydown"), { code: "Space" }));
    win.dispatchEvent(Object.assign(new Event("keyup"), { code: "Space" }));
    expect(frames()).toHaveLength(0);
    peer.channels.input.bufferedAmount = 0;
    peer.channels.input.dispatchEvent(new Event("bufferedamountlow"));
    expect(frames().map(a)).toEqual([true, false]);
  });
  it("preserves tuned short trigger pulls during congestion", () => {
    ready();
    engine.setControllerSettings({
      preferredControllerId: "",
      controllerDefaults: { ...defaultControllerTuning, triggerRange: 0.5 },
      controllerProfiles: [],
    });
    peer.channels.input.sent = [];
    peer.channels.input.bufferedAmount = 38;
    trigger = 0.25;
    vi.advanceTimersByTime(4);
    trigger = 0;
    vi.advanceTimersByTime(4);
    peer.channels.input.bufferedAmount = 0;
    peer.channels.input.dispatchEvent(new Event("bufferedamountlow"));
    expect(frames().map((frame) => frame.getUint16(28, true))).toEqual([
      32768, 0,
    ]);
  });
  it("coalesces intermediate travel while a trigger remains held", () => {
    ready();
    peer.channels.input.bufferedAmount = 38;
    for (const value of [0.2, 0.4, 0.7, 1]) {
      trigger = value;
      vi.advanceTimersByTime(4);
    }
    peer.channels.input.bufferedAmount = 0;
    peer.channels.input.dispatchEvent(new Event("bufferedamountlow"));
    expect(frames().map((frame) => frame.getUint16(28, true))).toEqual([65535]);
  });
  it("coalesces analog changes and uses only the newest axes for queued edges", () => {
    ready();
    peer.channels.input.bufferedAmount = 38;
    button = 1;
    axis = 0.5;
    vi.advanceTimersByTime(4);
    button = 0;
    axis = 0.8;
    vi.advanceTimersByTime(4);
    axis = -1;
    vi.advanceTimersByTime(4);
    peer.channels.input.bufferedAmount = 0;
    vi.advanceTimersByTime(4);
    expect(frames().map(a)).toEqual([true, false]);
    expect(frames().map((frame) => frame.getInt16(18, true))).toEqual([
      -32767, -32767,
    ]);
  });
  it("fails visibly on expired input and retries neutral even after failure", () => {
    ready();
    peer.channels.input.bufferedAmount = 38;
    button = 1;
    vi.advanceTimersByTime(4);
    button = 0;
    vi.advanceTimersByTime(260);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("250 ms"));
    expect(frames()).toHaveLength(0);
    peer.channels.input.bufferedAmount = 0;
    vi.advanceTimersByTime(50);
    expect(frames().map(a)).toEqual([false]);
    button = 1;
    axis = 1;
    win.dispatchEvent(Object.assign(new Event("keydown"), { code: "Space" }));
    peer.channels.input.dispatchEvent(new Event("bufferedamountlow"));
    vi.advanceTimersByTime(100);
    expect(frames().map(a)).toEqual([false]);
    expect(frames()[0].getUint16(16, true)).toBe(0);
    expect(frames()[0].getInt16(18, true)).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it("fails visibly at queue capacity instead of silently losing an edge", () => {
    ready();
    peer.channels.input.bufferedAmount = 38;
    for (let i = 0; i < 33; i++) {
      button = 1 - button;
      vi.advanceTimersByTime(4);
    }
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("32 queued"));
    peer.channels.input.bufferedAmount = 0;
    peer.channels.input.dispatchEvent(new Event("bufferedamountlow"));
    expect(frames().map(a)).toEqual([false]);
    button = 1;
    axis = 1;
    win.dispatchEvent(Object.assign(new Event("keydown"), { code: "Space" }));
    peer.channels.input.dispatchEvent(new Event("bufferedamountlow"));
    vi.advanceTimersByTime(100);
    expect(frames().map(a)).toEqual([false]);
    expect(frames()[0].getUint16(16, true)).toBe(0);
    expect(frames()[0].getInt16(18, true)).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it.each(["blur", "hidden", "suspend", "switch"] as const)(
    "clears queued taps on %s and sends neutral before resumed input",
    (reason) => {
      ready();
      peer.channels.input.bufferedAmount = 38;
      button = 1;
      vi.advanceTimersByTime(4);
      button = 0;
      vi.advanceTimersByTime(4);
      if (reason === "blur") {
        focused = false;
        win.dispatchEvent(new Event("blur"));
      } else if (reason === "hidden") {
        doc.visibilityState = "hidden";
        doc.dispatchEvent(new Event("visibilitychange"));
      } else if (reason === "suspend") {
        engine.setInputSuspended(true);
      } else {
        padIndex = 1;
        vi.advanceTimersByTime(4);
      }
      peer.channels.input.bufferedAmount = 0;
      peer.channels.input.dispatchEvent(new Event("bufferedamountlow"));
      expect(frames().every((frame) => !a(frame))).toBe(true);
      expect(frames().length).toBeGreaterThan(0);
      expect(onError).not.toHaveBeenCalled();
    },
  );
  it("applies playback preferences immediately without restarting transport", () => {
    ready();
    expect(media[0].style.objectFit).toBe("contain");
    expect(
      (media[0] as unknown as HTMLVideoElement).disablePictureInPicture,
    ).toBe(true);
    expect(
      (media[0] as unknown as HTMLVideoElement).disableRemotePlayback,
    ).toBe(true);
    engine.setPlaybackSettings({
      volume: 0.35,
      muted: true,
      videoFit: "fill",
      inputPolling: "efficient",
    });
    expect(media[0].style.objectFit).toBe("cover");
    expect(media[1].volume).toBe(0.35);
    expect(media[1].muted).toBe(true);
    button = 1;
    vi.advanceTimersByTime(4);
    expect(frames()).toHaveLength(0);
    vi.advanceTimersByTime(4);
    expect(frames().map(a)).toEqual([true]);
    engine.setPlaybackSettings({
      volume: 1,
      muted: false,
      videoFit: "fit",
      inputPolling: "responsive",
    });
    button = 0;
    vi.advanceTimersByTime(4);
    expect(frames().map(a)).toEqual([true, false]);
    expect(
      peer.channels.input.sent.filter(
        (frame) => frame instanceof DataView && frame.byteLength === 15,
      ),
    ).toHaveLength(1);
  });
  it("updates controller mappings live and releases the previous mapping", () => {
    ready();
    button = 1;
    vi.advanceTimersByTime(4);
    engine.setControllerSettings({
      preferredControllerId: "",
      controllerDefaults: {
        ...defaultControllerTuning,
        buttonLayout: "swap-ab",
      },
      controllerProfiles: [],
    });
    expect(frames().map(a)).toEqual([true, false]);
    vi.advanceTimersByTime(4);
    expect(frames().map(a)).toEqual([true, false, false]);
    expect(frames().at(-1)!.getUint16(16, true) & 32).toBe(0);
    button = 0;
    vi.advanceTimersByTime(4);
    button = 1;
    vi.advanceTimersByTime(4);
    expect(frames().at(-1)!.getUint16(16, true) & 32).toBe(32);
  });
  it("does not release held input for unrelated settings changes", () => {
    ready();
    button = 1;
    vi.advanceTimersByTime(4);
    engine.setControllerSettings({
      preferredControllerId: "",
      controllerDefaults: { ...defaultControllerTuning },
      controllerProfiles: [],
    });
    expect(frames().map(a)).toEqual([true]);
  });
  it.each([1, 0.4])(
    "does not restart polling for cloned playback settings or volume-only updates (%s)",
    (volume) => {
      ready();
      button = 1;
      vi.advanceTimersByTime(2);
      engine.setPlaybackSettings({
        volume,
        muted: false,
        videoFit: "fit",
        inputPolling: "responsive",
      });
      engine.setControllerSettings({
        preferredControllerId: "",
        controllerDefaults: { ...defaultControllerTuning },
        controllerProfiles: [],
      });
      vi.advanceTimersByTime(2);
      expect(frames().map(a)).toEqual([true]);
      expect(media[1].volume).toBe(volume);
    },
  );
  it("slows polling without a controller and wakes keyboard input immediately", () => {
    ready();
    const poll = vi.spyOn(navigator, "getGamepads").mockReturnValue([]);
    vi.advanceTimersByTime(4);
    poll.mockClear();
    vi.advanceTimersByTime(48);
    expect(poll).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(poll).toHaveBeenCalledTimes(1);
    win.dispatchEvent(Object.assign(new Event("keydown"), { code: "Space" }));
    expect(a(frames().at(-1)!)).toBe(true);
    poll.mockClear();
    vi.advanceTimersByTime(4);
    expect(poll).toHaveBeenCalledTimes(1);
  });
  it("reports only real drop/freeze counters using the shared telemetry fields", async () => {
    peer.stats.set("v", {
      id: "v",
      type: "inbound-rtp",
      kind: "video",
      freezeCount: 3,
      totalFreezesDuration: 0.4,
      framesDropped: 7,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTelemetry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        framesDropped: 7,
        freezeCount: 3,
        freezeDurationMs: 400,
        frameIntervalP95Ms: undefined,
        frameIntervalP99Ms: undefined,
      }),
    );
  });
  it("keeps unavailable WebRTC measurements unknown in the actual telemetry callback", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTelemetry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        framesPerSecond: undefined,
        roundTripMs: undefined,
        packetLossPercent: undefined,
        bitrateMbps: undefined,
        codec: undefined,
        videoDecoder: undefined,
        networkQuality: "measuring",
        inputQueueBytes: 0,
      }),
    );
  });

  it("establishes a baseline and rejects counter resets without inventing healthy zero loss", async () => {
    const video = {
      id: "v",
      type: "inbound-rtp",
      kind: "video",
      framesPerSecond: 60,
      bytesReceived: 1000,
      packetsReceived: 100,
      packetsLost: 0,
    };
    peer.stats.set("v", video);
    peer.stats.set("t", {
      id: "t",
      type: "transport",
      selectedCandidatePairId: "p",
    });
    peer.stats.set("p", {
      id: "p",
      type: "candidate-pair",
      currentRoundTripTime: 0,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTelemetry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        roundTripMs: 0,
        packetLossPercent: undefined,
        bitrateMbps: undefined,
        networkQuality: "measuring",
      }),
    );
    peer.stats.set("v", {
      ...video,
      bytesReceived: 501000,
      packetsReceived: 200,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTelemetry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        roundTripMs: 0,
        packetLossPercent: 0,
        bitrateMbps: 4,
        networkQuality: "excellent",
      }),
    );
    peer.stats.set("v", { ...video, bytesReceived: 1, packetsReceived: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTelemetry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        packetLossPercent: undefined,
        bitrateMbps: undefined,
        networkQuality: "measuring",
      }),
    );
  });
  it("publishes presentation cadence and cancels frame observation on destruction", async () => {
    media[0].frameCallback!(0, {
      presentationTime: 0,
    } as VideoFrameCallbackMetadata);
    media[0].frameCallback!(16, {
      presentationTime: 16,
    } as VideoFrameCallbackMetadata);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTelemetry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        frameIntervalP95Ms: 16,
        frameIntervalP99Ms: 16,
      }),
    );
    engine.destroy();
    expect(media[0].cancelledCallback).toBe(3);
    media[0].frameCallback!(32, {
      presentationTime: 32,
    } as VideoFrameCallbackMetadata);
    expect(media[0].frameCallbackCount).toBe(3);
  });
  it("discards a congested backlog on cleanup and ignores later drain events", () => {
    ready();
    peer.channels.input.bufferedAmount = 38;
    button = 1;
    vi.advanceTimersByTime(4);
    button = 0;
    vi.advanceTimersByTime(4);
    engine.destroy();
    const count = frames().length;
    peer.channels.input.bufferedAmount = 0;
    peer.channels.input.dispatchEvent(new Event("bufferedamountlow"));
    win.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(1000);
    expect(frames()).toHaveLength(count);
    expect(onError).not.toHaveBeenCalled();
  });
  it("stops hidden polling but retries neutral and resumes promptly on visibility", () => {
    ready();
    const poll = vi.spyOn(navigator, "getGamepads");
    vi.advanceTimersByTime(4);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    poll.mockClear();
    vi.advanceTimersByTime(1000);
    expect(poll).not.toHaveBeenCalled();
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(4);
    expect(poll).toHaveBeenCalledTimes(2); // one neutral prime + first active tick
  });
  it("keeps overlays neutral and stops polling after destruction", () => {
    ready();
    button = 1;
    vi.advanceTimersByTime(4);
    engine.setInputSuspended(true);
    vi.advanceTimersByTime(20);
    expect(frames().map(a)).toEqual([true, false]);
    engine.destroy();
    const count = frames().length;
    vi.advanceTimersByTime(100);
    expect(frames()).toHaveLength(count);
  });
});
