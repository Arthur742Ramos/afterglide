import { describe, expect, it } from "vitest";
import { defaultControllerTuning } from "../../src/shared/contracts";
import {
  controllerInputFrame,
  friendlyControllerName,
  selectController,
  tuningForGamepad,
  type GamepadLike,
} from "../../src/renderer/stream/controller-input";

function gamepad(
  id: string,
  index: number,
  input: { buttons?: Record<number, number>; axes?: number[] } = {},
): GamepadLike {
  return {
    id,
    index,
    connected: true,
    mapping: "standard",
    axes: input.axes ?? [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, buttonIndex) => {
      const value = input.buttons?.[buttonIndex] ?? 0;
      return { value, pressed: value > 0.5 };
    }),
  };
}

describe("controller input", () => {
  it("locks automatic selection until another controller becomes active", () => {
    const deck = gamepad("Steam Deck", 0);
    const docked = gamepad("Xbox Wireless Controller", 2);
    expect(selectController([deck, null, docked], "")?.index).toBe(0);
    expect(selectController([deck, null, docked], "", 0)?.index).toBe(0);

    const activeDocked = gamepad("Xbox Wireless Controller", 2, {
      buttons: { 0: 1 },
    });
    expect(selectController([deck, null, activeDocked], "", 0)?.index).toBe(2);
    expect(selectController([deck, null, activeDocked], "", 2)?.index).toBe(2);
  });

  it("honors an explicit device and waits when it is disconnected", () => {
    const deck = gamepad("Steam Deck", 0, { buttons: { 0: 1 } });
    const docked = gamepad("Xbox Wireless Controller", 1);
    expect(
      selectController([deck, docked], "Xbox Wireless Controller")?.index,
    ).toBe(1);
    expect(
      selectController([deck], "Xbox Wireless Controller"),
    ).toBeUndefined();
  });

  it("applies a profile to face buttons, sticks, and triggers", () => {
    const input = gamepad("Accessible Controller", 0, {
      buttons: { 0: 1, 6: 0.5 },
      axes: [0.06, -0.5, 0, 0],
    });
    const frame = controllerInputFrame(input, {
      ...defaultControllerTuning,
      buttonLayout: "swap-ab",
      stickDeadzone: 0.04,
      triggerRange: 0.5,
    });
    expect(frame.A).toBe(0);
    expect(frame.B).toBe(1);
    expect(frame.LeftTrigger).toBe(1);
    expect(frame.LeftThumbXAxis).toBeCloseTo((0.06 - 0.04) / 0.96);
    expect(frame.LeftThumbYAxis).toBeCloseTo((-0.5 + 0.04) / 0.96);
  });

  it("uses controller profiles over defaults", () => {
    const controller = gamepad("Xbox Controller", 0);
    expect(
      tuningForGamepad(
        {
          controllerDefaults: defaultControllerTuning,
          controllerProfiles: [
            {
              id: "Xbox Controller",
              ...defaultControllerTuning,
              rumble: "low",
            },
          ],
        },
        controller,
      ).rumble,
    ).toBe("low");
    expect(
      friendlyControllerName("Xbox Controller (Vendor: 045e Product: 0b13)"),
    ).toBe("Xbox Controller");
  });
});
