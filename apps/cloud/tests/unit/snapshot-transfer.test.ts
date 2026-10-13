import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { AppController } from "../../src/main/app-controller";
import { MockPlatformService } from "../../src/main/mock-platform-service";
import { SettingsStore } from "../../src/main/settings-store";
import {
  IPC,
  type AppSnapshot,
  type SnapshotUpdate,
} from "../../src/shared/contracts";
import {
  hydrateSnapshot,
  mergeSnapshot,
} from "../../src/renderer/snapshot-state";

const directories: string[] = [];
afterEach(() => {
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    );
});

async function fixture(size = 1000) {
  const directory = mkdtempSync(join(tmpdir(), "cloud-transfer-"));
  directories.push(directory);
  const platform = new MockPlatformService(true);
  const titles = Array.from({ length: size }, (_, index) => ({
    id: `fixture-${index}`,
    productId: `product-${index}`,
    name: `Fixture ${index}`,
    publisher: "Synthetic",
    recentlyPlayed: false,
    supportedInputTypes: ["Controller"],
  }));
  vi.spyOn(platform, "restore").mockResolvedValue(true);
  vi.spyOn(platform, "listCloudTitles").mockResolvedValue(titles);
  const controller = new AppController(
    platform,
    new SettingsStore(join(directory, "prefs.json")),
    {
      acceleration: "unknown",
      videoDecode: "unknown",
      gpu: "Synthetic",
      secureStorage: false,
      credentialStorage: { backend: "Synthetic", detail: "No credentials" },
    },
    "test",
  );
  const events: SnapshotUpdate[] = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: SnapshotUpdate) => {
        if (channel === IPC.snapshot) events.push(structuredClone(payload));
      },
    },
  } as unknown as BrowserWindow;
  controller.attachWindow(window);
  await controller.initialize();
  return { controller, events, window, titles, platform };
}

describe("catalog snapshot transfer", () => {
  it("sends the large catalog once, then sends zero title entries for unrelated state", async () => {
    const { controller, events } = await fixture(5000);
    expect(
      events.filter((event) => event.cloud.titles?.length === 5000),
    ).toHaveLength(1);
    events.length = 0;
    for (let index = 0; index < 20; index++)
      controller.setFullscreenState(index % 2 === 0);
    expect(events).toHaveLength(20);
    expect(events.every((event) => !Object.hasOwn(event.cloud, "titles"))).toBe(
      true,
    );
    const baseline = controller.getSnapshot();
    expect(baseline.cloud.titles).toHaveLength(5000);
    const last = events.at(-1)!;
    expect(last.revision).toBe(baseline.revision);
    expect(last.fullscreen).toBe(false);
    baseline.cloud.titles[0].name = "Renderer mutation";
    expect(controller.getSnapshot().cloud.titles[0].name).toBe("Fixture 0");
  });

  it("publishes changed catalogs and account clearing, with a fresh baseline for each window", async () => {
    const { controller, events, window, platform } = await fixture();
    events.length = 0;
    controller.selectCloudTitle("fixture-4");
    expect(events.at(-1)?.cloud.selectedTitleId).toBe("fixture-4");
    expect(events.at(-1)?.cloud.titles).toBeUndefined();
    vi.spyOn(platform, "listCloudTitles").mockResolvedValue([]);
    await controller.refreshCloudTitles();
    expect(events.at(-1)?.cloud.titles).toEqual([]);
    controller.attachWindow(window);
    controller.setFullscreenState(true);
    expect(events.at(-1)?.cloud.titles).toEqual([]);
    await controller.signOut();
    expect(events.at(-1)?.cloud.titles).toEqual([]);
    expect(events.at(-1)?.auth.status).toBe("signed-out");
  });

  it("keeps catalog references through metadata changes and rejects obsolete messages", async () => {
    const { controller } = await fixture();
    const baseline = controller.getSnapshot();
    const { titles, ...cloud } = baseline.cloud;
    const event = {
      ...baseline,
      revision: baseline.revision + 1,
      fullscreen: true,
      cloud,
    };
    const current = mergeSnapshot(baseline, event)!;
    expect(current.cloud.titles).toBe(titles);
    expect(current.fullscreen).toBe(true);
    expect(mergeSnapshot(current, baseline)).toBe(current);
    const cleared = mergeSnapshot(current, {
      ...event,
      revision: event.revision + 1,
      auth: { status: "signed-out" },
      cloud: { available: false, status: "idle", titles: [] },
    })!;
    expect(cleared.cloud.titles).toEqual([]);
    expect(mergeSnapshot(cleared, current)).toBe(cleared);
  });

  it("hydrates metadata before a baseline without overwriting newer catalog or auth events", async () => {
    const { controller } = await fixture();
    const baseline = controller.getSnapshot();
    const { titles: _titles, ...cloud } = baseline.cloud;
    const metadata = {
      ...baseline,
      revision: baseline.revision + 1,
      fullscreen: true,
      cloud,
    };
    expect(mergeSnapshot(undefined, metadata)).toBeUndefined();
    const hydrated = hydrateSnapshot(undefined, baseline, metadata);
    expect(hydrated.cloud.titles).toBe(baseline.cloud.titles);
    expect(hydrated.fullscreen).toBe(true);
    const current = {
      ...baseline,
      revision: metadata.revision + 1,
      cloud: { ...baseline.cloud, titles: [] },
      auth: { status: "signed-out" as const },
    };
    expect(hydrateSnapshot(current, baseline, metadata)).toBe(current);
    const newerBaseline = { ...baseline, revision: current.revision + 1 };
    expect(hydrateSnapshot(current, newerBaseline, metadata)).toBe(
      newerBaseline,
    );
  });

  it("handles either baseline/metadata queue order while retaining a later catalog", async () => {
    const { controller } = await fixture();
    const baseline = controller.getSnapshot();
    const catalog = {
      ...baseline,
      revision: baseline.revision + 1,
      cloud: {
        ...baseline.cloud,
        titles: [{ ...baseline.cloud.titles[0], name: "New catalog" }],
      },
    };
    const { titles: _titles, ...cloud } = catalog.cloud;
    const metadata = {
      ...catalog,
      revision: catalog.revision + 1,
      cloud,
      fullscreen: true,
    };
    for (const early of [undefined, catalog]) {
      let current: AppSnapshot | undefined = early;
      current = hydrateSnapshot(current, baseline, early);
      current = mergeSnapshot(current, catalog);
      current = mergeSnapshot(current, metadata);
      expect(current?.cloud.titles).toBe(catalog.cloud.titles);
      expect(current?.fullscreen).toBe(true);
    }
  });
});
