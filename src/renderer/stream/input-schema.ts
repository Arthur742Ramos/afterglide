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
  { keys: "Menu + View", action: "Xbox button" },
];

export const STEAM_INPUT_CONTROL_GUIDE: readonly ControlGuideItem[] = [
  { keys: "L4 → F10", action: "Afterglide controls" },
  { keys: "R4 → F9", action: "Performance stats" },
];

export const LOCAL_CONTROL_SHORTCUTS = {
  controls: ["Escape", "F10"],
  performance: ["F3", "F9"],
} as const;

export function isLocalControlShortcut(
  key: string,
  action: keyof typeof LOCAL_CONTROL_SHORTCUTS,
): boolean {
  return (LOCAL_CONTROL_SHORTCUTS[action] as readonly string[]).includes(key);
}

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
