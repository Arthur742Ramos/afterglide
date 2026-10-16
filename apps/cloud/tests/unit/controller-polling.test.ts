import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControllerNavigationInput,
  createControllerPolling,
} from "../../src/renderer/hooks/controller-polling";
import type { GamepadLike } from "../../src/renderer/stream/controller-input";

function clock() {
  return {
    requestFrame: (callback: (now: number) => void) =>
      Number(setTimeout(() => callback(Date.now()), 16)),
    cancelFrame: (handle: number) => clearTimeout(handle),
    setTimer: (callback: () => void, delay: number) =>
      Number(setTimeout(callback, delay)),
    clearTimer: (handle: number) => clearTimeout(handle),
    now: () => Date.now(),
  };
}

function gamepad(
  pressed: number[] = [],
  id = "Xbox controller",
  index = 0,
  axes = [0, 0],
): GamepadLike {
  return {
    id,
    index,
    connected: true,
    mapping: "standard",
    axes,
    buttons: Array.from({ length: 17 }, (_, index) => ({
      pressed: pressed.includes(index),
      value: pressed.includes(index) ? 1 : 0,
    })),
  };
}

afterEach(() => vi.useRealTimers());

describe("controller polling scheduling", () => {
  it("bounds discovery and eliminates unfocused callbacks against the former frame loop", () => {
    vi.useFakeTimers();
    const taskClock = clock();
    let previousCallbacks = 0;
    let previousFrame = 0;
    // The former hook always requested another frame, including its inactive
    // branch. This deterministic 16ms clock measures scheduling, not CPU/latency.
    const formerPoll = () => {
      previousCallbacks += 1;
      previousFrame = taskClock.requestFrame(formerPoll);
    };
    previousFrame = taskClock.requestFrame(formerPoll);
    vi.advanceTimersByTime(10_000);
    expect(previousCallbacks).toBe(625);
    taskClock.cancelFrame(previousFrame);

    let focused = true;
    const sample = vi.fn(() => false);
    const polling = createControllerPolling(
      taskClock,
      () => focused,
      sample,
      vi.fn(),
    );
    polling.refresh();
    vi.advanceTimersByTime(10_000);
    expect(sample).toHaveBeenCalledTimes(41); // one immediate + 40 discovery
    expect(vi.getTimerCount()).toBe(1);

    focused = false;
    polling.refresh();
    sample.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(sample).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    polling.dispose();
  });

  it("polls an active controller every frame and immediately handles hotplug", () => {
    vi.useFakeTimers();
    let connected = false;
    const sample = vi.fn(() => connected);
    const polling = createControllerPolling(
      clock(),
      () => true,
      sample,
      vi.fn(),
    );
    polling.refresh();
    vi.advanceTimersByTime(20);
    expect(sample).toHaveBeenCalledTimes(1);
    connected = true;
    polling.refresh(); // gamepadconnected, before the discovery timer expires
    expect(sample).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(32);
    expect(sample).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);
    connected = false;
    polling.refresh(); // gamepaddisconnected switches back to discovery
    vi.advanceTimersByTime(249);
    expect(sample).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(1);
    expect(sample).toHaveBeenCalledTimes(6);
    polling.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels frames on blur/hidden and reseeds held actions on resume", () => {
    vi.useFakeTimers();
    let visible = true;
    let focused = true;
    let pad = gamepad();
    const input = new ControllerNavigationInput();
    const actions: string[] = [];
    const sample = vi.fn((now: number) => {
      actions.push(...input.actions(pad, now));
      return true;
    });
    const suspend = vi.fn(() => input.reset());
    const polling = createControllerPolling(
      clock(),
      () => visible && focused,
      sample,
      suspend,
    );
    polling.refresh();
    focused = false;
    polling.refresh();
    pad = gamepad([0]);
    vi.advanceTimersByTime(1000);
    expect(actions).toEqual([]);
    expect(sample).toHaveBeenCalledTimes(1);
    expect(suspend).toHaveBeenCalledTimes(1);
    focused = true;
    polling.refresh();
    vi.advanceTimersByTime(32);
    expect(actions).toEqual([]);
    pad = gamepad();
    vi.advanceTimersByTime(16);
    pad = gamepad([0]);
    vi.advanceTimersByTime(16);
    expect(actions).toEqual(["accept"]);
    visible = false;
    polling.refresh();
    expect(vi.getTimerCount()).toBe(0);
    expect(suspend).toHaveBeenCalledTimes(2);
    polling.dispose();
  });

  it("does no work on an inactive mount or after disposal", () => {
    vi.useFakeTimers();
    const sample = vi.fn(() => true);
    const polling = createControllerPolling(
      clock(),
      () => false,
      sample,
      vi.fn(),
    );
    polling.refresh();
    vi.advanceTimersByTime(1000);
    expect(sample).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    polling.dispose();
    polling.refresh();
    expect(sample).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detects inactive state even if its lifecycle event was missed", () => {
    vi.useFakeTimers();
    let active = true;
    const sample = vi.fn(() => true);
    const suspend = vi.fn();
    const polling = createControllerPolling(
      clock(),
      () => active,
      sample,
      suspend,
    );
    polling.refresh();
    active = false;
    vi.advanceTimersByTime(1000);
    expect(sample).toHaveBeenCalledTimes(1);
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    polling.dispose();
  });
  it("keeps diagnostics at 125ms while active and stops them when hidden", () => {
    vi.useFakeTimers();
    let active = true;
    const sample = vi.fn(() => true);
    const polling = createControllerPolling(
      clock(),
      () => active,
      sample,
      vi.fn(),
      125,
    );
    polling.refresh();
    vi.advanceTimersByTime(1000);
    expect(sample).toHaveBeenCalledTimes(9);
    active = false;
    polling.refresh();
    sample.mockClear();
    vi.advanceTimersByTime(1000);
    expect(sample).not.toHaveBeenCalled();
    polling.dispose();
  });
});

