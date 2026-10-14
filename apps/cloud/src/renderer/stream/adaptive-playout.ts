import type { StreamTelemetry } from "../../shared/contracts";
import type { MediaCounters } from "./media-metrics";

export const PLAYOUT_POLICY = {
  healthyDurationMs: 10_000,
  maxBackoffExponent: 3,
  maxSampleGapMs: 2_500,
  maxHealthyJitterMs: 5,
  maxHealthyLossPercent: 0.5,
  maxHealthyRoundTripMs: 80,
} as const;

interface Baseline {
  id: string;
  timestamp: number;
  observedAt: number;
  frames: number;
  freezes?: number;
  dropped?: number;
  playbackDropped?: number;
}

/**
 * Automatic waits for healthy measurements before requesting low delay.
 * Smooth requests a bounded buffer and adjusts slowly after measured trends.
 * These receiver hints neither guarantee achieved delay nor change server bitrate.
 */
export class AdaptivePlayoutPolicy {
  target: number | null = null;
  private mode: "automatic" | "smooth" = "automatic";
  private smoothLevel = 0;
  private disturbedSince?: number;
  private lastIncrease?: number;

  setMode(mode: "automatic" | "smooth"): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.reset();
  }
  private baseline?: Baseline;
  private healthySince?: number;
  private mediaDisturbances = 0;

  reset(): void {
    this.suspend();
    this.mediaDisturbances = 0;
    this.smoothLevel = 0;
    this.lastIncrease = undefined;
  }

  /** Restart observations without forgetting earlier low-delay disturbances. */
  suspend(mediaDisturbance = false): void {
    this.automatic(mediaDisturbance);
    this.baseline = undefined;
  }

  private automatic(mediaDisturbance: boolean): void {
    // Only the first fallback from low delay counts, even across repeated waits.
    if (this.target === 0 && mediaDisturbance)
      this.mediaDisturbances = Math.min(
        PLAYOUT_POLICY.maxBackoffExponent,
        this.mediaDisturbances + 1,
      );
    this.target = null;
    this.healthySince = undefined;
    this.disturbedSince = undefined;
  }

  update(
    video: MediaCounters | undefined,
    telemetry: Pick<
      StreamTelemetry,
      "jitterMs" | "packetLossPercent" | "roundTripMs" | "framesDropped"
    >,
    observedAt: number,
  ): void {
    const timestamp = nonnegative(video?.timestamp);
    const frames = nonnegative(video?.framesDecoded);
    if (
      typeof video?.id !== "string" ||
      timestamp === undefined ||
      frames === undefined ||
      !Number.isFinite(observedAt)
    ) {
      this.suspend();
      return;
    }
    const current: Baseline = {
      id: video.id,
      timestamp,
      frames,
      observedAt,
      freezes: nonnegative(video.freezeCount),
      dropped: nonnegative(video.framesDropped),
      playbackDropped: nonnegative(telemetry.framesDropped),
    };
    const previous = this.baseline;
    this.baseline = current;
    if (this.mode === "smooth") {
      this.updateSmooth(current, previous, telemetry);
      return;
    }
    const mediaHealthy =
      previous !== undefined &&
      previous.id === current.id &&
      current.timestamp > previous.timestamp &&
      current.frames > previous.frames &&
      ((current.freezes === undefined && previous.freezes === undefined) ||
        (current.freezes !== undefined &&
          current.freezes === previous.freezes)) &&
      ((current.dropped === undefined && previous.dropped === undefined) ||
        (current.dropped !== undefined &&
          current.dropped === previous.dropped)) &&
      current.playbackDropped === previous.playbackDropped;
    const healthy =
      mediaHealthy &&
      observedAt > previous.observedAt &&
      observedAt - previous.observedAt <= PLAYOUT_POLICY.maxSampleGapMs &&
      within(telemetry.jitterMs, PLAYOUT_POLICY.maxHealthyJitterMs) &&
      within(
        telemetry.packetLossPercent,
        PLAYOUT_POLICY.maxHealthyLossPercent,
      ) &&
      within(telemetry.roundTripMs, PLAYOUT_POLICY.maxHealthyRoundTripMs);
    if (!healthy) {
      this.automatic(!mediaHealthy);
      return;
    }
    this.healthySince ??= observedAt;
    const requiredHealthyMs =
      PLAYOUT_POLICY.healthyDurationMs * 2 ** this.mediaDisturbances;
    if (observedAt - this.healthySince >= requiredHealthyMs) this.target = 0;
  }
  private updateSmooth(
    current: Baseline,
    previous: Baseline | undefined,
    telemetry: Pick<
      StreamTelemetry,
      "jitterMs" | "packetLossPercent" | "roundTripMs" | "framesDropped"
    >,
  ): void {
    // Unknown, stale, reset or replaced sources cannot establish a trend.
    const counters = [
      "frames",
      "freezes",
      "dropped",
      "playbackDropped",
    ] as const;
    if (
      !previous ||
      current.id !== previous.id ||
      current.timestamp <= previous.timestamp ||
      current.observedAt <= previous.observedAt ||
      current.observedAt - previous.observedAt >
        PLAYOUT_POLICY.maxSampleGapMs ||
      counters.some(
        (key) =>
          (current[key] === undefined) !== (previous[key] === undefined) ||
          (current[key] !== undefined &&
            previous[key] !== undefined &&
            current[key]! < previous[key]!),
      ) ||
      [
        telemetry.jitterMs,
        telemetry.packetLossPercent,
        telemetry.roundTripMs,
      ].some((value) => nonnegative(value) === undefined)
    ) {
      this.automatic(false);
      return;
    }
    const disturbed =
      current.frames === previous.frames ||
      counters.slice(1).some((key) => current[key] !== previous[key]) ||
      telemetry.jitterMs! > PLAYOUT_POLICY.maxHealthyJitterMs ||
      telemetry.packetLossPercent! > PLAYOUT_POLICY.maxHealthyLossPercent;
    // High RTT alone does not call for extra buffering.
    if (disturbed) {
      this.healthySince = undefined;
      this.disturbedSince ??= current.observedAt;
      if (
        current.observedAt - this.disturbedSince >= 2_000 &&
        (this.lastIncrease === undefined ||
          current.observedAt - this.lastIncrease >= 5_000)
      ) {
        this.smoothLevel = Math.min(2, this.smoothLevel + 1);
        this.lastIncrease = current.observedAt;
        this.disturbedSince = current.observedAt;
      }
    } else {
      this.disturbedSince = undefined;
      this.healthySince ??= current.observedAt;
      if (current.observedAt - this.healthySince >= 30_000) {
        this.smoothLevel = Math.max(0, this.smoothLevel - 1);
        this.healthySince = current.observedAt;
      }
    }
    this.target = [33, 67, 100][this.smoothLevel]!;
  }
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function within(value: unknown, maximum: number): boolean {
  const measurement = nonnegative(value);
  return measurement !== undefined && measurement <= maximum;
}

/** Unsupported receivers retain the browser default; avoid repeated writes. */
export function applyPlayoutTarget(
  receiver: RTCRtpReceiver,
  target: number | null,
): boolean {
  try {
    if (!("jitterBufferTarget" in receiver)) return false;
    if (receiver.jitterBufferTarget !== target)
      receiver.jitterBufferTarget = target;
    return receiver.jitterBufferTarget === target;
  } catch {
    // Readback confirms acceptance of the hint, never achieved buffering.
    return false;
  }
}
