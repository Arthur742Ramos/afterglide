import { describe, expect, it } from "vitest";
import { extractStreamStats } from "../../src/renderer/stream/telemetry";
import { intervalFrameRate } from "../../src/renderer/stream/frame-rates";

describe("media pipeline FPS", () => {
  it("separates frame arrivals, decode, and rendering over reported timestamps", () => {
    const previous = {
      id: "v",
      timestamp: 1000,
      framesReceived: 100,
      framesDecoded: 80,
      framesRendered: 70,
    };
    const current = {
      id: "v",
      timestamp: 3000,
      framesReceived: 220,
      framesDecoded: 140,
      framesRendered: 110,
    };
    expect(intervalFrameRate(current, previous, "framesReceived")).toBe(60);
    expect(intervalFrameRate(current, previous, "framesDecoded")).toBe(30);
    expect(intervalFrameRate(current, previous, "framesRendered")).toBe(20);
    const records = (value: typeof previous) =>
      new Map([["v", { ...value, type: "inbound-rtp", kind: "video" }]]);
    const baseline = extractStreamStats(records(previous), undefined, 5000);
    const next = extractStreamStats(records(current), baseline.sample, 9000);
    expect(next.telemetry.incomingFramesPerSecond).toBe(60);
    expect(next.telemetry.decodedFramesPerSecond).toBe(30);
  });

  it("reports a measured stall as zero without inventing a startup rate", () => {
    const previous = { id: "v", timestamp: 1000, framesReceived: 100 };
    expect(
      intervalFrameRate(previous, undefined, "framesReceived"),
    ).toBeUndefined();
    expect(
      intervalFrameRate(
        { ...previous, timestamp: 2000 },
        previous,
        "framesReceived",
      ),
    ).toBe(0);
  });

  it.each([
    { id: "replacement", timestamp: 2000, framesReceived: 160 },
    { id: "v", timestamp: 1000, framesReceived: 160 },
    { id: "v", timestamp: 500, framesReceived: 160 },
    { id: "v", timestamp: 2000, framesReceived: 1 },
    { id: "v", timestamp: 2000, framesReceived: -1 },
    { id: "v", timestamp: 2000, framesReceived: Number.NaN },
    { id: "v", timestamp: 2000, framesReceived: "160" },
    { id: "v", timestamp: 2000 },
  ])(
    "keeps replaced, reset, stale or missing evidence unknown %j",
    (current) => {
      expect(
        intervalFrameRate(
          current,
          { id: "v", timestamp: 1000, framesReceived: 100 },
          "framesReceived",
        ),
      ).toBeUndefined();
    },
  );
});
