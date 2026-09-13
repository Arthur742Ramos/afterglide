import { describe, expect, it } from "vitest";
import {
  encodeGamepadPacketForTest,
  streamErrorMessage,
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

  it("maps the complete keyboard controller schema", () => {
    const frame = streamProtocolTestUtils.keyboardInput([
      "KeyW",
      "KeyD",
      "KeyI",
      "KeyL",
      "Space",
      "Enter",
      "Backspace",
      "KeyX",
      "KeyY",
      "ArrowUp",
      "ArrowRight",
      "KeyQ",
      "KeyE",
      "KeyZ",
      "KeyC",
      "KeyF",
      "KeyH",
      "KeyV",
      "KeyM",
      "KeyN",
    ]);
    expect(frame).toMatchObject({
      LeftThumbXAxis: 1,
      LeftThumbYAxis: -1,
      RightThumbXAxis: 1,
      RightThumbYAxis: -1,
      A: 1,
      B: 1,
      X: 1,
      Y: 1,
      DPadUp: 1,
      DPadRight: 1,
      LeftShoulder: 1,
      RightShoulder: 1,
      LeftTrigger: 1,
      RightTrigger: 1,
      LeftThumb: 1,
      RightThumb: 1,
      View: 1,
      Menu: 1,
      Nexus: 1,
    });
  });

  it("cancels opposing keyboard axes and preserves independent buttons", () => {
    const frame = streamProtocolTestUtils.keyboardInput([
      "KeyW",
      "KeyS",
      "KeyA",
      "KeyD",
      "ArrowDown",
      "Backspace",
      "KeyZ",
    ]);
    expect(frame).toMatchObject({
      LeftThumbXAxis: 0,
      LeftThumbYAxis: 0,
      DPadDown: 1,
      B: 1,
      LeftTrigger: 1,
    });
  });

  it("reserves L3 plus R3 for Afterglide and maps Menu plus View to Xbox", () => {
    expect(
      streamProtocolTestUtils.normalizedInput({
        LeftThumb: 1,
        RightThumb: 1,
      }),
    ).toMatchObject({ LeftThumb: 0, RightThumb: 0 });
    expect(
      streamProtocolTestUtils.normalizedInput({ Menu: 1, View: 1 }),
    ).toMatchObject({ Menu: 0, View: 0, Nexus: 1 });
  });

  it("removes Electron's IPC wrapper from safe negotiation errors", () => {
    expect(
      streamErrorMessage(
        new Error(
          "Error invoking remote method 'afterglide:send-sdp': AfterglideError: The Xbox did not finish negotiating the stream.",
        ),
      ),
    ).toBe("The Xbox did not finish negotiating the stream.");
  });
});
