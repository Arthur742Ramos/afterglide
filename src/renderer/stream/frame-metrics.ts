import type { StreamTelemetry } from "../../shared/contracts";
import type { MediaCounters } from "./media-metrics";

type FrameMetrics = Pick<
  StreamTelemetry,
  | "frameIntervalP95Ms"
  | "frameIntervalP99Ms"
  | "framesDropped"
  | "freezeCount"
  | "freezeDurationMs"
>;

/** Accumulate real counters across receiver changes/resets, never negative deltas. */
class SessionCounter {
  private previous?: number;
  private source?: string;
  private total = 0;

  update(value: unknown, source: string, include = true): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      return undefined;
    const delta =
      this.source !== source ||
      this.previous === undefined ||
      value < this.previous
        ? value
        : value - this.previous;
    if (include) this.total += delta;
    this.source = source;
    this.previous = value;
    return this.total;
  }
}

/** Browser presentation cadence, not display/photon or input-to-photon latency. */
export class FrameMetricsTracker {
  private intervals: number[] = [];
  private previousPresentation?: number;
  private callbackId?: number;
  private stopped = false;
  private visible = true;
  private skipFreezeCountDelta = false;
  private skipFreezeDurationDelta = false;
  private dropSource?: "quality" | "stats";
  private drops = new SessionCounter();
  private freezes = new SessionCounter();
  private freezeDuration = new SessionCounter();

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly windowSize = 600,
  ) {}

  start(visible: boolean): void {
    this.visible = visible;
    this.schedule();
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.previousPresentation = undefined;
    // Exclude the stats interval spanning a visibility change as well.
    this.skipFreezeCountDelta = true;
    this.skipFreezeDurationDelta = true;
  }

  stop(): void {
    this.stopped = true;
    if (this.callbackId !== undefined)
      this.video.cancelVideoFrameCallback?.(this.callbackId);
    this.callbackId = undefined;
    this.previousPresentation = undefined;
    this.intervals = [];
  }

  snapshot(report?: MediaCounters): FrameMetrics {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const percentile = (p: number) =>
      sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : undefined;
    let qualityDrops: number | undefined;
    try {
      qualityDrops = this.video.getVideoPlaybackQuality?.().droppedVideoFrames;
    } catch {
      // Some embedded media implementations expose an unsupported method.
    }
    const useQuality =
      typeof qualityDrops === "number" &&
      Number.isFinite(qualityDrops) &&
      qualityDrops >= 0;
    if (!this.dropSource) {
      if (useQuality) this.dropSource = "quality";
      else if (
        typeof report?.framesDropped === "number" &&
        Number.isFinite(report.framesDropped) &&
        report.framesDropped >= 0
      )
        this.dropSource = "stats";
    }
    const source = String(report?.id ?? "video");
    const result: FrameMetrics = {
      frameIntervalP95Ms: percentile(0.95),
      frameIntervalP99Ms: percentile(0.99),
      framesDropped: this.drops.update(
        this.dropSource === "quality" ? qualityDrops : report?.framesDropped,
        this.dropSource === "quality" ? "playback-quality" : source,
      ),
      freezeCount: this.freezes.update(
        report?.freezeCount,
        source,
        this.visible && !this.skipFreezeCountDelta,
      ),
      freezeDurationMs: this.freezeDuration.update(
        report?.totalFreezesDuration,
        source,
        this.visible && !this.skipFreezeDurationDelta,
      ),
    };
    if (result.freezeDurationMs !== undefined) result.freezeDurationMs *= 1000;
    // Keep the exclusion until real counters establish a new baseline.
    if (
      typeof report?.freezeCount === "number" &&
      Number.isFinite(report.freezeCount) &&
      report.freezeCount >= 0
    )
      this.skipFreezeCountDelta = false;
    if (
      typeof report?.totalFreezesDuration === "number" &&
      Number.isFinite(report.totalFreezesDuration) &&
      report.totalFreezesDuration >= 0
    )
      this.skipFreezeDurationDelta = false;
    return result;
  }

  private schedule(): void {
    if (
      this.stopped ||
      typeof this.video.requestVideoFrameCallback !== "function"
    )
      return;
    this.callbackId = this.video.requestVideoFrameCallback((_now, metadata) => {
      if (this.stopped) return;
      if (this.visible) {
        const time = metadata.presentationTime;
        if (Number.isFinite(time)) {
          if (
            this.previousPresentation !== undefined &&
            time > this.previousPresentation
          ) {
            this.intervals.push(time - this.previousPresentation);
            if (this.intervals.length > this.windowSize) this.intervals.shift();
          }
          this.previousPresentation = time;
        }
      }
      this.schedule();
    });
  }
}
