import { describe, expect, it } from "vitest";
import { PerformanceReport } from "../../src/main/performance-report";
import { defaultSettings, emptyTelemetry } from "../../src/shared/contracts";
import type { HardwareInfo } from "../../src/shared/contracts";

const hardware: HardwareInfo = {
  acceleration: "enabled",
  videoDecode: "enabled",
  gpu: "Test GPU",
  secureStorage: true,
  credentialStorage: { backend: "private", detail: "do not export" },
};

describe("performance evidence", () => {
  it("retains a bounded chronological window without account or controller identifiers", () => {
    const report = new PerformanceReport();
    report.reset("home");
    for (let index = 0; index < 3_605; index++)
      report.add(
        { ...emptyTelemetry, updatedAt: index },
        { ...defaultSettings, preferredControllerId: "private controller" },
      );
    const exported = report.export("test-version", "test", hardware);
    expect(exported).toMatchObject({
      schemaVersion: 1,
      retainedSamples: 3_600,
      totalSamples: 3_605,
      droppedSamples: 5,
      application: { environment: "test" },
    });
    expect(exported.samples[0].telemetry.updatedAt).toBe(5);
    expect(exported.samples.at(-1)?.telemetry.updatedAt).toBe(3_604);
    expect(JSON.stringify(exported)).not.toContain("private");
    expect(exported.samples[0].telemetry.decodeMs).toBeUndefined();
  });

  it("copies samples and preserves device timestamps and recovery durations", () => {
    const report = new PerformanceReport();
    report.reset("cloud");
    const telemetry = { ...emptyTelemetry, frameIntervalP95Ms: 17 };
    report.add(telemetry, defaultSettings, {
      observedAt: 123,
      batteryWatts: 9.5,
      unavailable: [],
    });
    telemetry.frameIntervalP95Ms = 999;
    report.recovered(100, 2300);
    const exported = report.export("v1", "live", hardware);
    expect(exported.samples[0].telemetry.frameIntervalP95Ms).toBe(17);
    expect(exported.samples[0].device?.observedAt).toBe(123);
    expect(exported.recoveries).toEqual([{ startedAt: 100, durationMs: 2300 }]);
    report.reset("home");
    expect(report.export("v1", "live", hardware).retainedSamples).toBe(0);
    expect(report.export("v1", "live", hardware).recoveries).toEqual([]);
  });

  it("separates configurations, deduplicates device readings and identifies reconnects", () => {
    const report = new PerformanceReport();
    report.reset("home");
    report.connected();
    for (let index = 0; index < 4; index++)
      report.add({ ...emptyTelemetry, decodeMs: index + 1 }, defaultSettings, {
        observedAt: 100,
        batteryWatts: 8,
        unavailable: [],
      });
    report.connected();
    report.add(
      { ...emptyTelemetry, decodeMs: 20 },
      { ...defaultSettings, inputPolling: "efficient" },
    );
    const result = report.export("v1", "live", hardware);
    expect(result.summaries).toHaveLength(2);
    expect(result.summaries[0]).toMatchObject({
      configuration: "1080p/responsive",
      decodeMs: { count: 4, median: 2, p95: 4, p99: 4 },
      batteryWatts: { count: 1, median: 8 },
    });
    expect(result.summaries[1].batteryWatts).toBeUndefined();
    expect(result.samples[0].connectionNumber).toBe(1);
    expect(result.samples.at(-1)?.connectionNumber).toBe(2);
  });
});
