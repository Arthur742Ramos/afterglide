import { describe, expect, it } from "vitest";
import {
  controllerFamily,
  controllerPrompt,
} from "../../src/renderer/controller-presentation";

describe("physical controller prompts", () => {
  it.each([
    "DualSense Wireless Controller",
    "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)",
    "DualSense Edge (Vendor: 054c Product: 0df2)",
  ])("labels %s with physical PlayStation controls", (id) => {
    const family = controllerFamily(id);
    expect(controllerPrompt("A", family)).toBe("Cross");
    expect(controllerPrompt("B", family)).toBe("Circle");
    expect(controllerPrompt("X", family)).toBe("Square");
    expect(controllerPrompt("Y", family)).toBe("Triangle");
    expect(controllerPrompt("Menu + View", family)).toBe("Options + Create");
  });
  it("keeps Xbox and unknown identifiers on Xbox protocol labels", () => {
    for (const id of [
      "Xbox Wireless Controller",
      "045e-0b13",
      "Wireless Controller",
      "Generic gamepad",
    ]) {
      expect(controllerFamily(id)).toBe("xbox");
      expect(controllerPrompt("A", controllerFamily(id))).toBe("A");
    }
    expect(controllerPrompt("Enter", "playstation")).toBe("Enter");
    expect(controllerPrompt("L3 + R3", "playstation")).toBe("L3 + R3");
  });
});
