import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFiniteAnimationsToSettle } from "../e2e/animation-settling";

function controlledAnimation() {
  let playState: AnimationPlayState = "running";
  let replaceState: AnimationReplaceState = "active";
  let rejectFinished!: (reason: unknown) => void;
  const finished = new Promise<unknown>((_, reject) => {
    rejectFinished = reject;
  });

  return {
    animation: {
      get playState() {
        return playState;
      },
      get replaceState() {
        return replaceState;
      },
      effect: {
        getComputedTiming: () => ({ endTime: 150 }),
      },
      finished,
    },
    cancel() {
      playState = "idle";
      rejectFinished(new DOMException("Animation canceled", "AbortError"));
    },
    replace() {
      replaceState = "removed";
      rejectFinished(new DOMException("Animation replaced", "AbortError"));
    },
    reject(error: unknown) {
      rejectFinished(error);
    },
  };
}

describe("accessibility animation settling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tolerates canceled and replaced finite animations", async () => {
    const canceled = controlledAnimation();
    vi.stubGlobal("document", {
      getAnimations: () => [canceled.animation],
    });
    const canceledWait = waitForFiniteAnimationsToSettle();
    canceled.cancel();
    await expect(canceledWait).resolves.toBeUndefined();

    const replaced = controlledAnimation();
    vi.stubGlobal("document", {
      getAnimations: () => [replaced.animation],
    });
    const replacedWait = waitForFiniteAnimationsToSettle();
    replaced.replace();
    await expect(replacedWait).resolves.toBeUndefined();
  });

  it("surfaces unrelated animation failures", async () => {
    const failed = controlledAnimation();
    vi.stubGlobal("document", {
      getAnimations: () => [failed.animation],
    });
    const failedWait = waitForFiniteAnimationsToSettle();
    failed.reject(new Error("Unexpected animation failure"));
    await expect(failedWait).rejects.toThrow("Unexpected animation failure");

    const stillRunning = controlledAnimation();
    vi.stubGlobal("document", {
      getAnimations: () => [stillRunning.animation],
    });
    const stillRunningWait = waitForFiniteAnimationsToSettle();
    stillRunning.reject(new DOMException("Unrelated abort", "AbortError"));
    await expect(stillRunningWait).rejects.toThrow("Unrelated abort");
  });
});
