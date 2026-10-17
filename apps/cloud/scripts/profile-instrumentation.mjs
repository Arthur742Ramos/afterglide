// Injected only by the opt-in profiler into disposable test profiles.
// Weak references prevent resource observation from keeping the resources alive.
export function installInstrumentation() {
  const original = {
    timeout: window.setTimeout.bind(window),
    interval: window.setInterval.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    clearInterval: window.clearInterval.bind(window),
    frame: window.requestAnimationFrame.bind(window),
    cancelFrame: window.cancelAnimationFrame.bind(window),
    add: EventTarget.prototype.addEventListener,
    remove: EventTarget.prototype.removeEventListener,
    gamepads: navigator.getGamepads.bind(navigator),
  };
  const timers = new Map();
  const frames = new Set();
  const listeners = new WeakMap();
  const peers = [];
  const tracks = [];
  const channels = [];
  const elements = new Map();
  const calls = { timers: 0, timerTicks: 0, frames: 0, gamepads: 0 };
  const state = { pad: undefined, holdIce: false };
  for (const kind of ["timeout", "interval"]) {
    window[kind === "timeout" ? "setTimeout" : "setInterval"] = (
      callback,
      delay,
      ...args
    ) => {
      if (typeof callback !== "function")
        return original[kind](callback, delay, ...args);
      calls.timers++;
      const id = original[kind](() => {
        calls.timerTicks++;
        if (kind === "timeout") timers.delete(id);
        callback(...args);
      }, delay);
      timers.set(id, { kind, delay: Number(delay) || 0 });
      return id;
    };
  }
  for (const kind of ["clearTimeout", "clearInterval"]) {
    window[kind] = (id) => {
      timers.delete(id);
      original[kind](id);
    };
  }
  window.requestAnimationFrame = (callback) => {
    calls.frames++;
    const id = original.frame((now) => {
      frames.delete(id);
      callback(now);
    });
    frames.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
    original.cancelFrame(id);
  };
  const key = (type, options) =>
    `${type}:${typeof options === "boolean" ? options : Boolean(options?.capture)}`;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    let events = listeners.get(this);
    if (!events) listeners.set(this, (events = new Map()));
    const name = key(type, options);
    if (!events.has(name)) events.set(name, new Set());
    if (listener) events.get(name).add(listener);
    return original.add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (
    type,
    listener,
    options,
  ) {
    listeners.get(this)?.get(key(type, options))?.delete(listener);
    return original.remove.call(this, type, listener, options);
  };
  Object.defineProperty(navigator, "getGamepads", {
    configurable: true,
    value: () => {
      calls.gamepads++;
      return state.pad ? [state.pad] : [];
    },
  });
  const NativePeer = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args);
      peers.push(new WeakRef(this));
      original.add.call(this, "track", (event) =>
        tracks.push(new WeakRef(event.track)),
      );
      if (state.holdIce)
        Object.defineProperty(this, "iceGatheringState", {
          get: () => "gathering",
        });
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args);
      channels.push(new WeakRef(channel));
      return channel;
    }
  };
  const live = (entries) => entries.flatMap((ref) => ref.deref() ?? []);
  const listenerCount = (target, type) => {
    let count = 0;
    for (const [name, values] of listeners.get(target) ?? [])
      if (!type || name.startsWith(`${type}:`)) count += values.size;
    return count;
  };
  window.__clientProfile = {
    state,
    rememberElement(name, selector) {
      const element = document.querySelector(selector);
      if (element) elements.set(name, new WeakRef(element));
    },
    sleep: (ms) => new Promise((resolve) => original.timeout(resolve, ms)),
    setPad(connected) {
      const previous = state.pad;
      state.pad = connected
        ? {
            id: "Synthetic standard controller",
            index: 0,
            connected: true,
            mapping: "standard",
            axes: [0, 0, 0, 0],
            buttons: Array.from({ length: 17 }, () => ({
              value: 0,
              pressed: false,
            })),
          }
        : undefined;
      const event = Object.assign(
        new Event(connected ? "gamepadconnected" : "gamepaddisconnected"),
        {
          gamepad: state.pad ?? previous,
        },
      );
      window.dispatchEvent(event);
    },
    snapshot() {
      const existing = live(peers);
      return {
        calls: { ...calls },
        timers: [...timers.values()],
        pendingFrames: frames.size,
        windowListeners: listenerCount(window),
        documentListeners: listenerCount(document),
        peerWrappers: existing.length,
        openPeers: existing.filter((peer) => peer.connectionState !== "closed")
          .length,
        iceListeners: existing.reduce(
          (total, peer) =>
            total + listenerCount(peer, "icegatheringstatechange"),
          0,
        ),
        latestPeerIceListeners: listenerCount(
          peers.at(-1)?.deref(),
          "icegatheringstatechange",
        ),
        liveTracks: live(tracks).filter((track) => track.readyState === "live")
          .length,
        openChannels: live(channels).filter(
          (channel) => channel.readyState !== "closed",
        ).length,
        mediaSinks: [...document.querySelectorAll("video,audio")].filter(
          (element) => element.srcObject,
        ).length,
        observedElements: Object.fromEntries(
          [...elements].map(([name, ref]) => {
            const element = ref.deref();
            return [
              name,
              {
                alive: Boolean(element),
                attached: element?.isConnected ?? false,
              },
            ];
          }),
        ),
        attachedElements: document.querySelectorAll("*").length,
      };
    },
    frameWindow(ms) {
      return new Promise((resolve) => {
        const intervals = [];
        let previous;
        let id;
        const tick = (now) => {
          if (previous !== undefined && intervals.length < 6000)
            intervals.push(now - previous);
          previous = now;
          id = original.frame(tick);
        };
        id = original.frame(tick);
        original.timeout(() => {
          original.cancelFrame(id);
          intervals.sort((a, b) => a - b);
          resolve({
            samples: intervals.length,
            p50Ms: intervals[Math.ceil(intervals.length * 0.5) - 1],
            p95Ms: intervals[Math.ceil(intervals.length * 0.95) - 1],
            maxMs: intervals.at(-1),
          });
        }, ms);
      });
    },
  };
}
