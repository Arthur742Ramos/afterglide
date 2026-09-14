import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../../src/main/settings-store";

let directory = "";

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("merges defaults, persists updates, and keeps files private", () => {
    directory = mkdtempSync(join(tmpdir(), "afterglide-settings-"));
    const path = join(directory, "preferences.json");
    const store = new SettingsStore(path);
    expect(store.settings.resolution).toBe(1080);
    expect(store.settings.controllerMenuShortcut).toBe("stick-chord");
    store.updateSettings({
      resolution: 720,
      reducedMotion: true,
      controllerMenuShortcut: "steam-input",
      preferredControllerId: "Xbox Wireless Controller",
      controllerProfiles: [
        {
          id: "Xbox Wireless Controller",
          rumble: "low",
          buttonLayout: "swap-ab",
          stickDeadzone: 0.12,
          triggerRange: 0.75,
        },
      ],
    });
    store.setSelectedConsole("den");

    const restored = new SettingsStore(path);
    expect(restored.settings).toMatchObject({
      resolution: 720,
      reducedMotion: true,
      showPerformance: false,
      controllerMenuShortcut: "steam-input",
      preferredControllerId: "Xbox Wireless Controller",
      controllerProfiles: [
        expect.objectContaining({
          id: "Xbox Wireless Controller",
          rumble: "low",
          stickDeadzone: 0.12,
        }),
      ],
    });
    expect(restored.selectedConsoleId).toBe("den");
    expect(readFileSync(path, "utf8")).toContain('"resolution": 720');
  });

  it("repairs malformed controller preferences from disk", () => {
    directory = mkdtempSync(join(tmpdir(), "afterglide-settings-"));
    const path = join(directory, "preferences.json");
    const store = new SettingsStore(path);
    store.updateSettings({
      controllerDefaults: {
        rumble: "loud",
        buttonLayout: "inverted",
        stickDeadzone: 0.9,
        triggerRange: -1,
      },
      controllerProfiles: [
        { id: "", rumble: "low" },
        { id: "Valid", rumble: "off", stickDeadzone: 0.04 },
      ],
    } as never);
    expect(store.settings.controllerDefaults).toEqual({
      rumble: "full",
      buttonLayout: "standard",
      stickDeadzone: 0.08,
      triggerRange: 1,
    });
    expect(store.settings.controllerProfiles).toEqual([
      {
        id: "Valid",
        rumble: "off",
        buttonLayout: "standard",
        stickDeadzone: 0.04,
        triggerRange: 1,
      },
    ]);
  });

  it("persists playback settings, bounds volume, and rejects invalid updates", () => {
    directory = mkdtempSync(join(tmpdir(), "afterglide-settings-"));
    const path = join(directory, "preferences.json");
    const store = new SettingsStore(path);
    expect(store.settings).toMatchObject({
      volume: 1,
      muted: false,
      videoFit: "fit",
      inputPolling: "responsive",
    });
    store.updateSettings({
      volume: 0.4,
      muted: true,
      videoFit: "fill",
      inputPolling: "efficient",
    });
    expect(new SettingsStore(path).settings).toMatchObject({
      volume: 0.4,
      muted: true,
      videoFit: "fill",
      inputPolling: "efficient",
    });
    store.updateSettings({ volume: 2 });
    expect(store.settings.volume).toBe(1);
    store.updateSettings({ volume: -1 });
    expect(store.settings.volume).toBe(0);
    store.updateSettings({
      volume: Number.NaN,
      videoFit: "stretch",
      inputPolling: 0,
      muted: "yes",
    } as never);
    expect(store.settings).toMatchObject({
      volume: 0,
      muted: true,
      videoFit: "fill",
      inputPolling: "efficient",
    });
  });
});
