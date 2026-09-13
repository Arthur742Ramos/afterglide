import { describe, expect, it } from "vitest";
import {
  encodeGamepadPacketForTest,
  streamProtocolTestUtils,
} from "../../src/renderer/stream/stream-engine";

describe("Xbox input protocol", () => {
  it("encodes the report header, button mask, axes, and triggers", () => {
    const bytes = encodeGamepadPacketForTest(
      { A: 1, DPadUp: 1, LeftThumbXAxis: 1, RightTrigger: 0.5 },
      7,
      12.5,
    );
    const packet = new DataView(bytes.buffer);
    expect(bytes).toHaveLength(38);
    expect(packet.getUint16(0, true)).toBe(2);
    expect(packet.getUint32(2, true)).toBe(7);
    expect(packet.getFloat64(6, true)).toBe(12.5);
    expect(packet.getUint16(16, true)).toBe(16 | 256);
    expect(packet.getInt16(18, true)).toBe(32_767);
    expect(packet.getUint16(28, true)).toBeCloseTo(32_768, 0);
  });

  it("derives a usable IPv4 route from a Teredo candidate", () => {
    const decoded = streamProtocolTestUtils.decodeTeredo(
      "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
    );
    expect(decoded).toEqual({ address: "192.0.2.45", port: 40_000 });
  });

  it("sends one neutral frame when the active controller disappears", () => {
    const active = streamProtocolTestUtils.chooseInputUpdate({ A: 1 });
    expect(active?.frame.A).toBe(1);

    const released = streamProtocolTestUtils.chooseInputUpdate(
      undefined,
      active?.signature,
    );
    expect(released?.frame.A).toBe(0);
    expect(released?.signature).toBe("");
    expect(
      streamProtocolTestUtils.chooseInputUpdate(undefined),
    ).toBeUndefined();
  });
});
