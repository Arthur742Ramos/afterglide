import { describe, expect, it } from "vitest";
import { extractStreamStats } from "../../src/renderer/stream/telemetry";

function records(video: Record<string, unknown> = {}, rtt: unknown = 0.02) {
  return new Map<string, Record<string, unknown>>([
    ["video", { id: "video", type: "inbound-rtp", kind: "video", ...video }],
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", currentRoundTripTime: rtt }],
  ]);
}

const counters = {
  bytesReceived: 1000,
  packetsReceived: 100,
  packetsLost: 2,
  framesPerSecond: 60,
};

describe("truthful stream telemetry", () => {
  it("converts reported packet jitter from seconds independently of buffer delay", () => {
    expect(
      extractStreamStats(records({ jitter: 0.012 }), undefined, 1000).telemetry
        .jitterMs,
    ).toBe(12);
    for (const jitter of [undefined, -1, "0.012", Number.NaN])
      expect(
        extractStreamStats(records({ jitter }), undefined, 1000).telemetry
          .jitterMs,
      ).toBeUndefined();
  });
  it("does not invent missing frame rate, codec, decoder or network evidence", () => {
    const { telemetry } = extractStreamStats(
      records({}, null),
      undefined,
      1000,
    );
    expect(telemetry).toMatchObject({
      framesPerSecond: undefined,
      roundTripMs: undefined,
      packetLossPercent: undefined,
      bitrateMbps: undefined,
      codec: undefined,
      videoDecoder: undefined,
      networkQuality: "measuring",
    });
  });

  it("requires a previous sample and actual new packets to classify a healthy connection", () => {
    const first = extractStreamStats(records(counters), undefined, 0);
    expect(first.telemetry.packetLossPercent).toBeUndefined();
    expect(first.telemetry.bitrateMbps).toBeUndefined();
    expect(first.telemetry.networkQuality).toBe("measuring");
    const idle = extractStreamStats(records(counters), first.sample, 1000);
    expect(idle.telemetry.packetLossPercent).toBeUndefined();
    expect(idle.telemetry.networkQuality).toBe("measuring");
    expect(idle.telemetry.bitrateMbps).toBe(0);
  });

  it("preserves measured zero RTT and loss, negotiated codec and actual decoder", () => {
    const first = extractStreamStats(records(counters, 0), undefined, 0);
    const current = records(
      {
        ...counters,
        bytesReceived: 501000,
        packetsReceived: 200,
        frameWidth: 1920,
        frameHeight: 1080,
        codecId: "negotiated",
        decoderImplementation: "D3D11VideoDecoder",
      },
      0,
    );
    current.set("negotiated", { type: "codec", mimeType: "video/VP9" });
    const { telemetry } = extractStreamStats(current, first.sample, 1000);
    expect(telemetry).toMatchObject({
      resolution: "1920 x 1080",
      roundTripMs: 0,
      packetLossPercent: 0,
      bitrateMbps: 4,
      codec: "VP9",
      videoDecoder: "D3D11VideoDecoder",
      networkQuality: "excellent",
    });
  });

  it("keeps quality measuring when any required measurement is missing", () => {
    const first = extractStreamStats(records(counters), undefined, 1000);
    const next = { ...counters, packetsReceived: 200, bytesReceived: 2000 };
    for (const reports of [
      records(next, null),
      records({ ...next, framesPerSecond: undefined }),
      records({ ...next, packetsLost: undefined }),
      records({ ...next, bytesReceived: undefined }),
    ]) {
      expect(
        extractStreamStats(reports, first.sample, 2000).telemetry
          .networkQuality,
      ).toBe("measuring");
    }
  });

  it("rejects reset, replaced and incomplete counter intervals instead of clamping to zero", () => {
    const first = extractStreamStats(records(counters), undefined, 1000);
    for (const video of [
      { ...counters, bytesReceived: 1, packetsReceived: 1, packetsLost: 0 },
      {
        ...counters,
        id: "replacement",
        bytesReceived: 2000,
        packetsReceived: 200,
      },
      { framesPerSecond: 60 },
    ]) {
      const { telemetry } = extractStreamStats(
        records(video),
        first.sample,
        2000,
      );
      expect(telemetry.packetLossPercent).toBeUndefined();
      expect(telemetry.bitrateMbps).toBeUndefined();
      expect(telemetry.networkQuality).toBe("measuring");
    }
    expect(
      extractStreamStats(records(counters), first.sample, 1000).telemetry
        .packetLossPercent,
    ).toBeUndefined();
    const bytesReset = extractStreamStats(
      records({ ...counters, packetsReceived: 200, bytesReceived: 1 }),
      first.sample,
      2000,
    );
    expect(bytesReset.telemetry.bitrateMbps).toBeUndefined();
    expect(bytesReset.telemetry.networkQuality).toBe("measuring");
  });

  it("rejects nonfinite, negative and string measurements and marks observed stalls unstable", () => {
    const invalid = extractStreamStats(
      records({ framesPerSecond: "60", bytesReceived: Number.NaN }, -1),
      undefined,
      1000,
    );
    expect(invalid.telemetry.framesPerSecond).toBeUndefined();
    expect(invalid.telemetry.roundTripMs).toBeUndefined();
    const first = extractStreamStats(records(counters), undefined, 1000);
    const stalled = extractStreamStats(
      records({
        ...counters,
        framesPerSecond: 0,
        bytesReceived: 2000,
        packetsReceived: 200,
      }),
      first.sample,
      2000,
    );
    expect(stalled.telemetry.networkQuality).toBe("unstable");
  });

  it("computes interval loss and decode cost without lifetime averages", () => {
    const first = extractStreamStats(
      records({ ...counters, totalDecodeTime: 10, framesDecoded: 100 }),
      undefined,
      1000,
    );
    const { telemetry } = extractStreamStats(
      records({
        ...counters,
        bytesReceived: 2000,
        packetsReceived: 198,
        packetsLost: 4,
        totalDecodeTime: 10.12,
        framesDecoded: 160,
      }),
      first.sample,
      2000,
    );
    expect(telemetry.packetLossPercent).toBe(2);
    expect(telemetry.decodeMs).toBeCloseTo(2);
    expect(telemetry.networkQuality).toBe("good");
  });
});
