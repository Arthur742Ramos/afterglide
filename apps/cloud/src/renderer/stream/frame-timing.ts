import type { FrameTiming } from "../../shared/contracts";

type Metric = Exclude<keyof FrameTiming, "observedFrames">;

/** Bounded, per-telemetry-window timings for observed presented frames only. */
export class FrameTimingTracker {
  private values: Partial<Record<Metric, number[]>> = {};
  private observedFrames = 0;
  private previous?: VideoFrameCallbackMetadata;

  reset(): void {
    this.values = {};
    this.observedFrames = 0;
    this.previous = undefined;
  }

  add(now: number, frame: VideoFrameCallbackMetadata): void {
    this.observedFrames = Math.min(this.observedFrames + 1, 600);
    const previous = this.previous;
    // A skipped callback provides no observation of intervening frame timing.
    if (previous && frame.presentedFrames - previous.presentedFrames === 1) {
      if (frame.receiveTime !== undefined && previous.receiveTime !== undefined)
        this.record(
          "receiveIntervalP95Ms",
          frame.receiveTime - previous.receiveTime,
        );
      this.record(
        "mediaIntervalP95Ms",
        (frame.mediaTime - previous.mediaTime) * 1000,
      );
    }
    if (frame.processingDuration !== undefined)
      this.record("decodeP95Ms", frame.processingDuration * 1000);
    if (frame.receiveTime !== undefined)
      this.record(
        "receiveToPresentationP95Ms",
        frame.presentationTime - frame.receiveTime,
      );
    this.record(
      "presentationLeadP95Ms",
      frame.expectedDisplayTime - frame.presentationTime,
    );
    if (Number.isFinite(now) && Number.isFinite(frame.expectedDisplayTime))
      this.record(
        "callbackLatenessP95Ms",
        Math.max(0, now - frame.expectedDisplayTime),
      );
    this.previous = frame;
  }

  snapshot(): FrameTiming | undefined {
    if (!this.observedFrames) return undefined;
    const result: FrameTiming = { observedFrames: this.observedFrames };
    for (const [key, values] of Object.entries(this.values)) {
      values.sort((a, b) => a - b);
      result[key as Metric] = values[Math.ceil(values.length * 0.95) - 1];
    }
    this.values = {};
    this.observedFrames = 0;
    return result;
  }

  private record(key: Metric, value: number): void {
    if (
      !Number.isFinite(value) ||
      value < (key === "presentationLeadP95Ms" ? -60_000 : 0) ||
      value > 60_000
    )
      return;
    const values = this.values[key] ?? (this.values[key] = []);
    if (values.length < 600) values.push(value);
  }
}
