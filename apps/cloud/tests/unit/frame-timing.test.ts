import { expect, it } from "vitest";
import { FrameTimingTracker } from "../../src/renderer/stream/frame-timing";

const frame = (count: number, receiveTime = count * 33) =>
  ({
    presentedFrames: count,
    receiveTime,
    mediaTime: count * 0.033,
    processingDuration: 0.002,
    presentationTime: receiveTime + 20,
    expectedDisplayTime: receiveTime + 30,
  }) as VideoFrameCallbackMetadata;

it("separates arrival, source, decoding, presentation and callback delays", () => {
  const tracker = new FrameTimingTracker();
  tracker.add(60, frame(1));
  tracker.add(120, frame(2, 80));
  expect(tracker.snapshot()).toEqual({
    observedFrames: 2,
    receiveIntervalP95Ms: 47,
    mediaIntervalP95Ms: 33,
    decodeP95Ms: 2,
    receiveToPresentationP95Ms: 20,
    presentationLeadP95Ms: 10,
    callbackLatenessP95Ms: 10,
  });
  expect(tracker.snapshot()).toBeUndefined();
  tracker.add(130, frame(4));
  expect(tracker.snapshot()?.receiveIntervalP95Ms).toBeUndefined();
  tracker.reset();
  tracker.add(200, frame(5));
  expect(tracker.snapshot()?.mediaIntervalP95Ms).toBeUndefined();
});

it("bounds stalled telemetry and leaves absent metadata unavailable", () => {
  const tracker = new FrameTimingTracker();
  for (let i = 0; i < 1000; i++)
    tracker.add(i, { presentedFrames: i } as VideoFrameCallbackMetadata);
  expect(tracker.snapshot()).toEqual({ observedFrames: 600 });
});

it("retains signed presentation lead when submission misses expected display", () => {
  const tracker = new FrameTimingTracker();
  tracker.add(100, {
    ...frame(1),
    presentationTime: 90,
    expectedDisplayTime: 80,
  });
  expect(tracker.snapshot()?.presentationLeadP95Ms).toBe(-10);
});
