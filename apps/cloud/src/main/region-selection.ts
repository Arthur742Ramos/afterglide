import { request } from "node:https";
import { performance } from "node:perf_hooks";
import type { RegionSelection } from "../shared/contracts";
import { CloudOperation, type OperationContext } from "./operation-context";

export interface CloudRegion {
  baseUri: string;
  isDefault: boolean;
  name?: string;
  networkTestHostname?: string;
}

export const REGION_POLICY = {
  samples: 3,
  probeTimeoutMs: 1_200,
  totalTimeoutMs: 6_000,
  concurrency: 6,
  maxRegions: 32,
} as const;

export function xboxDefaultRegion(regions: readonly CloudRegion[]) {
  return regions.find((region) => region.isDefault) ?? regions[0];
}

// Only probe the HTTPS regional provisioning origins supplied by Xbox. Never
// send authentication, follow redirects, or use a session-creating endpoint.
export function regionProbeUrl(region: CloudRegion): URL | undefined {
  try {
    const url = new URL(region.baseUri);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      !/^[a-z0-9-]+\.core\.gssv-play-prod\.xboxlive\.com$/i.test(url.hostname)
    )
      return undefined;
    return new URL("/v2/titles", url);
  } catch {
    return undefined;
  }
}

export type RegionProbe = (
  url: URL,
  signal: AbortSignal,
) => Promise<number | undefined>;

/** Time DNS, a fresh TLS connection and response headers. This is not media RTT. */
export const probeRegion: RegionProbe = (url, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    const started = performance.now();
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value?: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      req.destroy();
      resolve(value);
    };
    const abort = () => finish();
    const req = request(
      url,
      {
        method: "HEAD",
        agent: false,
        headers: { "Cache-Control": "no-cache", Connection: "close" },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        // Authentication/method/not-found responses still establish a live route.
        // Redirects, blocked regions, throttling and service errors do not qualify.
        const reachable =
          (status >= 200 && status < 300) || [401, 404, 405].includes(status);
        response.destroy();
        finish(reachable ? performance.now() - started : undefined);
      },
    );
    req.once("error", () => finish());
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, REGION_POLICY.probeTimeoutMs);
    req.end();
  });

export async function selectCloudRegion(
  regions: readonly CloudRegion[],
  context?: OperationContext,
  probe: RegionProbe = probeRegion,
): Promise<{ region: CloudRegion | undefined; diagnostics: RegionSelection }> {
  const fallback = xboxDefaultRegion(regions);
  const label = (region: CloudRegion) =>
    (region.name?.trim() || "Unnamed region").slice(0, 80);
  const diagnostics: RegionSelection = {
    requestedRegion: fallback ? label(fallback) : "Unavailable",
    xboxDefaultRegion: fallback ? label(fallback) : "Unavailable",
    method: "xbox-default",
    reason: "probes-unavailable",
    measuredAt: Date.now(),
    scanComplete: false,
    candidates: [],
  };
  const operation = new CloudOperation(context, REGION_POLICY.totalTimeoutMs);
  try {
    operation.check();
    const seen = new Set<string>();
    const candidates = [fallback, ...regions].filter(
      (region): region is CloudRegion => {
        if (!region || seen.has(region.baseUri.replace(/\/$/, "")))
          return false;
        seen.add(region.baseUri.replace(/\/$/, ""));
        return true;
      },
    );
    if (
      candidates.length <= 1 ||
      candidates.length > REGION_POLICY.maxRegions
    ) {
      diagnostics.scanComplete = candidates.length <= 1;
      diagnostics.reason =
        candidates.length <= 1 ? "single-region" : "region-limit";
      return { region: fallback, diagnostics };
    }
    const results = candidates.map((region) => ({
      region,
      url: regionProbeUrl(region),
      samples: [] as number[],
      attemptedSamples: 0,
    }));
    let next = 0;
    // No cached result survives a new launch/network change. The whole scan is
    // bounded, and failed samples never become zero-latency winners.
    const worker = async () => {
      while (next < results.length && !operation.signal.aborted) {
        const result = results[next++]!;
        if (!result.url) continue;
        for (let sample = 0; sample < REGION_POLICY.samples; sample++) {
          try {
            const value = await operation.wait(() => {
              result.attemptedSamples++;
              return probe(result.url!, operation.signal);
            });
            if (value !== undefined && Number.isFinite(value) && value >= 0)
              result.samples.push(value);
          } catch {
            if (operation.signal.aborted) return;
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(REGION_POLICY.concurrency, results.length) },
        worker,
      ),
    );
    // A user cancellation must stop provisioning, not silently choose fallback.
    if (context?.signal?.aborted) throw context.signal.reason;
    if (context?.deadline !== undefined && Date.now() >= context.deadline)
      operation.check();
    const complete = results.filter(
      (result) => result.samples.length === REGION_POLICY.samples,
    );
    const median = (samples: number[]) =>
      [...samples].sort((a, b) => a - b)[1]!;
    diagnostics.candidates = results.map((result) => ({
      name: label(result.region),
      successfulSamples: result.samples.length,
      attemptedSamples: result.attemptedSamples,
      medianProbeMs:
        result.samples.length === REGION_POLICY.samples
          ? median(result.samples)
          : undefined,
      status: !result.url
        ? "unsupported"
        : !result.attemptedSamples
          ? "not-tested"
          : result.samples.length === REGION_POLICY.samples
            ? "measured"
            : "incomplete",
    }));
    diagnostics.scanComplete = !operation.signal.aborted;
    // HTTPS service timing includes DNS/TLS/HTTP and has not predicted media
    // RTT in live comparisons. Keep it as diagnostics, never as authority to
    // move a user away from Xbox's default (even after a complete scan).
    const selectedMeasurement = complete.find(
      (result) => result.region === fallback,
    );
    diagnostics.reason = operation.signal.aborted
      ? "probe-timeout"
      : complete.length
        ? "media-route-unverified"
        : "probes-unavailable";
    if (selectedMeasurement)
      diagnostics.medianProbeMs = median(selectedMeasurement.samples);
    return { region: fallback, diagnostics };
  } finally {
    operation.dispose();
  }
}
