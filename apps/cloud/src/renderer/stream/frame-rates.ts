import type { MediaCounters } from "./media-metrics";

/** Rates over one advancing stats interval on the same media receiver. */
export function intervalFrameRate(
  current: MediaCounters | undefined,
  previous: MediaCounters | undefined,
  counter: "framesReceived" | "framesDecoded" | "framesRendered",
): number | undefined {
  if (
    !current ||
    !previous ||
    typeof current.id !== "string" ||
    current.id !== previous.id
  )
    return undefined;
  const values = [
    current.timestamp,
    previous.timestamp,
    current[counter],
    previous[counter],
  ];
  if (
    !values.every(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
  )
    return undefined;
  const duration = Number(current.timestamp) - Number(previous.timestamp);
  const frames = Number(current[counter]) - Number(previous[counter]);
  return duration > 0 && frames >= 0 ? (frames * 1000) / duration : undefined;
}
