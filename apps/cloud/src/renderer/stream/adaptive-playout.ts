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
}

/**
 * Leave buffering to Chromium until advancing video and network measurements
 * stay healthy for ten seconds. A disturbance immediately removes our hint;
 * this requests neither a fixed buffer size nor a server bitrate change.
 */
export class AdaptivePlayoutPolicy {
  target: 0 | null = null;
  private baseline?: Baseline;
  private healthySince?: number;
  private mediaDisturbances = 0;

  reset(): void {
    this.target = null;
    this.baseline = undefined;
    this.healthySince = undefined;
    this.mediaDisturbances = 0;
  }

  update(
    video: MediaCounters | undefined,
    telemetry: Pick<
      StreamTelemetry,
      "jitterMs" | "packetLossPercent" | "roundTripMs"
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
      this.reset();
      return;
    }
    const current: Baseline = {
      id: video.id,
      timestamp,
      frames,
      observedAt,
      freezes: nonnegative(video.freezeCount),
      dropped: nonnegative(video.framesDropped),
    };
    const previous = this.baseline;
    this.baseline = current;
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
          current.dropped === previous.dropped));
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
      if (this.target === 0 && !mediaHealthy) {
        this.mediaDisturbances = Math.min(
          PLAYOUT_POLICY.maxBackoffExponent,
          this.mediaDisturbances + 1,
        );
      }
      this.target = null;
      this.healthySince = undefined;
      return;
    }
    this.healthySince ??= observedAt;
    const requiredHealthyMs =
      PLAYOUT_POLICY.healthyDurationMs * 2 ** this.mediaDisturbances;
    if (observedAt - this.healthySince >= requiredHealthyMs) this.target = 0;
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
  target: 0 | null,
): void {
  try {
    if (
      "jitterBufferTarget" in receiver &&
      receiver.jitterBufferTarget !== target
    )
      receiver.jitterBufferTarget = target;
  } catch {
    // Capability detection does not guarantee a writable property.
  }
}
