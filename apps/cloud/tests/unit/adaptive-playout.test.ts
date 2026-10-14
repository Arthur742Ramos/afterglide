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
