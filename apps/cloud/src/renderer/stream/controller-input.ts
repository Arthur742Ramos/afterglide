import type { AppSettings, ControllerTuning } from "../../shared/contracts";
import { tuningForController } from "../../shared/controller-settings";
import {
  emptyXboxInputFrame,
  resetXboxInputFrame,
  type XboxButtonName,
  type XboxInputFrame,
} from "./input-schema";

export interface GamepadLike {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: GamepadMappingType | string;
  readonly axes: readonly number[];
  readonly buttons: readonly Pick<GamepadButton, "pressed" | "value">[];
  readonly vibrationActuator?: Gamepad["vibrationActuator"];
}

const buttonMap: Record<XboxButtonName, number> = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LeftShoulder: 4,
  RightShoulder: 5,
  LeftThumb: 10,
  RightThumb: 11,
  DPadUp: 12,
  DPadDown: 13,
  DPadLeft: 14,
  DPadRight: 15,
  Menu: 9,
  View: 8,
  Nexus: 16,
};
const buttonEntries = Object.entries(buttonMap) as Array<
  [XboxButtonName, number]
>;
const axisNames = [
  "LeftThumbXAxis",
  "LeftThumbYAxis",
  "RightThumbXAxis",
  "RightThumbYAxis",
] as const;

// The browser owns USB/Bluetooth mapping. Device names and vendor IDs do not
// establish a raw layout or a unique identity for two same-model controllers.
export function controllerSupportsStandardMapping(
  gamepad: GamepadLike | null | undefined,
): gamepad is GamepadLike {
  return Boolean(gamepad?.connected && gamepad.mapping === "standard");
}

export function controllerSupportsRumble(
  gamepad: GamepadLike | null | undefined,
): boolean {
  if (!controllerSupportsStandardMapping(gamepad)) return false;
  const actuator = gamepad.vibrationActuator;
  if (!actuator || typeof actuator.playEffect !== "function") return false;
  const capabilities = actuator as GamepadHapticActuator & {
    effects?: readonly string[];
    type?: string;
  };
  return capabilities.effects !== undefined
    ? capabilities.effects.includes("dual-rumble")
    : capabilities.type === "dual-rumble";
}

export function connectedGamepads(
  gamepads: readonly (GamepadLike | null)[],
): GamepadLike[] {
  return gamepads.filter((gamepad): gamepad is GamepadLike =>
    Boolean(gamepad?.connected),
  );
}

export function gamepadHasActivity(gamepad: GamepadLike): boolean {
  if (!controllerSupportsStandardMapping(gamepad)) return false;
  for (let i = 0; i < gamepad.buttons.length; i++) {
    const button = gamepad.buttons[i];
    if (button && (button.pressed || button.value > 0.18)) return true;
  }
  for (let i = 0; i < gamepad.axes.length; i++) {
    if (Math.abs(gamepad.axes[i] ?? 0) > 0.18) return true;
  }
  return false;
}

export function selectController(
  gamepads: readonly (GamepadLike | null)[],
  preferredId: string,
  currentIndex?: number,
): GamepadLike | undefined {
  if (preferredId) {
    let firstMatching: GamepadLike | undefined;
    let activeMatching: GamepadLike | undefined;
    for (let i = 0; i < gamepads.length; i++) {
      const gamepad = gamepads[i];
      if (
        !controllerSupportsStandardMapping(gamepad) ||
        gamepad.id !== preferredId
      )
        continue;
      if (gamepad.index === currentIndex) return gamepad;
      firstMatching ??= gamepad;
      if (!activeMatching && gamepadHasActivity(gamepad))
        activeMatching = gamepad;
    }
    return activeMatching ?? firstMatching;
  }
  let firstConnected: GamepadLike | undefined;
  let current: GamepadLike | undefined;
  let activeOther: GamepadLike | undefined;
  for (let i = 0; i < gamepads.length; i++) {
    const gamepad = gamepads[i];
    if (!controllerSupportsStandardMapping(gamepad)) continue;
    firstConnected ??= gamepad;
    if (gamepad.index === currentIndex) current = gamepad;
    else if (!activeOther && gamepadHasActivity(gamepad)) activeOther = gamepad;
  }
  if (activeOther && (!current || !gamepadHasActivity(current)))
    return activeOther;
  return current ?? activeOther ?? firstConnected;
}

