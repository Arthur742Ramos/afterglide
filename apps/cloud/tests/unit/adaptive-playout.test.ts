import { describe, expect, it } from "vitest";
import {
  AdaptivePlayoutPolicy,
  applyPlayoutTarget,
} from "../../src/renderer/stream/adaptive-playout";

const healthy = { jitterMs: 2, packetLossPercent: 0, roundTripMs: 35 };
const video = (second: number) => ({
  id: "video",
  timestamp: second * 1000,
  framesDecoded: second * 60,
  freezeCount: 0,
  framesDropped: 0,
});

function settled() {
  const policy = new AdaptivePlayoutPolicy();
  for (let second = 0; second <= 11; second++)
    policy.update(video(second), healthy, second * 1000);
  expect(policy.target).toBe(0);
  return policy;
}

describe("adaptive video playout", () => {
  it("starts with browser buffering and waits ten measured healthy seconds", () => {
    const policy = new AdaptivePlayoutPolicy();
    expect(policy.target).toBeNull();
    for (let second = 0; second <= 10; second++) {
      policy.update(video(second), healthy, second * 1000);
      expect(policy.target).toBeNull();
    }
    policy.update(video(11), healthy, 11_000);
    expect(policy.target).toBe(0);
  });

  it.each([
    { ...healthy, jitterMs: 20 },
    { ...healthy, packetLossPercent: 3 },
    { ...healthy, roundTripMs: 150 },
    { ...healthy, jitterMs: undefined },
    { ...healthy, packetLossPercent: undefined },
    { ...healthy, roundTripMs: Number.NaN },
    { ...healthy, jitterMs: -1 },
  ])(
    "immediately restores automatic buffering for unhealthy or unknown measurements %j",
    (measurements) => {
      const policy = settled();
      policy.update(video(12), measurements, 12_000);
      expect(policy.target).toBeNull();
      for (let second = 13; second <= 22; second++) {
        policy.update(video(second), healthy, second * 1000);
        expect(policy.target).toBeNull();
      }
      policy.update(video(23), healthy, 23_000);
      expect(policy.target).toBe(0);
    },
  );

  it.each([
    { ...video(12), framesDecoded: 660 },
    { ...video(12), framesDecoded: 0 },
    { ...video(12), freezeCount: 1 },
    { ...video(12), framesDropped: 1 },
    { ...video(12), timestamp: 11_000 },
    { ...video(12), id: "replacement" },
    { ...video(12), framesDecoded: undefined },
    { ...video(12), timestamp: undefined },
  ])(
    "does not classify frozen, reset, stale or incomplete media as healthy %j",
    (sample) => {
      const policy = settled();
      policy.update(sample, healthy, 12_000);
      expect(policy.target).toBeNull();
    },
  );

  it("backs off low-delay re-entry after media glitches and clears backoff on reset", () => {
    const policy = settled();
    policy.update({ ...video(12), framesDropped: 1 }, healthy, 12_000);
    expect(policy.target).toBeNull();
    for (let second = 13; second <= 32; second++) {
      policy.update(
        { ...video(second), framesDropped: 1 },
        healthy,
        second * 1000,
      );
      expect(policy.target).toBeNull();
    }
    policy.update({ ...video(33), framesDropped: 1 }, healthy, 33_000);
    expect(policy.target).toBe(0);
    policy.reset();
    for (let second = 0; second <= 10; second++)
      policy.update(video(second), healthy, second * 1000);
    policy.update(video(11), healthy, 11_000);
    expect(policy.target).toBe(0);
  });

  it("does not count missing or delayed observations as sustained healthy playback", () => {
    const policy = settled();
    policy.update(video(16), healthy, 16_000);
    expect(policy.target).toBeNull();
    policy.update(undefined, healthy, 17_000);
    expect(policy.target).toBeNull();
    policy.update(video(18), healthy, 18_000);
    expect(policy.target).toBeNull();
  });

  it("preserves bounded backoff through repeated waits and missing observations", () => {
    const policy = settled();
    let second = 11;
    for (const duration of [20, 40, 80, 80]) {
      policy.suspend(true);
      policy.suspend(true);
      policy.update(undefined, healthy, ++second * 1000);
      policy.suspend();
      // First advancing pair establishes a fresh healthy window.
      policy.update(video(++second), healthy, second * 1000);
      policy.update(video(++second), healthy, second * 1000);
      for (let elapsed = 1; elapsed < duration; elapsed++) {
        policy.update(video(++second), healthy, second * 1000);
        expect(policy.target).toBeNull();
      }
      policy.update(video(++second), healthy, second * 1000);
      expect(policy.target).toBe(0);
    }
    policy.reset();
    for (let elapsed = 0; elapsed <= 11; elapsed++)
      policy.update(video(elapsed), healthy, elapsed * 1000);
    expect(policy.target).toBe(0);
  });

  it("does not penalize deliberate pause or visibility suspension", () => {
    const policy = settled();
    policy.suspend();
    for (let second = 12; second <= 22; second++) {
      policy.update(video(second), healthy, second * 1000);
      expect(policy.target).toBeNull();
    }
    policy.update(video(23), healthy, 23_000);
    expect(policy.target).toBe(0);
  });

  it("resets the healthy window when playback waits or becomes hidden", () => {
    const policy = settled();
    policy.reset();
    expect(policy.target).toBeNull();
    policy.update(video(12), healthy, 12_000);
    expect(policy.target).toBeNull();
  });

  it("does not repeatedly write the target and tolerates unsupported setters", () => {
    let target: number | null = null;
    let writes = 0;
    const receiver = {
      get jitterBufferTarget() {
        return target;
      },
      set jitterBufferTarget(value: number | null) {
        target = value;
        writes++;
      },
    };
    applyPlayoutTarget(receiver as RTCRtpReceiver, null);
    applyPlayoutTarget(receiver as RTCRtpReceiver, 0);
    applyPlayoutTarget(receiver as RTCRtpReceiver, 0);
    applyPlayoutTarget(receiver as RTCRtpReceiver, null);
    expect(writes).toBe(2);
    expect(() => applyPlayoutTarget({} as RTCRtpReceiver, null)).not.toThrow();
    const throwing = Object.defineProperty({}, "jitterBufferTarget", {
      get: () => 0,
      set: () => {
        throw new Error("unsupported");
      },
    });
    expect(() =>
      applyPlayoutTarget(throwing as RTCRtpReceiver, null),
    ).not.toThrow();
  });
});