describe("physical controller navigation edges", () => {
  it("does not interpret raw mappings as standard navigation", () => {
    const input = new ControllerNavigationInput();
    expect(
      input.actions(
        { ...gamepad([0, 1, 12], undefined, undefined, [1, 1]), mapping: "" },
        0,
      ),
    ).toEqual([]);
    expect(input.actions({ ...gamepad([0, 12]), mapping: "" }, 16)).toEqual([]);
    expect(input.actions(gamepad([0]), 32)).toEqual([]);
    input.actions(gamepad(), 48);
    expect(input.actions(gamepad([0]), 64)).toEqual(["accept"]);
  });
  it("does not accept when Back is released while both buttons were held on mount or refocus", () => {
    const input = new ControllerNavigationInput();
    for (const reset of [false, true]) {
      if (reset) input.reset();
      expect(input.actions(gamepad([0, 1]), 0)).toEqual([]);
      expect(input.actions(gamepad([0]), 16)).toEqual([]);
      expect(input.actions(gamepad(), 32)).toEqual([]);
      expect(input.actions(gamepad([0]), 48)).toEqual(["accept"]);
    }
  });

  it("keeps an already-held Accept suppressed when Back masks it and is released", () => {
    const input = new ControllerNavigationInput();
    input.actions(gamepad(), 0);
    expect(input.actions(gamepad([0]), 16)).toEqual(["accept"]);
    expect(input.actions(gamepad([0, 1]), 32)).toEqual(["back"]);
    expect(input.actions(gamepad([0]), 48)).toEqual([]);
    input.actions(gamepad(), 64);
    expect(input.actions(gamepad([0]), 80)).toEqual(["accept"]);
  });

  it.each([
    [0, "accept"],
    [1, "back"],
    [4, "shoulder-left"],
    [5, "shoulder-right"],
  ] as const)(
    "requires release for held button %i (%s) on mount and reset",
    (button, action) => {
      const input = new ControllerNavigationInput();
      expect(input.actions(gamepad([button]), 0)).toEqual([]);
      expect(input.actions(gamepad([button]), 1000)).toEqual([]);
      input.actions(gamepad(), 1016);
      expect(input.actions(gamepad([button]), 1032)).toEqual([action]);
      input.reset(); // blur/refocus or a newly mounted navigation scope
      expect(input.actions(gamepad([button]), 1048)).toEqual([]);
    },
  );

  it("suppresses confirmation from a different controller at the same index", () => {
    const input = new ControllerNavigationInput();
    input.actions(gamepad(), 0);
    expect(
      input.actions(gamepad([0], "Replacement controller", 0), 16),
    ).toEqual([]);
    input.actions(gamepad([], "Replacement controller", 0), 32);
    expect(
      input.actions(gamepad([0], "Replacement controller", 0), 48),
    ).toEqual(["accept"]);
    expect(input.actions(gamepad([1], "Another controller", 0), 64)).toEqual(
      [],
    );
  });

  it("handles disconnect/reconnect and index changes with a fresh held-button latch", () => {
    const input = new ControllerNavigationInput();
    input.actions(gamepad(), 0);
    expect(input.actions(undefined, 16)).toEqual([]);
    expect(input.actions(gamepad([1]), 32)).toEqual([]);
    input.actions(gamepad(), 48);
    expect(input.actions(gamepad([0], "Xbox controller", 1), 64)).toEqual([]);
  });

  it("keeps directional repeat timing and back priority over accept", () => {
    const input = new ControllerNavigationInput();
    expect(input.actions(gamepad([15]), 0)).toEqual(["right"]);
    expect(input.actions(gamepad([15]), 359)).toEqual([]);
    expect(input.actions(gamepad([15]), 360)).toEqual(["right"]);
    expect(input.actions(gamepad([15]), 454)).toEqual([]);
    expect(input.actions(gamepad([15]), 455)).toEqual(["right"]);
    input.actions(gamepad(), 470);
    expect(input.actions(gamepad([0, 1]), 486)).toEqual(["back"]);
  });

  it("prefers dpad to analog direction and clears repeats on controller replacement", () => {
    const input = new ControllerNavigationInput();
    expect(
      input.actions(gamepad([12], undefined, undefined, [1, 0]), 0),
    ).toEqual(["up"]);
    expect(input.actions(gamepad([], "Second pad", 0, [1, 0]), 16)).toEqual([
      "right",
    ]);
    expect(input.actions(gamepad([], "Second pad", 0, [1, 0]), 360)).toEqual(
      [],
    );
    expect(input.actions(gamepad([], "Second pad", 0, [1, 0]), 376)).toEqual([
      "right",
    ]);
  });
});
