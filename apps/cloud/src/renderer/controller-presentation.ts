export type ControllerFamily = "xbox" | "playstation";

// Identification changes local labels only. Chromium owns the input mapping.
export function controllerFamily(id: string): ControllerFamily {
  return /dualsense|054c.*(?:0ce6|0df2)/i.test(id) ? "playstation" : "xbox";
}

const playstationLabels: Record<string, string> = {
  A: "Cross",
  B: "Circle",
  X: "Square",
  Y: "Triangle",
  LB: "L1",
  RB: "R1",
  LT: "L2",
  RT: "R2",
  View: "Create",
  Menu: "Options",
  Xbox: "PS",
  "A / B": "Cross / Circle",
  "LB / RB": "L1 / R1",
  "LT / RT": "L2 / R2",
  "Menu + View": "Options + Create",
};

export function controllerPrompt(
  label: string,
  family: ControllerFamily,
): string {
  return family === "playstation" ? (playstationLabels[label] ?? label) : label;
}
