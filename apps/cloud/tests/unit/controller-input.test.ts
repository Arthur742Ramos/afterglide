import { describe, expect, it } from "vitest";
import { defaultControllerTuning } from "../../src/shared/contracts";
import { emptyXboxInputFrame } from "../../src/renderer/stream/input-schema";
import {
  controllerInputFrame,
  controllerSupportsStandardMapping,
  controllerSupportsRumble,
  ControllerInputReleaseGate,
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
  // Representative browser IDs; these fixtures verify the standard layout,
  // not transport detection or physical USB/Bluetooth compatibility.
  it.each([
    ["Xbox USB", "Xbox 360 Controller (XInput STANDARD GAMEPAD)"],
    [
      "Xbox Bluetooth",
      "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)",
    ],
    [
      "DualSense USB",
      "Sony Interactive Entertainment DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)",
    ],
    [
      "DualSense Bluetooth",
      "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)",
    ],
  ])("maps the browser standard layout for %s", (_transport, id) => {
    const pad = gamepad(id, 0, {
      buttons: {
        0: 1,
        1: 0.8,
        2: 0.7,
        3: 0.6,
        4: 1,
        5: 1,
        6: 0.4,
        7: 0.75,
        8: 1,
        9: 1,
        10: 1,
        11: 1,
        12: 1,
        13: 1,
        14: 1,
        15: 1,
        16: 1,
      },
      axes: [1, -1, -1, 1],
    });
    expect(controllerSupportsStandardMapping(pad)).toBe(true);
    expect(controllerInputFrame(pad, defaultControllerTuning)).toMatchObject({
      A: 1,
      B: 0.8,
      X: 0.7,
      Y: 0.6,
      LeftShoulder: 1,
      RightShoulder: 1,
      LeftTrigger: 0.4,
      RightTrigger: 0.75,
      View: 1,
      Menu: 1,
      LeftThumb: 1,
      RightThumb: 1,
      DPadUp: 1,
      DPadDown: 1,
      DPadLeft: 1,
      DPadRight: 1,
      Nexus: 1,
      LeftThumbXAxis: 1,
      LeftThumbYAxis: -1,
      RightThumbXAxis: -1,
      RightThumbYAxis: 1,
    });
  });

  it.each(["", "xr-standard"])(
    "rejects mapping %j even when its ID names a known controller",
    (mapping) => {
      const raw = {
        ...gamepad("DualSense Wireless Controller", 0, {
          buttons: { 0: 1, 6: 1 },
          axes: [1, 1, 1, 1],
        }),
        mapping,
      };
      const standard = gamepad("Xbox Wireless Controller", 1);
      expect(controllerSupportsStandardMapping(raw)).toBe(false);
      expect(selectController([raw, standard], "")).toBe(standard);
      expect(selectController([raw, standard], raw.id)).toBeUndefined();
      const stale = {
        ...emptyXboxInputFrame(),
        A: 1,
        LeftTrigger: 1,
        LeftThumbXAxis: 1,
      };
      expect(controllerInputFrame(raw, defaultControllerTuning, stale)).toEqual(
        emptyXboxInputFrame(),
      );
      expect(
        controllerSupportsStandardMapping({ ...standard, connected: false }),
      ).toBe(false);
    },
  );

  it("keeps the current preferred controller when same-model devices share an ID", () => {
    const first = gamepad("DualSense Wireless Controller", 0);
    const second = gamepad(first.id, 3, { buttons: { 0: 1 } });
    expect(selectController([first, null, null, second], first.id, 3)).toBe(
      second,
    );
    expect(selectController([first, null, null, second], first.id, 0)).toBe(
      first,
    );
    expect(selectController([first, null, null, second], first.id)).toBe(
      second,
    );
    expect(selectController([first], first.id, 3)).toBe(first);
  });

  it("requires dual-rumble capability rather than actuator presence or a Sony name", () => {
    const pad = gamepad("DualSense Wireless Controller", 0);
    const actuator = (effects: string[] | undefined, type = "dual-rumble") =>
      ({
        type,
        effects,
        playEffect: async () => "complete",
        reset: async () => "complete",
      }) as unknown as GamepadHapticActuator;
    expect(controllerSupportsRumble(pad)).toBe(false);
    expect(
      controllerSupportsRumble({
        ...pad,
        vibrationActuator: actuator(["dual-rumble"]),
      }),
    ).toBe(true);
    expect(
      controllerSupportsRumble({
        ...pad,
        vibrationActuator: actuator(["trigger-rumble"]),
      }),
    ).toBe(false);
    expect(
      controllerSupportsRumble({ ...pad, vibrationActuator: actuator([]) }),
    ).toBe(false);
    expect(
      controllerSupportsRumble({
        ...pad,
        vibrationActuator: actuator(undefined),
      }),
    ).toBe(true);
    expect(
      controllerSupportsRumble({
        ...pad,
        vibrationActuator: actuator(undefined, "vibration"),
      }),
    ).toBe(false);
    expect(
      controllerSupportsRumble({
        ...pad,
        mapping: "",
        vibrationActuator: actuator(["dual-rumble"]),
      }),
    ).toBe(false);
  });

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

  it("reuses and fully overwrites provided frame storage", () => {
    const reused = {
      ...emptyXboxInputFrame(),
      A: 1,
      LeftThumbXAxis: 1,
      RightTrigger: 1,
    };
    const result = controllerInputFrame(
      gamepad("Reusable Controller", 0, {
        buttons: { 1: 1 },
        axes: [-0.5, 0.5, 0.25, -0.25],
      }),
      defaultControllerTuning,
      reused,
    );

    expect(result).toBe(reused);
    expect(result).toMatchObject({
      A: 0,
      B: 1,
      RightTrigger: 0,
    });
    expect(result.LeftThumbXAxis).toBeLessThan(0);
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

describe("controller release gate", () => {
  it("neutralizes buttons, triggers and sticks held during startup until each returns neutral", () => {
    const gate = new ControllerInputReleaseGate();
    const held = gamepad("DualSense Wireless Controller", 0, {
      buttons: { 0: 1, 7: 0.8 },
      axes: [1, 0, 0, 0],
    });
    gate.prime(held, defaultControllerTuning);
    expect(
      controllerInputFrame(held, defaultControllerTuning, undefined, gate),
    ).toMatchObject({ A: 0, RightTrigger: 0, LeftThumbXAxis: 0 });
    controllerInputFrame(
      gamepad(held.id, 0),
      defaultControllerTuning,
      undefined,
      gate,
    );
    expect(
      controllerInputFrame(held, defaultControllerTuning, undefined, gate),
    ).toMatchObject({ A: 1, RightTrigger: 0.8, LeftThumbXAxis: 1 });
  });

  it("blocks held physical controls after capture/refocus and respects remapped buttons", () => {
    const gate = new ControllerInputReleaseGate();
    const tuning = {
      ...defaultControllerTuning,
      buttonLayout: "swap-ab" as const,
    };
    gate.prime(gamepad("Xbox", 0), tuning);
    const held = gamepad("Xbox", 0, { buttons: { 0: 1 } });
    expect(controllerInputFrame(held, tuning, undefined, gate).B).toBe(1);
    gate.arm();
    expect(controllerInputFrame(held, tuning, undefined, gate).B).toBe(0);
    controllerInputFrame(gamepad("Xbox", 0), tuning, undefined, gate);
    expect(controllerInputFrame(held, tuning, undefined, gate).B).toBe(1);
  });

  it("leaves independent controls responsive while held controls await release", () => {
    const gate = new ControllerInputReleaseGate();
    gate.prime(
      gamepad("Xbox", 0, { buttons: { 0: 1 }, axes: [1, 0, 0, 0] }),
      defaultControllerTuning,
    );
    expect(
      controllerInputFrame(
        gamepad("Xbox", 0, { buttons: { 0: 1, 1: 1 }, axes: [1, -1, 0, 0] }),
        defaultControllerTuning,
        undefined,
        gate,
      ),
    ).toMatchObject({ A: 0, B: 1, LeftThumbXAxis: 0, LeftThumbYAxis: -1 });
  });
});
