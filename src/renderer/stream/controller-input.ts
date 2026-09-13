import type { AppSettings, ControllerTuning } from "../../shared/contracts";
import { tuningForController } from "../../shared/controller-settings";
import {
  emptyXboxInputFrame,
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

export function connectedGamepads(
  gamepads: readonly (GamepadLike | null)[],
): GamepadLike[] {
  return gamepads.filter((gamepad): gamepad is GamepadLike =>
    Boolean(gamepad?.connected),
  );
}

export function gamepadHasActivity(gamepad: GamepadLike): boolean {
  return (
    gamepad.buttons.some((button) => button.pressed || button.value > 0.18) ||
    gamepad.axes.some((axis) => Math.abs(axis) > 0.18)
  );
}

export function selectController(
  gamepads: readonly (GamepadLike | null)[],
  preferredId: string,
  currentIndex?: number,
): GamepadLike | undefined {
  const connected = connectedGamepads(gamepads);
  if (preferredId)
    return connected.find((gamepad) => gamepad.id === preferredId);
  const current = connected.find((gamepad) => gamepad.index === currentIndex);
  const active = connected.find(
    (gamepad) => gamepad.index !== currentIndex && gamepadHasActivity(gamepad),
  );
  if (active && (!current || !gamepadHasActivity(current))) return active;
  return current ?? connected.find(gamepadHasActivity) ?? connected[0];
}

export function controllerInputFrame(
  gamepad: GamepadLike,
  tuning: ControllerTuning,
): XboxInputFrame {
  const frame = emptyXboxInputFrame();
  (Object.entries(buttonMap) as Array<[XboxButtonName, number]>).forEach(
    ([name, index]) => {
      frame[name] =
        gamepad.buttons[mappedButtonIndex(name, index, tuning)]?.value ?? 0;
    },
  );
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
  return frame;
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