export function controllerInputFrame(
  gamepad: GamepadLike,
  tuning: ControllerTuning,
  frame = emptyXboxInputFrame(),
  releaseGate?: ControllerInputReleaseGate,
): XboxInputFrame {
  if (!controllerSupportsStandardMapping(gamepad))
    return resetXboxInputFrame(frame);
  frame.GamepadIndex = 0;
  buttonEntries.forEach(([name, index]) => {
    frame[name] =
      gamepad.buttons[mappedButtonIndex(name, index, tuning)]?.value ?? 0;
  });
  frame.LeftTrigger = trigger(
    gamepad.buttons[6]?.value ?? 0,
    tuning.triggerRange,
  );
  frame.RightTrigger = trigger(
    gamepad.buttons[7]?.value ?? 0,
    tuning.triggerRange,
  );
  frame.LeftThumbXAxis = deadzone(gamepad.axes[0] ?? 0, tuning.stickDeadzone);
  frame.LeftThumbYAxis = deadzone(gamepad.axes[1] ?? 0, tuning.stickDeadzone);
  frame.RightThumbXAxis = deadzone(gamepad.axes[2] ?? 0, tuning.stickDeadzone);
  frame.RightThumbYAxis = deadzone(gamepad.axes[3] ?? 0, tuning.stickDeadzone);
  return releaseGate ? releaseGate.apply(gamepad, tuning, frame) : frame;
}

/** Suppress controls held across startup, capture, focus loss or hotplug. */
export class ControllerInputReleaseGate {
  private pending = true;
  private readonly buttons = new Set<number>();
  private readonly axes = new Set<number>();

  arm(): void {
    this.pending = true;
    this.buttons.clear();
    this.axes.clear();
  }

  prime(gamepad: GamepadLike | undefined, tuning: ControllerTuning): void {
    if (!this.pending || !controllerSupportsStandardMapping(gamepad)) return;
    for (let index = 0; index < gamepad.buttons.length; index++) {
      const button = gamepad.buttons[index];
      if (button && (button.pressed || button.value > 0.05))
        this.buttons.add(index);
    }
    const axisLimit = Math.min(4, gamepad.axes.length);
    for (let index = 0; index < axisLimit; index++) {
      if (Math.abs(gamepad.axes[index] ?? 0) > tuning.stickDeadzone)
        this.axes.add(index);
    }
    this.pending = false;
  }

  apply(
    gamepad: GamepadLike,
    tuning: ControllerTuning,
    frame: XboxInputFrame,
  ): XboxInputFrame {
    this.prime(gamepad, tuning);
    this.buttons.forEach((index) => {
      const button = gamepad.buttons[index];
      if (!button?.pressed && (button?.value ?? 0) <= 0.05)
        this.buttons.delete(index);
    });
    this.axes.forEach((index) => {
      if (Math.abs(gamepad.axes[index] ?? 0) <= tuning.stickDeadzone)
        this.axes.delete(index);
    });
    buttonEntries.forEach(([name, index]) => {
      if (this.buttons.has(mappedButtonIndex(name, index, tuning)))
        frame[name] = 0;
    });
    if (this.buttons.has(6)) frame.LeftTrigger = 0;
    if (this.buttons.has(7)) frame.RightTrigger = 0;
    axisNames.forEach((name, index) => {
      if (this.axes.has(index)) frame[name] = 0;
    });
    return frame;
  }
}

export function tuningForGamepad(
  settings: Pick<AppSettings, "controllerDefaults" | "controllerProfiles">,
  gamepad: GamepadLike,
): ControllerTuning {
  return tuningForController(settings, gamepad.id);
}

export function friendlyControllerName(id: string): string {
  const name = id
    .replace(/\s*\([^)]*(?:vendor|product)[^)]*\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name || "Game controller";
}

function mappedButtonIndex(
  name: XboxButtonName,
  standardIndex: number,
  tuning: ControllerTuning,
): number {
  if (
    (tuning.buttonLayout === "swap-ab" ||
      tuning.buttonLayout === "swap-both") &&
    (name === "A" || name === "B")
  )
    return name === "A" ? buttonMap.B : buttonMap.A;
  if (
    (tuning.buttonLayout === "swap-xy" ||
      tuning.buttonLayout === "swap-both") &&
    (name === "X" || name === "Y")
  )
    return name === "X" ? buttonMap.Y : buttonMap.X;
  return standardIndex;
}

function deadzone(value: number, zone: number): number {
  if (Math.abs(value) < zone) return 0;
  return (value - Math.sign(value) * zone) / (1 - zone);
}

function trigger(value: number, range: number): number {
  return Math.max(0, Math.min(1, value / range));
}
