import type { StreamTelemetry } from "../../shared/contracts";
import {
  intervalMeanMs,
  selectedCandidatePair,
  type MediaCounters,
} from "./media-metrics";

export interface StreamStatsSample {
  video?: MediaCounters;
  observedAt: number;
}

type MeasuredTelemetry = Pick<
  StreamTelemetry,
  | "resolution"
  | "framesPerSecond"
  | "roundTripMs"
  | "packetLossPercent"
  | "bitrateMbps"
  | "codec"
  | "connection"
  | "videoDecoder"
  | "decodeMs"
  | "jitterBufferMs"
  | "jitterMs"
  | "networkQuality"
>;

/** Extract only reported values. Counter intervals require the same video source. */
export function extractStreamStats(
  records: Map<string, MediaCounters>,
  previous: StreamStatsSample | undefined,
  observedAt: number,
): { telemetry: MeasuredTelemetry; sample: StreamStatsSample } {
  const video = [...records.values()].find(
    (record) =>
      record.type === "inbound-rtp" &&
      (record.kind === "video" || record.mediaType === "video"),
  );
  const pair = selectedCandidatePair(records);
  const remote = records.get(String(pair?.remoteCandidateId ?? ""));
  const width = measurement(video?.frameWidth);
  const height = measurement(video?.frameHeight);
  const framesPerSecond = measurement(video?.framesPerSecond);
  const roundTripSeconds = measurement(pair?.currentRoundTripTime);
  const roundTripMs =
    roundTripSeconds === undefined ? undefined : roundTripSeconds * 1000;
  const codecReport = records.get(String(video?.codecId ?? ""));
  const codec = reportedText(codecReport?.mimeType)?.replace(/^video\//i, "");
  const seconds = previous
    ? (observedAt - previous.observedAt) / 1000
    : undefined;
  const oldVideo =
    video &&
    previous?.video &&
    typeof video.id === "string" &&
    video.id === previous.video.id
      ? previous.video
      : undefined;
  const received = intervalDelta(video, oldVideo, "packetsReceived");
  const lost = intervalDelta(video, oldVideo, "packetsLost");
  const bytes = intervalDelta(video, oldVideo, "bytesReceived");
  const validInterval =
    seconds !== undefined && Number.isFinite(seconds) && seconds > 0;
  const packetLossPercent =
    validInterval &&
    received !== undefined &&
    lost !== undefined &&
    received + lost > 0
      ? (lost / (received + lost)) * 100
      : undefined;
  const bitrateMbps =
    validInterval && bytes !== undefined
      ? (bytes * 8) / seconds / 1_000_000
      : undefined;
  const connection: StreamTelemetry["connection"] =
    typeof remote?.address === "string"
      ? isPrivateAddress(remote.address)
        ? "local"
        : "remote"
      : "unknown";
  return {
    telemetry: {
      resolution: width && height ? `${width} x ${height}` : "Not reported",
      framesPerSecond,
      roundTripMs,
      packetLossPercent,
      bitrateMbps,
      codec,
      connection,
      videoDecoder: reportedText(video?.decoderImplementation),
      jitterMs:
        measurement(video?.jitter) === undefined
          ? undefined
          : Number(video?.jitter) * 1000,
      decodeMs: video
        ? intervalMeanMs(video, oldVideo, "totalDecodeTime", "framesDecoded")
        : undefined,
      jitterBufferMs: video
        ? intervalMeanMs(
            video,
            oldVideo,
            "jitterBufferDelay",
            "jitterBufferEmittedCount",
          )
        : undefined,
      networkQuality:
        bitrateMbps === undefined
          ? "measuring"
          : measuredNetworkQuality(
              roundTripMs,
              packetLossPercent,
              framesPerSecond,
            ),
    },
    sample: { video: video ? { ...video } : undefined, observedAt },
  };
}

function measurement(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function reportedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function intervalDelta(
  current: MediaCounters | undefined,
  previous: MediaCounters | undefined,
  field: string,
): number | undefined {
  const value = measurement(current?.[field]);
  const old = measurement(previous?.[field]);
  return value !== undefined && old !== undefined && value >= old
    ? value - old
    : undefined;
}

function measuredNetworkQuality(
  roundTripMs: number | undefined,
  loss: number | undefined,
  fps: number | undefined,
): StreamTelemetry["networkQuality"] {
  if (roundTripMs === undefined || loss === undefined || fps === undefined)
    return "measuring";
  if (loss > 2 || roundTripMs > 120 || fps < 20) return "unstable";
  return roundTripMs <= 40 && loss <= 0.5 ? "excellent" : "good";
}

function isPrivateAddress(address: string): boolean {
  return (
    address.startsWith("10.") ||
    address.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    address.startsWith("fc") ||
    address.startsWith("fd")
  );
}