describe("Smooth playout", () => {
  it("requires sustained disturbances, caps at 100 ms and recovers slowly", () => {
    const policy = new AdaptivePlayoutPolicy();
    policy.setMode("smooth");
    policy.update(video(0), healthy, 0);
    expect(policy.target).toBeNull();
    policy.update(video(1), healthy, 1000);
    expect(policy.target).toBe(33);
    for (let second = 2; second <= 3; second++) {
      policy.update(
        video(second),
        { ...healthy, packetLossPercent: 5 },
        second * 1000,
      );
      expect(policy.target).toBe(33);
    }
    policy.update(video(4), { ...healthy, packetLossPercent: 5 }, 4000);
    expect(policy.target).toBe(67);
    for (let second = 5; second < 9; second++) {
      policy.update(
        video(second),
        { ...healthy, packetLossPercent: 5 },
        second * 1000,
      );
      expect(policy.target).toBe(67);
    }
    for (let second = 9; second <= 40; second++) {
      policy.update(
        video(second),
        { ...healthy, packetLossPercent: 5 },
        second * 1000,
      );
      expect(policy.target).toBe(100);
    }
    for (let second = 41; second <= 55; second++) {
      policy.update(video(second), healthy, second * 1000);
      expect(policy.target).toBe(100);
    }
    policy.update(video(56), healthy, 56000);
    expect(policy.target).toBe(67);
    for (let second = 57; second <= 71; second++)
      policy.update(video(second), healthy, second * 1000);
    expect(policy.target).toBe(33);
    for (let second = 72; second <= 86; second++)
      policy.update(video(second), healthy, second * 1000);
    expect(policy.target).toBe(16);
    policy.setMode("automatic");
    expect(policy.target).toBeNull();
    for (let second = 102; second <= 113; second++)
      policy.update(video(second), healthy, second * 1000);
    expect(policy.target).toBe(0);
  });
  it.each([
    "missing",
    "stale",
    "reset",
    "replaced",
    "gap",
    "unknown",
    "hidden",
  ])("discards %s observations without inflating the target", (reason) => {
    const policy = new AdaptivePlayoutPolicy();
    policy.setMode("smooth");
    policy.update(video(0), healthy, 0);
    policy.update(video(1), healthy, 1000);
    if (reason === "hidden") policy.suspend();
    else
      policy.update(
        reason === "missing"
          ? undefined
          : {
              ...video(2),
              ...(reason === "stale" ? { timestamp: 1000 } : {}),
              ...(reason === "reset" ? { framesDecoded: 0 } : {}),
              ...(reason === "replaced" ? { id: "new" } : {}),
            },
        reason === "unknown"
          ? { ...healthy, packetLossPercent: undefined }
          : healthy,
        reason === "gap" ? 5000 : 2000,
      );
    expect(policy.target).toBeNull();
    policy.update(video(10), healthy, 10000);
    policy.update(video(11), healthy, 11000);
    expect(policy.target).toBe(33);
  });
  it("does not raise buffering for high RTT alone or a single jitter spike", () => {
    const policy = new AdaptivePlayoutPolicy();
    policy.setMode("smooth");
    for (let second = 0; second < 40; second++)
      policy.update(
        video(second),
        { ...healthy, roundTripMs: 180, jitterMs: second === 5 ? 20 : 2 },
        second * 1000,
      );
    expect(policy.target).toBe(16);
  });
  it("backs down on the observed 30 FPS, 15 ms jitter route despite local presentation drops", () => {
    const policy = new AdaptivePlayoutPolicy();
    policy.setMode("smooth");
    for (let second = 0; second <= 10; second++)
      policy.update(
        video(second),
        { ...healthy, packetLossPercent: 5 },
        second * 1000,
      );
    expect(policy.target).toBe(100);
    // Same receiver, advancing 30 FPS, stable transport, one presentation drop/s.
    for (let second = 11; second <= 57; second++)
      policy.update(
        { ...video(second), framesDecoded: 600 + (second - 10) * 30 },
        {
          jitterMs: 15,
          packetLossPercent: 0,
          roundTripMs: 152,
          framesDropped: second,
        },
        second * 1000,
      );
    expect(policy.target).toBe(16);
  });
  it("holds in the neutral jitter band and requires a fresh continuous stable window", () => {
    const policy = new AdaptivePlayoutPolicy();
    policy.setMode("smooth");
    for (let second = 0; second <= 10; second++)
      policy.update(video(second), { ...healthy, jitterMs: 40 }, second * 1000);
    expect(policy.target).toBe(100);
    for (let second = 11; second <= 50; second++)
      policy.update(video(second), { ...healthy, jitterMs: 25 }, second * 1000);
    expect(policy.target).toBe(100);
    for (let second = 51; second <= 65; second++)
      policy.update(video(second), healthy, second * 1000);
    expect(policy.target).toBe(100);
    policy.update(video(66), healthy, 66000);
    expect(policy.target).toBe(67);
  });
  it("still responds to receiver drops and does not use missing observations to drain the buffer", () => {
    const policy = new AdaptivePlayoutPolicy();
    policy.setMode("smooth");
    for (let second = 0; second <= 10; second++)
      policy.update(
        { ...video(second), framesDropped: second },
        healthy,
        second * 1000,
      );
    expect(policy.target).toBe(100);
    policy.update(undefined, healthy, 11_000);
    policy.update(video(100), healthy, 100_000);
    expect(policy.target).toBeNull();
    policy.update(video(101), healthy, 101_000);
    expect(policy.target).toBe(100);
    for (let second = 102; second <= 116; second++)
      policy.update(video(second), healthy, second * 1000);
    expect(policy.target).toBe(67);
  });
  it("distinguishes accepted, unsupported, ignored and throwing setters", () => {
    expect(
      applyPlayoutTarget({ jitterBufferTarget: null } as RTCRtpReceiver, 67),
    ).toBe(true);
    expect(applyPlayoutTarget({} as RTCRtpReceiver, 67)).toBe(false);
    expect(
      applyPlayoutTarget(
        {
          get jitterBufferTarget() {
            return 0;
          },
          set jitterBufferTarget(_value: number | null) {},
        } as RTCRtpReceiver,
        67,
      ),
    ).toBe(false);
    expect(
      applyPlayoutTarget(
        Object.freeze({ jitterBufferTarget: null }) as RTCRtpReceiver,
        67,
      ),
    ).toBe(false);
  });
});
