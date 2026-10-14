import { describe, expect, it } from "vitest";
import { InputPollingMetrics } from "../../src/renderer/stream/input-polling-metrics";

describe("observed JS polling cadence", () => {
  it("retains measured zero jitter and gaps, then starts a nonoverlapping window", () => {
    const metrics = new InputPollingMetrics();
    expect(metrics.snapshot()).toBeUndefined();
    metrics.reset(4);
    metrics.observe(0);
    expect(metrics.snapshot()).toBeUndefined();
    for (let at = 4; at <= 1000; at += 4) metrics.observe(at);
    expect(metrics.snapshot()).toEqual({
      targetMs: 4,
      samples: 250,
      windowMs: 1000,
      meanIntervalMs: 4,
      p95UpperMs: 4,
      maxIntervalMs: 4,
      meanJitterMs: 0,
      longGaps: 0,
    });
    expect(metrics.snapshot()).toBeUndefined();
    metrics.observe(1004);
    expect(metrics.snapshot()?.samples).toBe(1);
  });
  it("measures long gaps exactly and bounds histogram overflow honestly", () => {
    const metrics = new InputPollingMetrics();
    metrics.reset(8);
    for (const at of [0, 8.2, 16.2, 49.2, 1000]) metrics.observe(at);
    expect(metrics.snapshot()).toMatchObject({
      samples: 4,
      longGaps: 2,
      p95UpperMs: 950.8,
      maxIntervalMs: 950.8,
      windowMs: 1000,
    });
  });
  it("excludes intentional timer restarts, inactive gaps and mode transitions", () => {
    const metrics = new InputPollingMetrics();
    metrics.reset(4);
    metrics.observe(0);
    metrics.observe(4);
    metrics.restart(4);
    metrics.observe(100);
    metrics.observe(104);
    expect(metrics.snapshot()).toMatchObject({ samples: 2, maxIntervalMs: 4 });
    metrics.restart();
    metrics.observe(10000);
    expect(metrics.snapshot()).toBeUndefined();
    metrics.restart(8);
    metrics.observe(20000);
    metrics.observe(20008);
    expect(metrics.snapshot()).toMatchObject({
      targetMs: 8,
      samples: 1,
      meanIntervalMs: 8,
    });
    metrics.reset();
    expect(metrics.snapshot()).toBeUndefined();
  });
});
