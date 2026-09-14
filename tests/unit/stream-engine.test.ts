import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XboxStreamEngine } from "../../src/renderer/stream/stream-engine";
import { defaultControllerTuning } from "../../src/shared/contracts";

class Channel extends EventTarget {
  readyState = "connecting";
  bufferedAmount = 0;
  sent: unknown[] = [];
  send(value: unknown) {
    this.sent.push(value);
  }
  close() {
    this.readyState = "closed";
  }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
}
class Peer extends EventTarget {
  channels: Record<string, Channel> = {};
  iceGatheringState = "complete";
  connectionState = "new";
  createDataChannel(name: string) {
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
    return [];
  }
  async getStats() {
    return new Map();
  }
  close() {}
}
class Media extends EventTarget {
  setAttribute() {}
}
let peer: Peer;
let engine: XboxStreamEngine;
let onConnected = vi.fn<() => void>();
let onError = vi.fn<(message: string) => void>();
let media: Media[];
let focused: boolean;
let button: number;
let win: EventTarget;
let doc: EventTarget & { visibilityState: string };

beforeEach(async () => {
  vi.useFakeTimers();
  focused = true;
  button = 0;
  peer = new Peer();
  media = [];
  onConnected = vi.fn();
  onError = vi.fn();
  win = Object.assign(new EventTarget(), {
    setInterval,
    setTimeout,
    afterglide: {
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
    getGamepads: () => [
      {
        id: "pad",
        index: 0,
        connected: true,
        mapping: "standard",
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, (_, i) => ({
          value: i === 0 ? button : 0,
          pressed: i === 0 && button > 0,
        })),
      },
    ],
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
    onInterrupted() {},
    onError,
    onTelemetry() {},
    onControllerStatus() {},
  });
  await engine.connect();
});
afterEach(() => {
  engine.destroy();
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

describe("real stream engine input lifecycle", () => {
  it("requires playing video before reporting a successful stream", () => {
    peer.connectionState = "connected";
    peer.dispatchEvent(new Event("connectionstatechange"));
    expect(onConnected).not.toHaveBeenCalled();
    media[0].dispatchEvent(new Event("playing"));
    expect(onConnected).toHaveBeenCalledTimes(1);
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
  it("waits for both input channels after an early handshake, and starts once", () => {
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
  it("sends the latest state after congestion instead of replaying old movement", () => {
    ready();
    peer.channels.input.bufferedAmount = 38;
    button = 1;
    vi.advanceTimersByTime(4);
    button = 0;
    vi.advanceTimersByTime(4);
    expect(frames()).toHaveLength(0);
    peer.channels.input.bufferedAmount = 0;
    vi.advanceTimersByTime(4);
    expect(frames().map(a)).toEqual([false]);
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
