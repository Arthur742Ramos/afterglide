export type XboxButtonName =
  | "Nexus"
  | "Menu"
  | "View"
  | "A"
  | "B"
  | "X"
  | "Y"
  | "DPadUp"
  | "DPadDown"
  | "DPadLeft"
  | "DPadRight"
  | "LeftShoulder"
  | "RightShoulder"
  | "LeftThumb"
  | "RightThumb";

export type XboxInputFrame = Record<XboxButtonName, number> & {
  GamepadIndex: number;
  LeftThumbXAxis: number;
  LeftThumbYAxis: number;
  RightThumbXAxis: number;
  RightThumbYAxis: number;
  LeftTrigger: number;
  RightTrigger: number;
};

export interface ControlGuideItem {
  keys: string;
  action: string;
}

export const CONTROLLER_CONTROL_GUIDE: readonly ControlGuideItem[] = [
  { keys: "D-pad / Left stick", action: "Navigate Afterglide" },
  { keys: "A / B", action: "Select / Back" },
  { keys: "L3 + R3", action: "Afterglide controls" },
  { keys: "Menu + View", action: "Xbox button" },
];

export const KEYBOARD_CONTROL_GUIDE: readonly ControlGuideItem[] = [
  { keys: "WASD", action: "Left stick" },
  { keys: "IJKL", action: "Right stick" },
  { keys: "Arrows", action: "D-pad" },
  { keys: "Space / Enter", action: "A" },
  { keys: "Backspace", action: "B" },
  { keys: "X / Y", action: "X / Y" },
  { keys: "Q / E", action: "LB / RB" },
  { keys: "Z / C", action: "LT / RT" },
  { keys: "F / H", action: "L3 / R3" },
  { keys: "V / M", action: "View / Menu" },
  { keys: "N", action: "Xbox button" },
];

const digitalKeyboardMap: Partial<Record<string, keyof XboxInputFrame>> = {
  Enter: "A",
  Space: "A",
  Backspace: "B",
  KeyX: "X",
  KeyY: "Y",
  ArrowUp: "DPadUp",
  ArrowDown: "DPadDown",
  ArrowLeft: "DPadLeft",
  ArrowRight: "DPadRight",
  KeyQ: "LeftShoulder",
  KeyE: "RightShoulder",
  KeyF: "LeftThumb",
  KeyH: "RightThumb",
  KeyM: "Menu",
  KeyV: "View",
  KeyN: "Nexus",
};

const keyboardCodes = new Set([
  ...Object.keys(digitalKeyboardMap),
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyZ",
  "KeyC",
]);

export function isKeyboardControlCode(code: string): boolean {
  return keyboardCodes.has(code);
}

export function applyKeyboardInput(
  frame: XboxInputFrame,
  codes: ReadonlySet<string>,
): void {
  codes.forEach((code) => {
    const name = digitalKeyboardMap[code];
    if (name) frame[name] = 1;
  });
  frame.LeftThumbXAxis = axis(codes, "KeyA", "KeyD");
  frame.LeftThumbYAxis = axis(codes, "KeyW", "KeyS");
  frame.RightThumbXAxis = axis(codes, "KeyJ", "KeyL");
  frame.RightThumbYAxis = axis(codes, "KeyI", "KeyK");
  frame.LeftTrigger = codes.has("KeyZ") ? 1 : 0;
  frame.RightTrigger = codes.has("KeyC") ? 1 : 0;
}

function axis(
  codes: ReadonlySet<string>,
  negative: string,
  positive: string,
): number {
  return Number(codes.has(positive)) - Number(codes.has(negative));
}
