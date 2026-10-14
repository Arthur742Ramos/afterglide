import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
const https = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: https.request }));
import {
  probeRegion,
  regionProbeUrl,
  REGION_POLICY,
  selectCloudRegion,
  type CloudRegion,
} from "../../src/main/region-selection";

const region = (name: string, isDefault = false): CloudRegion => ({
  name,
  isDefault,
  baseUri: `https://${name}.core.gssv-play-prod.xboxlive.com`,
});
const regions = [region("slow"), region("default", true), region("fast")];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  https.request.mockReset();
});

describe("automatic region selection", () => {
  it("honors a shorter caller deadline instead of reviving the request through fallback", async () => {
    vi.useFakeTimers();
    const pending = selectCloudRegion(
      regions,
      { deadline: Date.now() + 100 },
      async () => new Promise(() => {}),
    );
    const rejection = expect(pending).rejects.toMatchObject({
      code: "XBOX_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start probes for an already cancelled launch", async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = vi.fn();
    await expect(
      selectCloudRegion(regions, { signal: controller.signal }, probe),
    ).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("retains Xbox default despite a much faster service and refreshes diagnostic medians every launch", async () => {
    const samples: Record<string, number[]> = {
      slow: [1, 100, 100],
      default: [50, 50, 50],
      fast: [20, 25, 30],
    };
    const probe = vi.fn(async (url: URL) =>
      samples[url.hostname.split(".")[0]!]!.shift(),
    );
    const result = await selectCloudRegion(regions, undefined, probe);
    expect(result.region?.name).toBe("default");
    expect(result.diagnostics).toMatchObject({
      method: "xbox-default",
      reason: "media-route-unverified",
      medianProbeMs: 50,
      requestedRegion: "default",
      xboxDefaultRegion: "default",
    });
    expect(probe).toHaveBeenCalledTimes(9);
    const changed = await selectCloudRegion(regions, undefined, async (url) =>
      url.hostname.startsWith("slow.") ? 0 : 50,
    );
    expect(changed.region?.name).toBe("default");
    expect(changed.diagnostics.medianProbeMs).toBe(50);
    expect(
      changed.diagnostics.candidates.find((row) => row.name === "slow")
        ?.medianProbeMs,
    ).toBe(0);
  });
  it("prefers the default for exact ties, deduplicates origins and rejects incomplete results", async () => {
    const calls: Record<string, number> = {};
    const probe = vi.fn(async (url: URL) => {
      const name = url.hostname.split(".")[0]!;
      calls[name] = (calls[name] ?? 0) + 1;
      return name === "fast" ? (calls[name] === 1 ? 1 : undefined) : 50;
    });
    const result = await selectCloudRegion(
      [...regions, { ...regions[0]!, baseUri: regions[0]!.baseUri + "/" }],
      undefined,
      probe,
    );
    expect(result.region?.name).toBe("default");
    expect(result.diagnostics.candidates).toHaveLength(3);
    expect(
      result.diagnostics.candidates.find((row) => row.name === "fast"),
    ).toMatchObject({
      status: "incomplete",
      successfulSamples: 1,
      medianProbeMs: undefined,
    });
    expect(probe).toHaveBeenCalledTimes(9);
  });
  it.each([undefined, NaN, Infinity, -1])(
    "falls back instead of treating failed measurement %s as zero",
    async (value) => {
      const result = await selectCloudRegion(
        regions,
        undefined,
        async () => value,
      );
      expect(result.region?.name).toBe("default");
      expect(result.diagnostics.method).toBe("xbox-default");
      expect(result.diagnostics.medianProbeMs).toBeUndefined();
    },
  );
  it("handles rejected probes, no regions, one region, and an excessive offered list", async () => {
    expect(
      (
        await selectCloudRegion(regions, undefined, async () => {
          throw Error("offline");
        })
      ).region?.name,
    ).toBe("default");
    const probe = vi.fn();
    expect(
      (await selectCloudRegion([], undefined, probe)).region,
    ).toBeUndefined();
    expect(
      (await selectCloudRegion([regions[0]!], undefined, probe)).diagnostics
        .reason,
    ).toBe("single-region");
    expect(
      (
        await selectCloudRegion(
          Array.from({ length: 33 }, (_, i) => region(`r${i}`)),
          undefined,
          probe,
        )
      ).diagnostics.reason,
    ).toBe("region-limit");
    expect(probe).not.toHaveBeenCalled();
  });
  it("bounds a hanging scan, aborts outstanding probes, and retains the default", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const pending = selectCloudRegion(
      regions,
      undefined,
      async (_url, signal) => {
        signals.push(signal);
        return new Promise(() => {});
      },
    );
    await vi.advanceTimersByTimeAsync(REGION_POLICY.totalTimeoutMs);
    expect((await pending).diagnostics).toMatchObject({
      method: "xbox-default",
      reason: "probe-timeout",
    });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains default even when only a non-default measurement completes within the budget", async () => {
    vi.useFakeTimers();
    const pending = selectCloudRegion(regions, undefined, async (url) =>
      url.hostname.startsWith("fast.") ? 20 : new Promise(() => {}),
    );
    await vi.advanceTimersByTimeAsync(REGION_POLICY.totalTimeoutMs);
    const result = await pending;
    expect(result.diagnostics.medianProbeMs).toBeUndefined();
    expect(result.diagnostics).toMatchObject({
      requestedRegion: "default",
      method: "xbox-default",
      reason: "probe-timeout",
      scanComplete: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("propagates cancellation without provisioning fallback", async () => {
    const controller = new AbortController();
    const pending = selectCloudRegion(
      regions,
      { signal: controller.signal },
      async () => new Promise(() => {}),
    );
    const rejection = expect(pending).rejects.toThrow("cancel test");
    controller.abort(new Error("cancel test"));
    await rejection;
  });
  it("does not exceed six concurrent probes", async () => {
    let active = 0,
      maximum = 0;
    await selectCloudRegion(
      Array.from({ length: 20 }, (_, i) => region(`r${i}`)),
      undefined,
      async () => {
        active++;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active--;
        return 10;
      },
    );
    expect(maximum).toBe(REGION_POLICY.concurrency);
  });
  it.each([
    "http://eus.core.gssv-play-prod.xboxlive.com",
    "https://evil.example",
    "https://eus.core.gssv-play-prod.xboxlive.com.evil.example",
    "https://user:secret@eus.core.gssv-play-prod.xboxlive.com",
    "https://eus.core.gssv-play-prod.xboxlive.com:444",
    "https://eus.core.gssv-play-prod.xboxlive.com/path",
    "https://eus.core.gssv-play-prod.xboxlive.com?q=token",
    "invalid",
  ])("never probes an unsupported origin %s", (baseUri) => {
    expect(regionProbeUrl({ ...region("test"), baseUri })).toBeUndefined();
  });
});

describe("HTTPS regional probe transport", () => {
  function transport(status?: number) {
    const req = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(),
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: status,
      destroy: vi.fn(),
    });
    https.request.mockImplementation((_url, _options, callback) => {
      req.end.mockImplementation(() => {
        if (status !== undefined) callback(response);
      });
      return req;
    });
    return req;
  }
  it.each([200, 401, 404, 405, 302, 403, 429, 503])(
    "classifies response %s without credentials or redirects",
    async (status) => {
      const req = transport(status);
      const url = regionProbeUrl(region("eus"))!;
      const value = await probeRegion(url, new AbortController().signal);
      expect(value !== undefined).toBe([200, 401, 404, 405].includes(status));
      expect(https.request.mock.calls[0]![1]).toEqual({
        method: "HEAD",
        agent: false,
        headers: { "Cache-Control": "no-cache", Connection: "close" },
      });
      expect(url.pathname).toBe("/v2/titles");
      expect(req.destroy).toHaveBeenCalledTimes(1);
    },
  );
  it("destroys a hanging request on timeout, cancellation or socket failure", async () => {
    vi.useFakeTimers();
    for (const reason of ["timeout", "abort", "error"]) {
      const req = transport();
      const controller = new AbortController();
      const pending = probeRegion(
        regionProbeUrl(region("eus"))!,
        controller.signal,
      );
      if (reason === "abort") controller.abort();
      else if (reason === "error") req.emit("error", new Error("offline"));
      else await vi.advanceTimersByTimeAsync(REGION_POLICY.probeTimeoutMs);
      expect(await pending).toBeUndefined();
      expect(req.destroy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
