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

export function emptyXboxInputFrame(): XboxInputFrame {
  return {
    GamepadIndex: 0,
    Nexus: 0,
    Menu: 0,
    View: 0,
    A: 0,
    B: 0,
    X: 0,
    Y: 0,
    DPadUp: 0,
    DPadDown: 0,
    DPadLeft: 0,
    DPadRight: 0,
    LeftShoulder: 0,
    RightShoulder: 0,
    LeftThumb: 0,
    RightThumb: 0,
    LeftThumbXAxis: 0,
    LeftThumbYAxis: 0,
    RightThumbXAxis: 0,
    RightThumbYAxis: 0,
    LeftTrigger: 0,
    RightTrigger: 0,
  };
}

export function resetXboxInputFrame(frame: XboxInputFrame): XboxInputFrame {
  frame.GamepadIndex = 0;
  frame.Nexus = 0;
  frame.Menu = 0;
  frame.View = 0;
  frame.A = 0;
  frame.B = 0;
  frame.X = 0;
  frame.Y = 0;
  frame.DPadUp = 0;
  frame.DPadDown = 0;
  frame.DPadLeft = 0;
  frame.DPadRight = 0;
  frame.LeftShoulder = 0;
  frame.RightShoulder = 0;
  frame.LeftThumb = 0;
  frame.RightThumb = 0;
  frame.LeftThumbXAxis = 0;
  frame.LeftThumbYAxis = 0;
  frame.RightThumbXAxis = 0;
  frame.RightThumbYAxis = 0;
  frame.LeftTrigger = 0;
  frame.RightTrigger = 0;
  return frame;
}

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
  if (codes.has("KeyA") || codes.has("KeyD"))
    frame.LeftThumbXAxis = axis(codes, "KeyA", "KeyD");
  if (codes.has("KeyW") || codes.has("KeyS"))
    frame.LeftThumbYAxis = axis(codes, "KeyW", "KeyS");
  if (codes.has("KeyJ") || codes.has("KeyL"))
    frame.RightThumbXAxis = axis(codes, "KeyJ", "KeyL");
  if (codes.has("KeyI") || codes.has("KeyK"))
    frame.RightThumbYAxis = axis(codes, "KeyI", "KeyK");
  if (codes.has("KeyZ")) frame.LeftTrigger = 1;
  if (codes.has("KeyC")) frame.RightTrigger = 1;
}

function axis(
  codes: ReadonlySet<string>,
  negative: string,
  positive: string,
): number {
  return Number(codes.has(positive)) - Number(codes.has(negative));
}
