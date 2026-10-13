import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => ({ count: 0, rejectRename: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      writes.count++;
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (writes.rejectRename) throw new Error("Synthetic persistence failure");
      return actual.renameSync(...args);
    },
  };
});
import { SettingsStore } from "../../src/main/settings-store";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cloud-preference-proof-"));
  writes.count = 0;
  writes.rejectRename = false;
});
afterEach(() => rmSync(directory, { force: true, recursive: true }));

describe("bounded preference work", () => {
  it("persists changed settings and selection once, skipping repeated identical input", () => {
    const path = join(directory, "preferences.json");
    const store = new SettingsStore(path);
    for (let i = 0; i < 10; i++) store.updateSettings({ resolution: 720 });
    for (let i = 0; i < 10; i++) store.setSelectedTitle("game");
    expect(writes.count).toBe(2);
    const restored = new SettingsStore(path);
    expect(restored.settings.resolution).toBe(720);
    expect(restored.selectedTitleId).toBe("game");
  });

  it("keeps both memory and disk unchanged after a failed settings or selection commit", () => {
    const path = join(directory, "preferences.json");
    const store = new SettingsStore(path);
    store.updateSettings({ resolution: 720 });
    store.setSelectedTitle("before");
    const persisted = readFileSync(path, "utf8");
    writes.rejectRename = true;
    expect(() => store.updateSettings({ resolution: 1080 })).toThrow(
      "Synthetic",
    );
    expect(store.settings.resolution).toBe(720);
    expect(readFileSync(path, "utf8")).toBe(persisted);
    expect(() => store.setSelectedTitle("after")).toThrow("Synthetic");
    expect(store.selectedTitleId).toBe("before");
    expect(readFileSync(path, "utf8")).toBe(persisted);
    writes.rejectRename = false;
    store.updateSettings({ resolution: 1080 });
    store.setSelectedTitle("after");
    expect(new SettingsStore(path).settings.resolution).toBe(1080);
    expect(new SettingsStore(path).selectedTitleId).toBe("after");
  });
});
