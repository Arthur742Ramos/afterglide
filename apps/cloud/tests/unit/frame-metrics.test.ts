import { describe, expect, it, vi } from "vitest";
import { FrameMetricsTracker } from "../../src/renderer/stream/frame-metrics";

function setup(windowSize = 600) {
  let callback: VideoFrameRequestCallback;
  let id = 0;
  const video = {
    requestVideoFrameCallback: vi.fn((next: VideoFrameRequestCallback) => {
      callback = next;
      return ++id;
    }),
    cancelVideoFrameCallback: vi.fn(),
  };
  const tracker = new FrameMetricsTracker(
    video as unknown as HTMLVideoElement,
    windowSize,
  );
  tracker.start(true);
  return {
    tracker,
    video,
    present: (time: number) =>
      callback(time, { presentationTime: time } as VideoFrameCallbackMetadata),
  };
}

describe("browser presentation and real media counters", () => {
  it("uses deterministic nearest-rank p95/p99 in a bounded rolling window", () => {
    const { tracker, present } = setup(100);
    let time = 0;
    present(time);
    for (let interval = 1; interval <= 100; interval++) {
      time += interval;
      present(time);
    }
    expect(tracker.snapshot()).toMatchObject({
      frameIntervalP95Ms: 95,
      frameIntervalP99Ms: 99,
    });
    for (let i = 0; i < 100; i++) {
      time += 16;
      present(time);
    }
    expect(tracker.snapshot()).toMatchObject({
      frameIntervalP95Ms: 16,
      frameIntervalP99Ms: 16,
    });
  });
  it("keeps visible presentation stalls in cadence without inventing freeze counters", () => {
    const { tracker, present } = setup();
    present(0);
    present(16);
    present(1016);
    expect(tracker.snapshot()).toMatchObject({
      frameIntervalP95Ms: 1000,
      frameIntervalP99Ms: 1000,
    });
    expect(tracker.snapshot().freezeCount).toBeUndefined();
    expect(tracker.snapshot().framesDropped).toBeUndefined();
  });
  it("excludes hidden gaps and the real-counter interval spanning visibility changes", () => {
    const { tracker, present } = setup();
    present(0);
    present(16);
    tracker.snapshot({ id: "v", freezeCount: 2, totalFreezesDuration: 1 });
    tracker.setVisible(false);
    present(1000);
    tracker.snapshot({ id: "v", freezeCount: 4, totalFreezesDuration: 5 });
    tracker.setVisible(true);
    present(10000);
    present(10016);
    expect(
      tracker.snapshot({ id: "v", freezeCount: 5, totalFreezesDuration: 6 }),
    ).toMatchObject({
      frameIntervalP95Ms: 16,
      freezeCount: 2,
      freezeDurationMs: 1000,
    });
    expect(
      tracker.snapshot({ id: "v", freezeCount: 6, totalFreezesDuration: 6.5 }),
    ).toMatchObject({
      freezeCount: 3,
      freezeDurationMs: 1500,
    });
  });
  it("keeps missing APIs undefined, without synthetic zero metrics", () => {
    const tracker = new FrameMetricsTracker({} as HTMLVideoElement);
    tracker.start(true);
    expect(
      Object.values(tracker.snapshot()).every((value) => value === undefined),
    ).toBe(true);
    tracker.stop();
  });
  it("accumulates real stats across counter resets and receiver changes", () => {
    const { tracker } = setup();
    expect(
      tracker.snapshot({
        id: "v",
        framesDropped: 4,
        freezeCount: 2,
        totalFreezesDuration: 0.5,
      }),
    ).toMatchObject({
      framesDropped: 4,
      freezeCount: 2,
      freezeDurationMs: 500,
    });
    expect(
      tracker.snapshot({
        id: "v",
        framesDropped: 6,
        freezeCount: 3,
        totalFreezesDuration: 1,
      }),
    ).toMatchObject({
      framesDropped: 6,
      freezeCount: 3,
      freezeDurationMs: 1000,
    });
    expect(
      tracker.snapshot({
        id: "v",
        framesDropped: 1,
        freezeCount: 1,
        totalFreezesDuration: 0.2,
      }),
    ).toMatchObject({
      framesDropped: 7,
      freezeCount: 4,
      freezeDurationMs: 1200,
    });
    expect(
      tracker.snapshot({
        id: "new",
        framesDropped: 2,
        freezeCount: 1,
        totalFreezesDuration: 0.3,
      }),
    ).toMatchObject({
      framesDropped: 9,
      freezeCount: 5,
      freezeDurationMs: 1500,
    });
    expect(tracker.snapshot({ id: "new" }).freezeCount).toBeUndefined();
  });
  it("uses playback-quality drops preferentially and tolerates counter resets", () => {
    let dropped = 5;
    const tracker = new FrameMetricsTracker({
      getVideoPlaybackQuality: () => ({ droppedVideoFrames: dropped }),
    } as HTMLVideoElement);
    expect(
      tracker.snapshot({ id: "v", framesDropped: 100 }).framesDropped,
    ).toBe(5);
    dropped = 7;
    expect(tracker.snapshot().framesDropped).toBe(7);
    dropped = 1;
    expect(tracker.snapshot().framesDropped).toBe(8);
  });
  it("does not switch counter sources and double count when an API disappears", () => {
    const quality = vi.fn(() => ({ droppedVideoFrames: 5 }));
    const tracker = new FrameMetricsTracker({
      getVideoPlaybackQuality: quality,
    } as unknown as HTMLVideoElement);
    expect(tracker.snapshot({ id: "v", framesDropped: 7 }).framesDropped).toBe(
      5,
    );
    quality.mockImplementationOnce(() => {
      throw new Error("unsupported");
    });
    expect(
      tracker.snapshot({ id: "v", framesDropped: 8 }).framesDropped,
    ).toBeUndefined();
    quality.mockReturnValue({ droppedVideoFrames: 6 });
    expect(tracker.snapshot({ id: "v", framesDropped: 9 }).framesDropped).toBe(
      6,
    );
  });
  it("handles independently supported freeze counters after visibility changes", () => {
    const { tracker } = setup();
    tracker.snapshot({ id: "v", freezeCount: 2 });
    tracker.setVisible(false);
    tracker.setVisible(true);
    expect(tracker.snapshot({ id: "v", freezeCount: 5 }).freezeCount).toBe(2);
    const metrics = tracker.snapshot({ id: "v", freezeCount: 6 });
    expect(metrics.freezeCount).toBe(3);
    expect(metrics.freezeDurationMs).toBeUndefined();
  });
  it("rejects non-finite and negative real counters", () => {
    const { tracker } = setup();
    const metrics = tracker.snapshot({
      id: "v",
      framesDropped: Number.NaN,
      freezeCount: -1,
      totalFreezesDuration: Number.POSITIVE_INFINITY,
    });
    expect(metrics.framesDropped).toBeUndefined();
    expect(metrics.freezeCount).toBeUndefined();
    expect(metrics.freezeDurationMs).toBeUndefined();
  });
  it("cancels the latest callback and rejects late callbacks after cleanup", () => {
    const { tracker, video, present } = setup();
    present(0);
    present(16);
    tracker.stop();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(3);
    const scheduled = video.requestVideoFrameCallback.mock.calls.length;
    present(32);
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(scheduled);
    expect(tracker.snapshot().frameIntervalP95Ms).toBeUndefined();
  });
});
