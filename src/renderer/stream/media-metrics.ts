/** Interval averages, not lifetime averages or input-to-photon measurements. */
export type MediaCounters = Record<string, unknown>;

export function intervalMeanMs(
  current: MediaCounters,
  previous: MediaCounters | undefined,
  total: string,
  count: string,
): number | undefined {
  if (!previous || current.id !== previous.id) return undefined;
  const values = [
    current[total],
    previous[total],
    current[count],
    previous[count],
  ];
  if (
    !values.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
  )
    return undefined;
  const duration = Number(current[total]) - Number(previous[total]);
  const samples = Number(current[count]) - Number(previous[count]);
  return duration >= 0 && samples > 0 ? (duration * 1000) / samples : undefined;
}

export function selectedCandidatePair(
  records: Map<string, MediaCounters>,
): MediaCounters | undefined {
  for (const record of records.values()) {
    if (record.type === "transport" && record.selectedCandidatePairId) {
      const pair = records.get(String(record.selectedCandidatePairId));
      if (pair?.type === "candidate-pair") return pair;
    }
  }
  return [...records.values()].find(
    (record) =>
      record.type === "candidate-pair" &&
      record.state === "succeeded" &&
      record.nominated === true,
  );
}

/** A hint only: the receiver still adapts to network jitter and A/V sync. */
export function requestInteractivePlayout(receiver: RTCRtpReceiver): void {
  try {
    if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 0;
  } catch {
    // Older runtimes and unsupported receivers retain their browser default.
  }
}
