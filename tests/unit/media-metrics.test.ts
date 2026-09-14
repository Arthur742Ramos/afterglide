import { describe, expect, it } from "vitest";
import {
  intervalMeanMs,
  selectedCandidatePair,
  requestInteractivePlayout,
} from "../../src/renderer/stream/media-metrics";
describe("media latency evidence", () => {
  it("uses interval decode cost and rejects missing, reset, or empty samples", () => {
    const old = { id: "v", totalDecodeTime: 10, framesDecoded: 100 };
    expect(
      intervalMeanMs(
        { id: "v", totalDecodeTime: 10.12, framesDecoded: 160 },
        old,
        "totalDecodeTime",
        "framesDecoded",
      ),
    ).toBeCloseTo(2);
    for (const sample of [
      old,
      { id: "new", totalDecodeTime: 11, framesDecoded: 160 },
      { id: "v", totalDecodeTime: 1, framesDecoded: 10 },
      { id: "v" },
    ]) {
      expect(
        intervalMeanMs(sample, old, "totalDecodeTime", "framesDecoded"),
      ).toBeUndefined();
    }
  });
  it("uses the selected transport route instead of an unrelated succeeded candidate", () => {
    const selected = { type: "candidate-pair", currentRoundTripTime: 0.025 };
    const records = new Map<string, Record<string, unknown>>([
      ["t", { type: "transport", selectedCandidatePairId: "chosen" }],
      ["chosen", selected],
      [
        "other",
        { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 1 },
      ],
    ]);
    expect(selectedCandidatePair(records)).toBe(selected);
  });
  it("requests low buffering only where supported and tolerates rejected hints", () => {
    const receiver = { jitterBufferTarget: null };
    requestInteractivePlayout(receiver as unknown as RTCRtpReceiver);
    expect(receiver.jitterBufferTarget).toBe(0);
    const unsupported = {};
    requestInteractivePlayout(unsupported as RTCRtpReceiver);
    expect(unsupported).toEqual({});
    expect(() =>
      requestInteractivePlayout(
        Object.defineProperty({}, "jitterBufferTarget", {
          set() {
            throw new Error("unsupported");
          },
        }) as RTCRtpReceiver,
      ),
    ).not.toThrow();
  });
});
