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
    store.updateSettings({ resolution: 720, reducedMotion: true });
    store.setSelectedConsole("den");

    const restored = new SettingsStore(path);
    expect(restored.settings).toMatchObject({
      resolution: 720,
      reducedMotion: true,
      showPerformance: false,
    });
    expect(restored.selectedConsoleId).toBe("den");
    expect(readFileSync(path, "utf8")).toContain('"resolution": 720');
  });
});
