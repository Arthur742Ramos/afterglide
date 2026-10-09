import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamRecovery } from "../../src/renderer/recovery";

function setup(retry = vi.fn(async () => "replacement")) {
  const onRecovered = vi.fn();
  const onState = vi.fn();
  const onAttempt = vi.fn();
  const recovery = new StreamRecovery({
    retry,
    onRecovered,
    onState,
    onAttempt,
  });
  recovery.begin();
  return { recovery, retry, onRecovered, onState, onAttempt };
}

describe("renderer recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("deduplicates interruptions without moving the pending deadline", async () => {
    const { recovery, retry } = setup();
    recovery.interrupt("first");
    await vi.advanceTimersByTimeAsync(600);
    recovery.interrupt("first");
    await vi.advanceTimersByTimeAsync(100);
    expect(retry).toHaveBeenCalledTimes(1);
    recovery.interrupt("first");
    await vi.runAllTimersAsync();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("bounds retries even when provisioning succeeds then video repeatedly drops", async () => {
    const { recovery, retry, onState } = setup();
    for (let i = 0; i < 4; i++) {
      recovery.interrupt(`session-${i}`);
      await vi.runAllTimersAsync();
    }
    expect(retry).toHaveBeenCalledTimes(3);
    expect(onState).toHaveBeenLastCalledWith({
      status: "exhausted",
      attempts: 3,
    });
    recovery.setOnline(false);
    recovery.setOnline(true);
    await vi.runAllTimersAsync();
    expect(retry).toHaveBeenCalledTimes(3);
  });

  it("backs off after rejected attempts and stops at the same budget", async () => {
    const retry = vi.fn(async (): Promise<string> => {
      throw new Error("offline");
    });
    const { recovery, onState } = setup(retry);
    recovery.interrupt("first");
    await vi.advanceTimersByTimeAsync(700);
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_399);
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(retry).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_800);
    expect(retry).toHaveBeenCalledTimes(3);
    expect(onState).toHaveBeenLastCalledWith({
      status: "exhausted",
      attempts: 3,
    });
  });

  it("pauses offline without spending attempts and resumes online within budget", async () => {
    const { recovery, retry, onState } = setup();
    recovery.interrupt("first");
    await vi.advanceTimersByTimeAsync(600);
    recovery.setOnline(false);
    await vi.runAllTimersAsync();
    expect(retry).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith({
      status: "offline",
      attempts: 0,
    });
    recovery.setOnline(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("cancels scheduled work and ignores later online/interruption events", async () => {
    const { recovery, retry } = setup();
    recovery.interrupt("first");
    recovery.cancel();
    recovery.setOnline(true);
    recovery.interrupt("late");
    await vi.runAllTimersAsync();
    expect(retry).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])(
    "ignores stale in-flight %s after exit and a new launch",
    async (result) => {
      let resolve!: (value: string) => void;
      let reject!: (error: Error) => void;
      const retry = vi.fn(
        () =>
          new Promise<string>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      const { recovery, onRecovered } = setup(retry);
      recovery.interrupt("first");
      await vi.advanceTimersByTimeAsync(700);
      recovery.cancel();
      recovery.begin();
      if (result === "resolve") resolve("stale");
      else reject(new Error("stale"));
      await vi.runAllTimersAsync();
      expect(onRecovered).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledTimes(1);
    },
  );
});
