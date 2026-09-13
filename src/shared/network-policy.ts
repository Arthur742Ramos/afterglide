export const NETWORK_POLICY = {
  requestTimeoutMs: 12_000,
  catalogTimeoutMs: 15_000,
  maxReadRetries: 2,
  retryBaseDelayMs: 300,
  iceGatheringTimeoutMs: 4_000,
  maxIceCandidates: 128,
  maxSdpBytes: 1_000_000,
  maxIcePayloadBytes: 512_000,
  connectionDeadlineMs: 20_000,
  disconnectedGraceMs: 3_000,
  keepaliveIntervalMs: 25_000,
  keepaliveFailureThreshold: 3,
  telemetryIntervalMs: 1_000,
  inputHeartbeatMs: 33,
  cloudCatalogCacheMs: 5 * 60_000,
} as const;

export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function retryDelayMs(
  attempt: number,
  retryAfter?: string | null,
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1_000, 5_000);
  }
  return NETWORK_POLICY.retryBaseDelayMs * 2 ** attempt;
}

export function assessNetworkQuality(
  roundTripMs: number,
  packetLossPercent: number,
  framesPerSecond: number,
): "measuring" | "excellent" | "good" | "unstable" {
  if (!roundTripMs && !framesPerSecond) return "measuring";
  if (
    packetLossPercent > 2 ||
    roundTripMs > 120 ||
    (framesPerSecond > 0 && framesPerSecond < 20)
  )
    return "unstable";
  if (roundTripMs <= 40 && packetLossPercent <= 0.5) return "excellent";
  return "good";
}
