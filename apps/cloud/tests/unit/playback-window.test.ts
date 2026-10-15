import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { observePlaybackWindow } from "../../src/main/playback-window";
import type { PlaybackWindowState } from "../../src/shared/contracts";

function setup(backgroundTest = false) {
  const state = {
    visible: true,
    minimized: false,
    focused: true,
    destroyed: false,
    throttled: true,
  };
  const window = Object.assign(new EventEmitter(), {
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFocused: () => state.focused,
    isDestroyed: () => state.destroyed,
    webContents: {
      isDestroyed: () => state.destroyed,
      getBackgroundThrottling: () => state.throttled,
      setBackgroundThrottling: vi.fn((allowed: boolean) => {
        state.throttled = allowed;
      }),
    },
  });
  const power = new EventEmitter();
  const publish = vi.fn<(state: PlaybackWindowState) => void>();
  const observer = observePlaybackWindow(
    window as never,
    power as never,
    publish,
    backgroundTest,
  );
  return { state, window, power, publish, observer };
}

describe("visible stream rendering policy", () => {
  it("disables throttling only during visible active playback and avoids duplicate writes", () => {
    const { state, window, observer } = setup();
    expect(state.throttled).toBe(true);
    observer.setPhase("provisioning");
    expect(state.throttled).toBe(true);
    for (const phase of ["negotiating", "streaming", "recovering"] as const) {
      observer.setPhase(phase);
      expect(state.throttled).toBe(false);
    }
    expect(window.webContents.setBackgroundThrottling).toHaveBeenCalledTimes(1);
    observer.setPhase("idle");
    expect(state.throttled).toBe(true);
    observer.setPhase("streaming");
    observer.setPhase("error");
    expect(state.throttled).toBe(true);
  });
  it("keeps visible video unthrottled on blur and refreshes state after fullscreen transitions", () => {
    const { state, window, publish, observer } = setup();
    observer.setPhase("streaming");
    state.focused = false;
    window.emit("blur");
    expect(state.throttled).toBe(false);
    expect(publish.mock.lastCall?.[0].focused).toBe(false);
    state.visible = false;
    window.emit("leave-full-screen");
    expect(state.throttled).toBe(true);
    state.visible = true;
    window.emit("enter-full-screen");
    expect(state.throttled).toBe(false);
  });
  it("restores throttling on minimize, hide, screen lock and suspend, then resumes", () => {
    const { state, window, power, publish, observer } = setup();
    observer.setPhase("streaming");
    for (const [field, off, on, value] of [
      ["visible", "hide", "show", false],
      ["minimized", "minimize", "restore", true],
    ] as const) {
      state[field] = value;
      window.emit(off);
      expect(state.throttled).toBe(true);
      state[field] = !value;
      window.emit(on);
      expect(state.throttled).toBe(false);
    }
    for (const [off, on, field] of [
      ["lock-screen", "unlock-screen", "screenLocked"],
      ["suspend", "resume", "suspended"],
    ] as const) {
      power.emit(off);
      expect(state.throttled).toBe(true);
      expect(publish.mock.lastCall?.[0][field]).toBe(true);
      power.emit(on);
      expect(state.throttled).toBe(false);
    }
    observer.dispose();
    expect(power.eventNames()).toEqual([]);
    expect(window.eventNames()).toEqual([]);
    const calls = publish.mock.calls.length;
    observer.setPhase("idle");
    expect(publish).toHaveBeenCalledTimes(calls);
  });
  it("preserves offscreen test rendering without misreporting native visibility", () => {
    const { state, window, publish, observer } = setup(true);
    state.visible = false;
    window.emit("hide");
    observer.setPhase("streaming");
    expect(state.throttled).toBe(false);
    expect(publish.mock.lastCall?.[0].visible).toBe(false);
    state.destroyed = true;
    expect(() => observer.setPhase("idle")).not.toThrow();
    observer.dispose();
  });
});
