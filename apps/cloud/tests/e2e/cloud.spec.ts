import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import axeCore from "axe-core";
import { IPC } from "../../src/shared/contracts";

const root = join(import.meta.dirname, "../..");
let app: ElectronApplication;
let directory: string;
let errors: string[];

async function launch(
  scenario = "happy",
  signedIn = true,
  onboarding = false,
  existingDirectory?: string,
  scale = 1,
): Promise<Page> {
  mkdirSync(join(root, "artifacts/e2e"), { recursive: true });
  directory =
    existingDirectory ?? mkdtempSync(join(root, "artifacts/e2e/cloud-"));
  errors = [];
  app = await electron.launch({
    args: ["."],
    cwd: root,
    env: {
      ...process.env,
      AFTERGLIDE_CLOUD_E2E: "1",
      AFTERGLIDE_CLOUD_E2E_SIGNED_IN: signedIn ? "1" : "0",
      AFTERGLIDE_CLOUD_E2E_USER_DATA: directory,
      AFTERGLIDE_CLOUD_E2E_SCENARIO: scenario,
      AFTERGLIDE_CLOUD_E2E_ONBOARDING: onboarding ? "show" : "skip",
    },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  if (scale !== 1) {
    // Chromium density emulation verifies rasterization; this is not a Mac run.
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: scale,
      mobile: false,
    });
  }
  return page;
}

test.afterEach(async () => {
  if (app) await app.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

test("Health exports complete reports without a native dialog and recovers from write failure", async () => {
  const page = await launch();
  const downloads = join(directory, "Downloads");
  mkdirSync(downloads);
  await app.evaluate(
    ({ app }, path) => app.setPath("downloads", path),
    downloads,
  );
  await page.getByRole("button", { name: "Health", exact: true }).click();
  const exportButton = page.getByRole("button", {
    name: "Export performance report",
    exact: true,
  });
  for (let count = 1; count <= 2; count++) {
    await exportButton.click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Performance report saved to" }),
    ).toContainText("Performance report saved to");
    const files = readdirSync(downloads);
    expect(files).toHaveLength(count);
    for (const file of files) {
      const report = JSON.parse(readFileSync(join(downloads, file), "utf8"));
      expect(report.application.environment).toBe("test");
      expect(report.retainedSamples).toBe(report.samples.length);
    }
  }
  rmSync(downloads, { recursive: true });
  await exportButton.click();
  await expect(page.getByRole("alert")).toContainText(
    "Couldn’t save to Downloads",
  );
  await expect(exportButton).toBeEnabled();
  mkdirSync(downloads);
  await exportButton.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Performance report saved to" }),
  ).toContainText("Performance report saved to");
  expect(readdirSync(downloads)).toHaveLength(1);
});

test("Health distinguishes optional decoder, polling and power readings at desktop and 200 percent zoom", async () => {
  const page = await launch();
  // Snapshot fixtures must start after restoration, or their higher revision
  // can replay the boot state over the already visible Health page.
  await expect(page.getByRole("button", { name: /Play again/ })).toBeVisible();
  if (process.platform === "win32" || process.platform === "darwin") {
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("on-ac");
      powerMonitor.emit("speed-limit-change", { limit: 0 });
    });
    expect(
      await page.evaluate(
        async () => (await window.afterglideCloud.getSnapshot()).powerContext,
      ),
    ).toMatchObject({ onBattery: false, speedLimitPercent: 0 });
  }
  const baseline = await page.evaluate(() =>
    window.afterglideCloud.getSnapshot(),
  );
  expect(baseline.auth.status).toBe("signed-in");
  const row = (label: string) =>
    page.getByText(label, { exact: true }).locator("..");
  await page.getByRole("button", { name: "Health", exact: true }).click();
  for (const value of [undefined, false, true] as const) {
    await app.evaluate(
      ({ BrowserWindow }, snapshot) => {
        BrowserWindow.getAllWindows()[0].webContents.send(
          "afterglide-cloud:snapshot",
          snapshot,
        );
      },
      {
        ...baseline,
        revision:
          baseline.revision + (value === undefined ? 100 : value ? 102 : 101),
        powerContext:
          value === undefined
            ? {}
            : {
                onBattery: false,
                thermalState: "unknown",
                speedLimitPercent: 0,
              },
        telemetry: {
          ...baseline.telemetry,
          powerEfficientDecoder: value,
          inputPolling:
            value === undefined
              ? undefined
              : {
                  targetMs: 4,
                  samples: 250,
                  windowMs: 1000,
                  meanIntervalMs: 4,
                  p95UpperMs: 4,
                  maxIntervalMs: 4,
                  meanJitterMs: 0,
                  longGaps: 0,
                },
        },
      },
    );
    await expect(row("Power-efficient decoder (browser)")).toContainText(
      value === undefined
        ? "Unavailable"
        : value
          ? "Reported true"
          : "Reported false",
    );
    await expect(row("JS poll mean jitter")).toContainText(
      value === undefined ? "Unavailable" : "0.00 ms",
    );
    await expect(row("JS poll gaps over 32 ms")).toContainText(
      value === undefined ? "Unavailable" : "0",
    );
    await expect(row("Power source")).toContainText(
      value === undefined ? "Unavailable" : "AC power",
    );
    await expect(row("Last CPU speed-limit notification")).toContainText(
      value === undefined ? "Unknown" : "0%",
    );
  }
  for (const factor of [1, 2]) {
    await zoom(page, factor);
    await accessible(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await reachable(
      page,
      page.getByRole("button", {
        name: "Export performance report",
        exact: true,
      }),
    );
    await row("Power-efficient decoder (browser)").evaluate((element) =>
      element.scrollIntoView({ block: "start", behavior: "instant" }),
    );
    // Native capture preserves the whole Electron viewport at browser zoom.
    const capture = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    writeFileSync(
      join(root, `artifacts/e2e/cloud-telemetry-health-${factor}.png`),
      Buffer.from(capture, "base64"),
    );
  }
});

test("display-sleep protection starts during pending provisioning and releases on cancel", async () => {
  const page = await launch("pending-cloud-launch");
  await app.evaluate(({ powerSaveBlocker }) => {
    const ids: number[] = [];
    const start = powerSaveBlocker.start.bind(powerSaveBlocker);
    powerSaveBlocker.start = (type) => {
      const id = start(type);
      ids.push(id);
      return id;
    };
    (
      globalThis as unknown as { streamSleepBlockers: number[] }
    ).streamSleepBlockers = ids;
  });
  await page.getByRole("button", { name: /Play again/ }).click();
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      async () => (await window.afterglideCloud.getSnapshot()).session.phase,
    ),
  ).toBe("provisioning");
  expect(
    await app.evaluate(({ powerSaveBlocker }) => {
      const ids = (globalThis as unknown as { streamSleepBlockers: number[] })
        .streamSleepBlockers;
      return ids.length === 1 && powerSaveBlocker.isStarted(ids[0]);
    }),
  ).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeVisible();
  expect(
    await app.evaluate(({ powerSaveBlocker }) =>
      (
        globalThis as unknown as { streamSleepBlockers: number[] }
      ).streamSleepBlockers.every((id) => !powerSaveBlocker.isStarted(id)),
    ),
  ).toBe(true);
});

test("the FPS pipeline is readable in the overlay and Health at desktop and large zoom", async () => {
  const page = await launch();
  await play(page);
  await page.keyboard.press("F3");
  const strip = page.getByLabel("Stream performance");
  for (const label of ["INCOMING", "DECODED", "DISPLAYED"])
    await expect(
      strip.locator(".metric").filter({ hasText: label }),
    ).toContainText("60 FPS");
  for (const zoom of [1, 2]) {
    await app.evaluate(
      ({ BrowserWindow }, value) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value),
      zoom,
    );
    await expect
      .poll(() =>
        strip.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            element.scrollWidth <= element.clientWidth
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: join(root, `artifacts/e2e/cloud-fps-overlay-${zoom}.png`),
    });
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Leave Xbox stream" }).click();
  await page.getByRole("button", { name: "Health", exact: true }).click();
  for (const label of ["Incoming FPS", "Decoded FPS", "Displayed FPS"])
    await expect(
      page.getByText(label, { exact: true }).locator(".."),
    ).toContainText("60.0 fps");
  for (const zoom of [1, 2]) {
    await app.evaluate(
      ({ BrowserWindow }, value) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value),
      zoom,
    );
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    if (zoom === 2)
      await page
        .getByText("Incoming FPS", { exact: true })
        .evaluate((element) =>
          element
            .closest(".diagnostic-row")
            ?.scrollIntoView({ block: "start" }),
        );
    await page.screenshot({
      path: join(root, `artifacts/e2e/cloud-fps-health-${zoom}.png`),
    });
  }
});

async function play(page: Page) {
  await page.getByRole("button", { name: /Play again/ }).click();
  await expect(page.getByTestId("mock-stream")).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await window.afterglideCloud.getSnapshot()).session.phase,
      ),
    )
    .toBe("streaming");
}

async function simulateOffline(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    window.dispatchEvent(new Event("offline"));
  });
}

test("first sign-in leads directly to cloud readiness and Library", async () => {
  const page = await launch("happy", false, true);
  await expect(
    page.getByRole("button", { name: /Sign in with Microsoft/ }),
  ).toBeVisible();
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-welcome.png"),
  });
  await page.getByRole("button", { name: /Sign in with Microsoft/ }).click();
  await expect(
    page.getByText("Cloud library ready", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/No console/)).toHaveCount(0);
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-readiness.png"),
  });
  await page
    .getByRole("button", { name: /Continue to Afterglide Cloud/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your cloud library." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Home", exact: true }),
  ).toHaveCount(0);
});

test("library search, recent filter and paging remain reachable", async () => {
  const page = await launch("large-cloud-catalog");
  await expect(page.locator(".game-grid button")).toHaveCount(48);
  await page.getByRole("button", { name: "Show 32 more games" }).click();
  await expect(page.locator(".game-grid button")).toHaveCount(80);
  await page
    .getByRole("textbox", { name: "Search cloud games" })
    .fill("Cloud Game 80");
  await expect(page.locator(".game-grid button")).toHaveCount(1);
  await expect(page.locator(".cloud-feature")).toHaveCount(0);
  await page.screenshot({ path: join(root, "artifacts/e2e/cloud-search.png") });
  await page.getByRole("button", { name: "Clear game search" }).click();
  await page
    .getByRole("button", { name: "Recently played", exact: true })
    .click();
  await expect(page.locator(".game-grid button")).toHaveCount(1);
});

test("search failure has a retry and never claims it is still loading", async () => {
  const page = await launch();
  await expect(page.locator(".game-grid button")).toHaveCount(3);
  await app.evaluate(({ ipcMain }, channel) => {
    let attempts = 0;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => {
      if (attempts++ === 0) throw new Error("Simulated search interruption");
      return [];
    });
  }, IPC.searchCloudTitles);
  await page
    .getByRole("textbox", { name: "Search cloud games" })
    .fill("unmatched-game");
  await expect(page.getByRole("alert")).toHaveText(
    /Cloud search didn['’]t finish\. Try your search again\./,
  );
  await expect(page.getByText(/Checking all cloud games/)).toHaveCount(0);
  await expect(page.getByText("Searching all cloud games.")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry search" }).click();
  await expect(
    page.getByText(/No games match ["“]unmatched-game["”]\./),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

for (const input of ["keyboard", "controller"] as const) {
  for (const result of ["empty", "matching"] as const) {
    test(`successful ${result} retry preserves ${input} focus in search`, async () => {
      const page = await launch();
      await expect(page.locator(".game-grid button")).toHaveCount(3);
      const title = await page.evaluate(async () => ({
        ...(await window.afterglideCloud.getSnapshot()).cloud.titles[0],
        name: "Focus retry fixture",
      }));
      await app.evaluate(
        ({ ipcMain }, value) => {
          let attempts = 0;
          ipcMain.removeHandler(value.channel);
          ipcMain.handle(value.channel, () => {
            if (attempts++ === 0) throw new Error("Simulated search failure");
            return value.titles;
          });
        },
        {
          channel: IPC.searchCloudTitles,
          titles: result === "empty" ? [] : [title],
        },
      );
      const search = page.getByRole("textbox", { name: "Search cloud games" });
      await search.fill("Focus retry");
      const retry = page.getByRole("button", { name: "Retry search" });
      await expect(retry).toBeVisible();
      await retry.focus();
      if (input === "keyboard") await page.keyboard.press("Enter");
      else
        await page.evaluate(() =>
          window.afterglideCloudTest!.injectGamepad("accept"),
        );
      await expect(retry).toHaveCount(0);
      if (result === "empty")
        await expect(page.getByText(/No games match/)).toBeVisible();
      await expect(page.locator(".game-grid button")).toHaveCount(
        result === "empty" ? 0 : 1,
      );
      await expect(page.getByText(/Searching all cloud games/)).toHaveCount(0);
      await expect(search).toHaveValue("Focus retry");
      await expect(search).toBeFocused();
      if (input === "keyboard" && result === "empty")
        await page.screenshot({
          path: join(root, "artifacts/e2e/cloud-audit-retry-focus.png"),
        });
    });
  }
}

for (const moved of ["another control", "Settings"] as const) {
  test(`pending retry preserves a newer focus choice in ${moved}`, async () => {
    const page = await launch();
    await expect(page.locator(".game-grid button")).toHaveCount(3);
    await app.evaluate(({ ipcMain }, channel) => {
      let attempts = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => {
        if (attempts++ === 0) throw new Error("Simulated search failure");
        return new Promise((resolve) => {
          (
            globalThis as unknown as { releaseAuditSearch: () => void }
          ).releaseAuditSearch = () => resolve([]);
        });
      });
    }, IPC.searchCloudTitles);
    const search = page.getByRole("textbox", { name: "Search cloud games" });
    await search.fill("Focus retry");
    const retry = page.getByRole("button", { name: "Retry search" });
    await expect(retry).toBeVisible();
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            typeof (
              globalThis as unknown as { releaseAuditSearch?: () => void }
            ).releaseAuditSearch,
        ),
      )
      .toBe("function");
    if (moved === "another control") {
      await search.focus();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "Clear game search" }),
      ).toBeFocused();
    } else {
      await nativeCommand("desktop-settings");
      await expect(
        page.getByRole("switch", { name: "Performance overlay" }),
      ).toBeFocused();
    }
    await app.evaluate(() =>
      (
        globalThis as unknown as { releaseAuditSearch: () => void }
      ).releaseAuditSearch(),
    );
    if (moved === "another control") {
      await expect(page.getByText(/No games match/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Clear game search" }),
      ).toBeFocused();
      await expect(search).toHaveValue("Focus retry");
    } else {
      // A queued cancelled reply cannot focus the unmounted search input.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(
        page.getByRole("switch", { name: "Performance overlay" }),
      ).toBeFocused();
      await expect(search).toHaveCount(0);
    }
  });
}

test("rapid keyboard retries retain focus through another failure and success", async () => {
  const page = await launch();
  await expect(page.locator(".game-grid button")).toHaveCount(3);
  await app.evaluate(({ ipcMain }, channel) => {
    let attempts = 0;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => {
      (
        globalThis as unknown as { auditSearchAttempts: number }
      ).auditSearchAttempts = ++attempts;
      if (attempts < 3) throw new Error("Simulated repeated search failure");
      return [];
    });
  }, IPC.searchCloudTitles);
  const search = page.getByRole("textbox", { name: "Search cloud games" });
  await search.fill("Focus retry");
  const retry = page.getByRole("button", { name: "Retry search" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(retry).toBeVisible();
    await retry.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(search).toBeFocused();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as unknown as { auditSearchAttempts: number })
              .auditSearchAttempts,
        ),
      )
      .toBe(attempt + 2);
  }
  await expect(page.getByText(/No games match/)).toBeVisible();
  await expect(retry).toHaveCount(0);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("Focus retry");
});

test("failed artwork keeps a usable fallback and retries a replacement URL", async () => {
  const page = await launch("cloud-artwork");
  await page.route("https://images.xboxlive.com/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#244477"/></svg>',
    }),
  );
  await page.reload();
  const artwork = page.locator(".cloud-feature img");
  await expect(artwork).toBeVisible();
  const before = await artwork.boundingBox();
  await artwork.dispatchEvent("error");
  const fallback = page.locator(".cloud-feature .game-art-fallback");
  await expect(fallback).toBeVisible();
  expect(await fallback.boundingBox()).toEqual(before);
  await expect(page.getByRole("button", { name: /Play again/ })).toBeEnabled();
  const snapshot = await page.evaluate(() =>
    window.afterglideCloud.getSnapshot(),
  );
  snapshot.cloud.titles[0].imageUrl =
    "https://images.xboxlive.com/e2e-replacement.svg";
  snapshot.revision++;
  await app.evaluate(
    ({ BrowserWindow }, value) => {
      BrowserWindow.getAllWindows()[0].webContents.send(
        value.channel,
        value.snapshot,
      );
    },
    { channel: IPC.snapshot, snapshot },
  );
  await expect(artwork).toHaveAttribute(
    "src",
    "https://images.xboxlive.com/e2e-replacement.svg",
  );
  await expect(fallback).toHaveCount(0);
  // Returning to a previously failed URL must try the image again.
  snapshot.cloud.titles[0].imageUrl =
    "https://images.xboxlive.com/e2e-cover.svg";
  snapshot.revision++;
  await app.evaluate(
    ({ BrowserWindow }, value) => {
      BrowserWindow.getAllWindows()[0].webContents.send(
        value.channel,
        value.snapshot,
      );
    },
    { channel: IPC.snapshot, snapshot },
  );
  await expect(artwork).toHaveAttribute(
    "src",
    "https://images.xboxlive.com/e2e-cover.svg",
  );
  await expect(fallback).toHaveCount(0);
});

test("Settings handles Back as soon as its heading is committed", async () => {
  const page = await launch();
  const search = page.getByRole("textbox", { name: "Search cloud games" });
  await search.fill("Sea");
  await search.focus();
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (
        document.querySelector(".settings-page h1")?.textContent !== "Settings"
      )
        return;
      observer.disconnect();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      document.body.dataset.settingsBackDispatched = "true";
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await nativeCommand("desktop-settings");
  await expect(page.locator("body")).toHaveAttribute(
    "data-settings-back-dispatched",
    "true",
  );
  await expect(search).toHaveValue("Sea");
  await expect(search).toBeFocused();
  await expect(page.locator(".game-grid button")).toHaveCount(1);
});

test("Settings returns to the same Library search, filter, page and focus", async () => {
  const page = await launch("large-cloud-catalog");
  await page.getByRole("button", { name: "Show 32 more games" }).click();
  const lastGame = page.locator(".game-grid button").last();
  await lastGame.focus();
  await nativeCommand("desktop-settings");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".game-grid button")).toHaveCount(80);
  // Controller navigation's initial focus pass must not overwrite restoration.
  await page.waitForTimeout(100);
  await expect(lastGame).toBeFocused();
  await page
    .getByRole("button", { name: "Recently played", exact: true })
    .click();
  const search = page.getByRole("textbox", { name: "Search cloud games" });
  await search.fill("Cloud Game 01");
  await search.focus();
  await nativeCommand("desktop-settings");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("Cloud Game 01");
  await page.waitForTimeout(100);
  await expect(search).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Recently played", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".game-grid button")).toHaveCount(1);
});

for (const choice of ["search", "rail", "restore"] as const) {
  test(`Library return preserves ${choice} focus before the next renderer frame`, async () => {
    const page = await launch();
    const lastGame = page.locator(".game-grid button").last();
    await expect(page.locator(".game-grid button")).toHaveCount(3);
    const savedFocus = await lastGame.getAttribute("data-library-focus");
    const search = page.getByRole("textbox", { name: "Search cloud games" });
    const settings = page.getByRole("button", {
      name: "Settings",
      exact: true,
    });
    for (const factor of [1, 2]) {
      await zoom(page, factor);
      await lastGame.focus();
      await settings.click();
      await expect(
        page.getByRole("switch", { name: "Performance overlay" }),
      ).toBeFocused();
      // Hold renderer frames to exercise an early focus choice before any
      // deferred callbacks can overwrite it (the former restoration did so).
      await page.evaluate(() => {
        const request = window.requestAnimationFrame;
        const cancel = window.cancelAnimationFrame;
        const frames = new Map<number, FrameRequestCallback>();
        let handle = 0;
        window.requestAnimationFrame = (callback) => {
          frames.set(--handle, callback);
          return handle;
        };
        window.cancelAnimationFrame = (id) => {
          if (!frames.delete(id)) cancel.call(window, id);
        };
        Object.assign(window, {
          releaseLibraryFrames: () => {
            window.requestAnimationFrame = request;
            window.cancelAnimationFrame = cancel;
            for (const callback of frames.values()) callback(performance.now());
            frames.clear();
            Reflect.deleteProperty(window, "releaseLibraryFrames");
          },
        });
      });
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await expect(search).toBeVisible();
      if (choice === "search") await search.focus();
      if (choice === "rail") await settings.focus();
      const expected =
        choice === "search" ? search : choice === "rail" ? settings : lastGame;
      if (choice !== "restore") await expect(expected).toBeFocused();
      const restored = await page.evaluate(() => {
        (
          window as unknown as { releaseLibraryFrames: () => void }
        ).releaseLibraryFrames();
        const active = document.activeElement as HTMLElement;
        return {
          focus:
            active.dataset.libraryFocus ?? active.getAttribute("aria-label"),
        };
      });
      // Check the immediate outcome: polling must not hide a focus override.
      expect(restored.focus).toBe(
        choice === "search"
          ? "search"
          : choice === "rail"
            ? "Settings"
            : savedFocus,
      );
      // Let the existing 40 ms navigation autofocus pass finish as well.
      await page.waitForTimeout(100);
      await expect(expected).toBeFocused();
    }
  });
}

for (const entry of ["native", "pointer", "controller"] as const) {
  test(`${entry} Settings entry focuses preferences and preserves Library return`, async () => {
    const page = await launch();
    await expect(page.locator(".game-grid button")).toHaveCount(3);
    const search = page.getByRole("textbox", { name: "Search cloud games" });
    await search.fill("Sea");
    await expect(page.locator(".game-grid button")).toHaveCount(1);
    await search.focus();
    const settings = page.getByRole("button", {
      name: "Settings",
      exact: true,
    });
    if (entry === "native") await nativeCommand("desktop-settings");
    else if (entry === "pointer") await settings.click();
    else {
      await settings.focus();
      await page.evaluate(() =>
        window.afterglideCloudTest!.injectGamepad("accept"),
      );
    }
    await expect(
      page.getByRole("switch", { name: "Performance overlay" }),
    ).toBeFocused();
    if (entry === "native")
      await page.screenshot({
        path: join(root, "artifacts/e2e/cloud-audit-settings-focus.png"),
      });
    const polling = page
      .getByRole("group", { name: "Input polling", exact: true })
      .getByRole("button")
      .first();
    await polling.focus();
    await page.evaluate(() =>
      window.afterglideCloud.updateSettings({ volume: 0.5 }),
    );
    await expect(polling).toBeFocused();
    if (entry === "controller")
      await page.evaluate(() =>
        window.afterglideCloudTest!.injectGamepad("back"),
      );
    else await page.keyboard.press("Escape");
    await expect(search).toHaveValue("Sea");
    await expect(search).toBeFocused();
    await expect(page.locator(".game-grid button")).toHaveCount(1);
  });
}

test("Settings save failure leaves previous values active and supports retry", async () => {
  const page = await launch();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const blocker = join(directory, "preferences.json.tmp");
  mkdirSync(blocker);
  const reduceMotion = page.getByRole("switch", { name: "Reduce motion" });
  await reduceMotion.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Settings couldn't be saved. Your previous settings are still active.",
  );
  await expect(reduceMotion).toHaveAttribute("aria-checked", "false");
  expect(
    await page.evaluate(
      async () =>
        (await window.afterglideCloud.getSnapshot()).settings.reducedMotion,
    ),
  ).toBe(false);
  rmSync(blocker, { recursive: true, force: true });
  await page.getByRole("button", { name: "Retry saving" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await expect(reduceMotion).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Settings directional input advances exactly one control", async () => {
  const page = await launch();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const polling = page
    .getByRole("group", { name: "Input polling", exact: true })
    .getByRole("button");
  await polling.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(polling.nth(1)).toBeFocused();
  await polling.first().focus();
  await page.evaluate(() => window.afterglideCloudTest?.injectGamepad("right"));
  await expect(polling.nth(1)).toBeFocused();
});

test("fast unchanged Settings saves retain the initiating control", async () => {
  const page = await launch();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const automatic = page
    .getByRole("group", { name: "Active controller", exact: true })
    .getByRole("button")
    .first();
  await automatic.click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await expect(automatic).toBeFocused();
  await automatic.click();
  await expect(page.locator(".settings-list")).toBeEnabled();
  await page.waitForTimeout(100);
  await expect(automatic).toBeFocused();
});

test("Settings save completion restores its control without stealing moved focus", async () => {
  const page = await launch();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  // Isolate focus behavior with a delayed IPC reply; persistence is exercised
  // separately by the real disk-failure/retry test above.
  await app.evaluate(({ ipcMain }, channel) => {
    let attempts = 0;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (attempts++ === 0) throw new Error("Simulated save failure");
    });
  }, IPC.updateSettings);
  const origin = page.getByRole("switch", { name: "Reduce motion" });
  await origin.click();
  await expect(origin).toBeDisabled();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(origin).toBeFocused();
  await page.getByRole("button", { name: "Retry saving" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await expect(origin).toBeFocused();
  await origin.click();
  await expect(origin).toBeDisabled();
  const library = page.getByRole("button", { name: "Library", exact: true });
  await library.focus();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await expect(library).toBeFocused();
});

test("signing out clears account-scoped Library search, filter and paging", async () => {
  const page = await launch("large-cloud-catalog");
  await page.getByRole("button", { name: "Show 32 more games" }).click();
  await page
    .getByRole("button", { name: "Recently played", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search cloud games" })
    .fill("Cloud Game 01");
  await nativeCommand("desktop-settings");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Sign in with Microsoft/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Search cloud games" }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "All games", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".game-grid button")).toHaveCount(48);
  await expect(page.getByRole("button", { name: /Play again/ })).toBeFocused();
});

test("polished Library and Settings remain accessible at desktop sizes and 200 percent zoom", async () => {
  const page = await launch("long-content");
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 960, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await reachable(page, page.getByRole("button", { name: /Play again/ }));
    await accessible(page);
    expect(
      await page
        .locator(
          ".game-grid button > span,.cloud-library-title span,.demo-notice",
        )
        .evaluateAll((elements) =>
          elements.every(
            (element) => parseFloat(getComputedStyle(element).fontSize) >= 14,
          ),
        ),
    ).toBe(true);
    await page.screenshot({
      path: join(
        root,
        `artifacts/e2e/cloud-polish-library-${viewport.width}.png`,
      ),
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await reachable(page, page.getByRole("switch", { name: "Reduce motion" }));
    await accessible(page);
    expect(
      await page
        .locator(".setting-row span,.controller-diagnostics-note")
        .evaluateAll((elements) =>
          elements.every(
            (element) => parseFloat(getComputedStyle(element).fontSize) >= 14,
          ),
        ),
    ).toBe(true);
    await page.locator(".page").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: join(
        root,
        `artifacts/e2e/cloud-polish-settings-${viewport.width}.png`,
      ),
    });
  }
  await zoom(page, 2);
  await reachable(page, page.getByRole("switch", { name: "Reduce motion" }));
  await accessible(page);
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-polish-settings-200.png"),
  });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await reachable(
    page,
    page.getByRole("textbox", { name: "Search cloud games" }),
    true,
  );
  await accessible(page);
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-polish-library-200.png"),
  });
});

test("controller play, directional local controls and return to Library", async () => {
  const page = await launch();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeFocused();
  await page.evaluate(() =>
    window.afterglideCloudTest!.injectGamepad("accept"),
  );
  await expect(page.getByTestId("mock-stream")).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await window.afterglideCloud.getSnapshot()).session.phase,
      ),
    )
    .toBe("streaming");
  await page.evaluate(() =>
    window.afterglideCloudTest!.injectGamepad("controls"),
  );
  await expect(
    page.getByRole("heading", { name: "Quick settings" }),
  ).toBeVisible();
  await expect(page.getByTestId("mock-stream")).toHaveAttribute(
    "data-input-suspended",
    "true",
  );
  await page
    .getByRole("button", { name: "Enter fullscreen", exact: true })
    .click();
  // Background proof windows must never take over the user's display.
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isFullScreen(),
    ),
  ).toBe(false);
  await expect(
    page.getByText("Demo · Simulated stream · Game input paused"),
  ).toBeVisible();
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-controls.png"),
  });
  await page.getByRole("button", { name: /performance stats/ }).click();
  await page.evaluate(() => window.afterglideCloudTest!.injectGamepad("right"));
  await expect(
    page.getByRole("button", { name: "Leave Xbox stream" }),
  ).toBeFocused();
  await page.evaluate(() =>
    window.afterglideCloudTest!.injectGamepad("accept"),
  );
  await expect(
    page.getByRole("heading", { name: "Your cloud library." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeFocused();
});

test("simulated interruption reconnects a cloud session; exit cancels it", async () => {
  const page = await launch();
  await play(page);
  const initial = await page.evaluate(
    async () => (await window.afterglideCloud.getSnapshot()).session.sessionId,
  );
  await page.evaluate(() => window.afterglideCloudTest!.simulateNetworkDrop());
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          (await window.afterglideCloud.getSnapshot()).session.sessionId,
      ),
    )
    .not.toBe(initial);
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await window.afterglideCloud.getSnapshot()).session.phase,
      ),
    )
    .toBe("streaming");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Leave Xbox stream" }).click();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeVisible();
});

test("cloud launch failure retries with a safe error", async () => {
  const page = await launch("cloud-connect-error");
  await page.getByRole("button", { name: /Play again/ }).click();
  await expect(
    page.getByRole("heading", { name: /start cloud play/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Try again/ }).click();
  await expect(page.getByTestId("mock-stream")).toBeVisible();
});

test("controller Back cancels simulated device-code sign-in", async () => {
  const page = await launch("auth-wait", false, true);
  await expect(
    page.getByRole("button", { name: /Sign in with Microsoft/ }),
  ).toBeFocused();
  await page.evaluate(() =>
    window.afterglideCloudTest!.injectGamepad("accept"),
  );
  await expect(
    page.getByRole("heading", { name: "Open the Microsoft link" }),
  ).toBeVisible();
  await expect(page.getByText(/Demo mode.*Simulated sign-in/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy code CLOUD-7G" }),
  ).toBeEnabled();
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-sign-in.png"),
  });
  await page.evaluate(() => window.afterglideCloudTest!.injectGamepad("back"));
  await expect(
    page.getByRole("button", { name: /Sign in with Microsoft/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      async () => (await window.afterglideCloud.getSnapshot()).auth.status,
    ),
  ).toBe("signed-out");
});

test("pending cloud launch supports controller Cancel and Back", async () => {
  const page = await launch("slow-cloud-launch");
  for (const action of ["accept", "back"] as const) {
    await expect(
      page.getByRole("button", { name: /Play again/ }),
    ).toBeFocused();
    await page.evaluate(() =>
      window.afterglideCloudTest!.injectGamepad("accept"),
    );
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: join(root, "artifacts/e2e/cloud-launch.png"),
    });
    await page.evaluate(
      (action) => window.afterglideCloudTest!.injectGamepad(action),
      action,
    );
    await expect(
      page.getByRole("button", { name: /Play again/ }),
    ).toBeVisible();
    // Let the deliberately delayed mock provision reply complete: it must not resurrect the cancelled stream.
    await page.waitForTimeout(1700);
    expect(
      await page.evaluate(
        async () => (await window.afterglideCloud.getSnapshot()).session.phase,
      ),
    ).toBe("idle");
    await expect(page.getByTestId("mock-stream")).toHaveCount(0);
  }
});

test("held controller Accept must be released after a screen change", async () => {
  const page = await launch("slow-cloud-launch");
  const playButton = page.getByRole("button", { name: /Play again/ });
  await playButton.focus();
  await expect(playButton).toBeFocused();
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
    const gamepad = {
      id: "Simulated Xbox",
      index: 0,
      connected: true,
      mapping: "standard",
      axes: [0, 0],
      buttons: Array.from({ length: 16 }, () => ({
        pressed: false,
        touched: false,
        value: 0,
      })),
    };
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [gamepad],
    });
    (window as unknown as { heldPad: typeof gamepad }).heldPad = gamepad;
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("gamepadconnected"));
  });
  const setHeld = async (pressed: boolean) => {
    await page.evaluate(async (value) => {
      const pad = (
        window as unknown as {
          heldPad: { buttons: { pressed: boolean; value: number }[] };
        }
      ).heldPad;
      pad.buttons[0] = { pressed: value, value: value ? 1 : 0 };
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }, pressed);
  };
  await setHeld(false);
  await setHeld(true);
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeFocused();
  await setHeld(true);
  await expect(cancel).toBeVisible();
  await setHeld(false);
  await setHeld(true);
  await expect(playButton).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await window.afterglideCloud.getSnapshot()).session.phase,
      ),
    )
    .toBe("idle");
});

test("controller Back leaves a launch error", async () => {
  const page = await launch("cloud-connect-error");
  await expect(page.getByRole("button", { name: /Play again/ })).toBeFocused();
  await page.evaluate(() =>
    window.afterglideCloudTest!.injectGamepad("accept"),
  );
  await expect(
    page.getByRole("heading", { name: /start cloud play/ }),
  ).toBeVisible();
  await page.evaluate(() => window.afterglideCloudTest!.injectGamepad("back"));
  await expect(page.getByRole("button", { name: /Play again/ })).toBeFocused();
});

test("controller directional library traversal keeps offline launches blocked", async () => {
  const page = await launch();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeFocused();
  await page.evaluate(() => window.afterglideCloudTest!.injectGamepad("down"));
  await expect(page.locator(".game-grid button").last()).toBeFocused();
  await page.evaluate(() =>
    window.afterglideCloudTest!.injectGamepad("accept"),
  );
  await expect(page.locator(".cloud-feature h2")).toHaveText("Sea of Thieves");
  await simulateOffline(page);
  await expect(
    page.getByText(/offline.*browse|offline.*launch/i),
  ).toBeVisible();
  await page.evaluate(() =>
    window.afterglideCloudTest!.injectGamepad("accept"),
  );
  await page.locator(".game-grid button").last().dblclick();
  expect(
    await page.evaluate(
      async () => (await window.afterglideCloud.getSnapshot()).session.phase,
    ),
  ).toBe("idle");
  await expect(page.getByTestId("mock-stream")).toHaveCount(0);
});

test("controller directions choose a preferred simulated device", async () => {
  const page = await launch();
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [
        {
          id: "Xbox Wireless Controller",
          index: 0,
          connected: true,
          mapping: "standard",
          buttons: [],
          axes: [0, 0],
        },
        {
          id: "DualSense Wireless Controller",
          index: 1,
          connected: true,
          mapping: "standard",
          buttons: [],
          axes: [0, 0],
        },
      ],
    });
    window.dispatchEvent(new Event("gamepadconnected"));
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const devices = page
    .getByRole("group", { name: "Active controller", exact: true })
    .getByRole("button");
  await expect(devices).toHaveCount(3);
  await devices.first().click();
  await expect(devices.first()).toBeFocused();
  await page.evaluate(() => window.afterglideCloudTest!.injectGamepad("right"));
  await expect(devices.nth(1)).toBeFocused();
  await page.evaluate(() =>
    window.afterglideCloudTest!.injectGamepad("accept"),
  );
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          (await window.afterglideCloud.getSnapshot()).settings
            .preferredControllerId,
      ),
    )
    .toBe("Xbox Wireless Controller");
  await page.evaluate(() => window.afterglideCloudTest!.injectGamepad("back"));
  await expect(page.getByRole("button", { name: /Play again/ })).toBeFocused();
});

test("offline recovery explains new-session consequences and controller Back exits", async () => {
  const page = await launch();
  await play(page);
  await simulateOffline(page);
  await page.evaluate(() => window.afterglideCloudTest!.simulateNetworkDrop());
  await expect(page.getByRole("heading", { name: /offline/ })).toBeVisible();
  await expect(
    page.getByText(/Game progress may not be preserved/),
  ).toBeVisible();
  await expect(page.getByText(/Demo mode.*Simulated sign-in/)).toBeVisible();
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-reconnect.png"),
  });
  await page.evaluate(() => window.afterglideCloudTest!.injectGamepad("back"));
  await expect(
    page.getByRole("heading", { name: "Your cloud library." }),
  ).toBeVisible();
});

test("catalog failure and unavailable account have clear recovery", async () => {
  const page = await launch("cloud-error-once");
  await expect(
    page.getByRole("heading", { name: /Your cloud library.*load/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeVisible();
});

test("account without cloud eligibility stays in the cloud-only flow", async () => {
  const page = await launch("cloud-unavailable");
  await expect(
    page.getByRole("heading", { name: /Cloud gaming.*active here/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
  await expect(page.getByRole("button", { name: /console/i })).toHaveCount(0);
});

test("preferences persist and quality is explicitly Xbox managed", async () => {
  let page = await launch();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-settings.png"),
  });
  await expect(page.getByText("Automatic · Xbox managed")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "720p", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("switch", { name: "Reduce motion" }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          (await window.afterglideCloud.getSnapshot()).settings.reducedMotion,
      ),
    )
    .toBe(true);
  await expect(page.getByText("Local preview", { exact: true })).toBeVisible();
  const stored = directory;
  await app.close();
  page = await launch("happy", true, false, stored);
  expect(
    await page.evaluate(
      async () =>
        (await window.afterglideCloud.getSnapshot()).settings.reducedMotion,
    ),
  ).toBe(true);
  await play(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Decrease volume" }).click();
  await expect(page.getByTestId("mock-stream")).toHaveAttribute(
    "data-volume",
    "0.9",
  );
});

test("accessible library and settings fit desktop sizes with no overflow", async () => {
  const page = await launch();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeVisible();
  await page.evaluate(axeCore.source);
  const violations = await page.evaluate(
    async () =>
      (
        await (window as unknown as { axe: typeof axeCore }).axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations,
  );
  expect(violations.map((v) => ({ id: v.id, nodes: v.nodes.length }))).toEqual(
    [],
  );
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-library.png"),
  });
  await page.setViewportSize({ width: 960, height: 600 });
  await expect(page.getByRole("button", { name: /Play again/ })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settingsViolations = await page.evaluate(
    async () =>
      (
        await (window as unknown as { axe: typeof axeCore }).axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations,
  );
  expect(
    settingsViolations.map((v) => ({ id: v.id, nodes: v.nodes.length })),
  ).toEqual([]);
});

test("app identity and security stay isolated from Afterglide", async () => {
  await launch();
  const config = await app.evaluate(({ app, BrowserWindow }) => ({
    name: app.getName(),
    userData: app.getPath("userData"),
    preferences: (
      BrowserWindow.getAllWindows()[0].webContents as unknown as {
        getLastWebPreferences(): Record<string, unknown>;
      }
    ).getLastWebPreferences(),
  }));
  expect(config.name).toBe("Afterglide Cloud");
  expect(config.userData).toBe(directory);
  expect(config.preferences).toMatchObject({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  });
});

async function nativeCommand(id: string) {
  await app.evaluate(({ Menu, BrowserWindow }, command) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(command);
    if (!item) throw new Error(`Missing native command: ${command}`);
    item.click(item, BrowserWindow.getAllWindows()[0], {
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      triggeredByAccelerator: false,
    });
  }, id);
}

async function zoom(page: Page, factor: number) {
  const viewport = { width: 960, height: 570 };
  await page.setViewportSize(viewport);
  await app.evaluate(
    ({ BrowserWindow }, value) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value),
    factor,
  );
  // setZoomFactor returns before the renderer necessarily receives its resize.
  // Frame callbacks can still run against the old layout in that interval.
  await expect
    .poll(() =>
      page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    )
    .toEqual({
      width: Math.ceil(viewport.width / factor),
      height: Math.ceil(viewport.height / factor),
    });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function reachable(
  page: Page,
  action: import("@playwright/test").Locator,
  center = false,
) {
  // Choose keyboard focus before scrolling: a pending entry autofocus pass
  // must preserve this newer choice instead of scrolling to its default.
  await action.focus();
  await expect(action).toBeFocused();
  if (center) {
    // The enlarged Library search can land on a fractional CSS-pixel edge.
    // Center this case while retaining the strict visibility checks below.
    await action.evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "center" }),
    );
  } else await action.scrollIntoViewIfNeeded();
  await expect(action).toBeInViewport({ ratio: 1 });
  await expect(action).toBeFocused();
  expect(
    await action.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return element === hit || element.contains(hit);
    }),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          ".desktop-content,.welcome-screen,.auth-screen,.error-screen,.readiness-screen,.page,.quick-settings",
        ),
      )
        .filter((e) => e.scrollWidth > e.clientWidth + 2)
        .map((e) => e.className),
    ),
  ).toEqual([]);
}

async function accessible(page: Page) {
  await page.evaluate(axeCore.source);
  const violations = await page.evaluate(async () =>
    (
      await (window as unknown as { axe: typeof axeCore }).axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((node) => ({
        target: node.target,
        summary: node.failureSummary,
      })),
    })),
  );
  expect(violations).toEqual([]);
}

test("native menu Settings works before login, and Search returns to Library", async () => {
  const page = await launch("happy", false);
  await expect(
    page.getByRole("button", { name: /Sign in with Microsoft/ }),
  ).toBeVisible();
  await nativeCommand("desktop-settings");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Not signed in", { exact: true })).toBeVisible();
  await page.getByRole("switch", { name: "Reduce motion" }).click();
  await page.evaluate(() => window.afterglideCloudTest!.injectGamepad("back"));
  await expect(
    page.getByRole("button", { name: /Sign in with Microsoft/ }),
  ).toBeFocused();
  await expect(page.locator(".desktop-frame")).toHaveClass(/reduced-motion/);
  await page.getByRole("button", { name: /Sign in with Microsoft/ }).click();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeVisible();
  await nativeCommand("desktop-settings");
  await nativeCommand("desktop-search");
  await expect(
    page.getByRole("textbox", { name: "Search cloud games" }),
  ).toBeFocused();
  const roles = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.items.flatMap(
      (item) => item.submenu?.items.map((child) => child.role) ?? [],
    ),
  );
  expect(roles).not.toContain("reload");
  expect(roles).not.toContain("toggledevtools");
});

test("fullscreen state stays synchronized and controller can exit outside a stream", async () => {
  const page = await launch();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeFocused();
  // Native enter/leave events and fullscreen requests are simulated for hidden tests.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].emit("enter-full-screen"),
  );
  const exit = page.getByRole("button", {
    name: "Exit fullscreen",
    exact: true,
  });
  await expect(exit).toBeVisible();
  await reachable(page, exit);
  await page.evaluate(() => window.afterglideCloudTest!.injectGamepad("back"));
  await expect(exit).toHaveCount(0);
  await play(page);
  await nativeCommand("desktop-controls");
  await expect(page.getByText("Quick settings", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Enter fullscreen", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Exit fullscreen", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Leave Xbox stream" }).click();
  await expect(exit).toBeVisible();
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-fullscreen.png"),
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].emit("leave-full-screen"),
  );
  await expect(exit).toHaveCount(0);
});

for (const reducedMotion of [false, true]) {
  test(`fullscreen idle cursor follows overlay and controls (reduced motion ${reducedMotion})`, async () => {
    const page = await launch();
    await expect(
      page.getByRole("button", { name: /Play again/ }),
    ).toBeFocused();
    if (reducedMotion)
      await page.evaluate(() =>
        window.afterglideCloud.updateSettings({ reducedMotion: true }),
      );
    await page.clock.install();
    await play(page);
    const view = page.locator(".stream-view");
    const surface = page.getByTestId("mock-stream");
    const session = await page.evaluate(
      async () =>
        (await window.afterglideCloud.getSnapshot()).session.sessionId,
    );
    expect(session).toBeTruthy();
    // Hidden tests simulate the native event; they never fullscreen the desktop.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].emit("enter-full-screen"),
    );
    await page.mouse.move(500, 350);
    await expect(view).toHaveClass(/overlay-visible/);
    await page.clock.fastForward(4_100);
    await expect(view).not.toHaveClass(/overlay-visible/);
    await expect(view).toHaveCSS("cursor", "none");
    await expect(surface).toHaveCSS("cursor", "none");
    await expect(page.locator(".mock-sky")).toHaveCSS("cursor", "none");
    await expect(surface).toHaveAttribute("data-input-suspended", "false");
    await page.mouse.move(510, 360);
    await expect(view).toHaveClass(/overlay-visible/);
    await expect(surface).not.toHaveCSS("cursor", "none");
    const stats = page.getByRole("button", { name: "Show performance stats" });
    await stats.focus();
    await expect(view).toHaveClass(/controls-captured/);
    await page.clock.fastForward(4_100);
    await expect(stats).toBeFocused();
    await expect(stats).toHaveCSS("cursor", "pointer");
    await expect(view).toHaveClass(/overlay-visible/);
    await expect(surface).not.toHaveCSS("cursor", "none");
    await page.keyboard.press("Escape");
    await expect(view).not.toHaveClass(/controls-captured/);
    await expect(surface).toHaveCSS("cursor", "none");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].emit("leave-full-screen"),
    );
    await expect(surface).not.toHaveCSS("cursor", "none");
    await page.clock.fastForward(4_100);
    await expect(surface).not.toHaveCSS("cursor", "none");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].emit("enter-full-screen"),
    );
    await expect(surface).toHaveCSS("cursor", "none");
    await page.mouse.move(520, 370);
    await expect(surface).not.toHaveCSS("cursor", "none");
    await page.clock.fastForward(4_100);
    await expect(surface).toHaveCSS("cursor", "none");
    await page.evaluate(() =>
      window.afterglideCloudTest!.injectGamepad("controls"),
    );
    await expect(view).toHaveClass(/controls-captured/);
    await page.clock.fastForward(4_100);
    await expect(surface).not.toHaveCSS("cursor", "none");
    await page.keyboard.press("Escape");
    await expect(surface).toHaveCSS("cursor", "none");
    expect(
      await page.evaluate(
        async () =>
          (await window.afterglideCloud.getSnapshot()).session.sessionId,
      ),
    ).toBe(session);
    await nativeCommand("desktop-controls");
    await expect(surface).not.toHaveCSS("cursor", "none");
    await page.getByRole("button", { name: "Leave Xbox stream" }).click();
    await expect(view).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Play again/ })).toHaveCSS(
      "cursor",
      "pointer",
    );
  });
}

test("windowed idle keeps the cursor and fullscreen recovery restores it", async () => {
  const page = await launch();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeFocused();
  await page.clock.install();
  await play(page);
  const view = page.locator(".stream-view");
  const surface = page.getByTestId("mock-stream");
  await page.mouse.move(500, 350);
  await page.clock.fastForward(4_100);
  await expect(view).not.toHaveClass(/overlay-visible/);
  await expect(surface).not.toHaveCSS("cursor", "none");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].emit("enter-full-screen"),
  );
  await expect(surface).toHaveCSS("cursor", "none");
  await simulateOffline(page);
  await expect(surface).not.toHaveCSS("cursor", "none");
  await expect(surface).toHaveAttribute("data-input-suspended", "true");
  await page.evaluate(() => window.afterglideCloudTest!.simulateNetworkDrop());
  await expect(page.getByRole("heading", { name: /offline/ })).toBeVisible();
  await expect(view).toHaveCount(0);
  await expect(page.getByRole("button", { name: "End session" })).toHaveCSS(
    "cursor",
    "pointer",
  );
});

test("native window placement survives restart without changing credentials", async () => {
  const page = await launch();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeVisible();
  const expected = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1100, area.width);
    const height = Math.min(700, area.height);
    window.setBounds({
      x: area.x + Math.floor((area.width - width) / 2),
      y: area.y + Math.floor((area.height - height) / 2),
      width,
      height,
    });
    return { bounds: window.getNormalBounds(), workArea: area };
  });
  const stored = directory;
  await app.close();
  await launch("happy", true, false, stored);
  const restored = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getNormalBounds(),
  );
  // Mac CI reports one pixel less height when the native frame fills the
  // available work area. Keep all other coordinates and non-edge sizes exact.
  const { height, ...positionAndWidth } = restored;
  const { height: expectedHeight, ...expectedPositionAndWidth } =
    expected.bounds;
  expect(positionAndWidth).toEqual(expectedPositionAndWidth);
  if (
    process.platform === "darwin" &&
    expectedHeight === expected.workArea.height
  ) {
    expect(height).toBeGreaterThanOrEqual(expectedHeight - 1);
    expect(height).toBeLessThanOrEqual(expectedHeight);
  } else expect(height).toBe(expectedHeight);
});

test("background physical navigation is inert and held Accept is released on refocus", async () => {
  const page = await launch("slow-cloud-launch");
  const playButton = page.getByRole("button", { name: /Play again/ });
  await expect(playButton).toBeFocused();
  await page.evaluate(async () => {
    const state = {
      focused: false,
      pad: {
        id: "Simulated controller",
        index: 0,
        connected: true,
        mapping: "standard",
        axes: [0, 0],
        buttons: Array.from({ length: 16 }, () => ({
          pressed: false,
          value: 0,
        })),
      },
    };
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => state.focused,
    });
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [state.pad],
    });
    (window as unknown as { focusPad: typeof state }).focusPad = state;
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("gamepadconnected"));
    state.pad.buttons[0] = { pressed: true, value: 1 };
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(playButton).toBeVisible();
  await page.evaluate(async () => {
    (window as unknown as { focusPad: { focused: boolean } }).focusPad.focused =
      true;
    window.dispatchEvent(new Event("focus"));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(playButton).toBeVisible();
  await page.evaluate(async () => {
    const state = (
      window as unknown as {
        focusPad: { pad: { buttons: { pressed: boolean; value: number }[] } };
      }
    ).focusPad;
    state.pad.buttons[0] = { pressed: false, value: 0 };
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    state.pad.buttons[0] = { pressed: true, value: 1 };
  });
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
});

for (const savedShortcut of [undefined, "stick-chord", "steam-input"]) {
  test(`stick clicks pass through with F10 and pointer controls (${savedShortcut ?? "new profile"})`, async () => {
    let profile: string | undefined;
    if (savedShortcut) {
      mkdirSync(join(root, "artifacts/e2e"), { recursive: true });
      profile = mkdtempSync(join(root, "artifacts/e2e/shortcut-"));
      writeFileSync(
        join(profile, "preferences.json"),
        JSON.stringify({
          settings: {
            controllerMenuShortcut: savedShortcut,
            volume: 0.4,
          },
        }),
      );
    }
    const page = await launch("happy", true, false, profile);
    await play(page);
    const stream = page.getByTestId("mock-stream");
    expect(
      (await page.evaluate(() => window.afterglideCloud.getSnapshot()))
        .settings,
    ).not.toHaveProperty("controllerMenuShortcut");
    if (savedShortcut)
      expect(
        (await page.evaluate(() => window.afterglideCloud.getSnapshot()))
          .settings.volume,
      ).toBe(0.4);
    await page.evaluate(() => {
      const pad = {
        id: "Standard pad",
        index: 0,
        connected: true,
        mapping: "standard",
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({
          pressed: false,
          value: 0,
        })),
      };
      Object.defineProperty(document, "hasFocus", {
        configurable: true,
        value: () => true,
      });
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: () => [pad],
      });
    });
    const sticks = async (pressed: boolean) =>
      page.evaluate(async (pressed) => {
        const pad = navigator.getGamepads()[0]!;
        for (const index of [10, 11])
          Object.assign(pad.buttons[index], { pressed, value: +pressed });
        await new Promise<void>((resolve) => {
          let count = 0;
          const tick = () =>
            ++count === 12 ? resolve() : requestAnimationFrame(tick);
          requestAnimationFrame(tick);
        });
      }, pressed);
    await sticks(true);
    await expect(stream).toHaveAttribute("data-input-suspended", "false");
    await page.keyboard.down("F10");
    await expect(stream).toHaveAttribute("data-input-suspended", "true");
    await page.keyboard.down("F10");
    await page.keyboard.up("F10");
    await sticks(false);
    await sticks(true);
    await expect(stream).toHaveAttribute("data-input-suspended", "true");
    await page.keyboard.press("F10");
    await expect(stream).toHaveAttribute("data-input-suspended", "false");
    await page.mouse.move(100, 30);
    await page.getByRole("button", { name: "Open local controls" }).click();
    await expect(stream).toHaveAttribute("data-input-suspended", "true");
    await page.keyboard.press("Escape");
    await expect(stream).toHaveAttribute("data-input-suspended", "false");
    await page.keyboard.press("Tab");
    await expect(stream).toHaveAttribute("data-input-suspended", "true");
    await page.evaluate(() =>
      window.afterglideCloudTest!.injectGamepad("back"),
    );
    await expect(stream).toHaveAttribute("data-input-suspended", "false");
    await sticks(false);
    await sticks(true);
    await expect(stream).toHaveAttribute("data-input-suspended", "false");
  });
}

test("welcome, sign-in and readiness remain reachable at 150 and 200 percent zoom", async () => {
  let page = await launch("auth-wait", false, true);
  for (const factor of [1, 1.5, 2]) {
    await zoom(page, factor);
    await reachable(
      page,
      page.getByRole("button", { name: /Sign in with Microsoft/ }),
    );
  }
  await accessible(page);
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-welcome-zoom200.png"),
  });
  await page.getByRole("button", { name: /Sign in with Microsoft/ }).click();
  await expect(
    page.getByRole("button", { name: "Copy code CLOUD-7G" }),
  ).toBeEnabled();
  await reachable(
    page,
    page.getByRole("button", { name: "Copy code CLOUD-7G" }),
  );
  await reachable(
    page,
    page.getByRole("button", { name: "Cancel", exact: true }),
  );
  await accessible(page);
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-sign-in-zoom200.png"),
  });
  await app.close();
  page = await launch("happy", true, true);
  await expect(
    page.getByRole("button", { name: /Continue to Afterglide Cloud/ }),
  ).toBeVisible();
  for (const factor of [1, 1.5, 2]) {
    await zoom(page, factor);
    await reachable(
      page,
      page.getByRole("button", { name: /Continue to Afterglide Cloud/ }),
    );
  }
  await accessible(page);
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-readiness-zoom200.png"),
  });
});

test("zoom waits for the renderer viewport before checking stream actions", async () => {
  const page = await launch();
  await play(page);
  await page.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const applyZoom = contents.setZoomFactor.bind(contents);
    const state = globalThis as unknown as {
      pendingTestZoom: Promise<unknown>;
      restoreTestZoom: () => void;
    };
    state.restoreTestZoom = () => {
      contents.setZoomFactor = applyZoom;
    };
    contents.setZoomFactor = (factor) => {
      // Native zoom propagation can outlive the helper's two frame waits.
      // Hold its application behind an explicit renderer frame barrier.
      state.pendingTestZoom = contents
        .executeJavaScript(
          `new Promise(resolve => {
          let remaining = 8;
          const frame = () => {
            if (--remaining === 0) resolve();
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        })`,
        )
        .then(() => applyZoom(factor));
    };
  });
  try {
    await zoom(page, 2);
    expect(
      await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    ).toEqual({ width: 480, height: 285 });
    await reachable(
      page,
      page.getByRole("button", { name: "Enter fullscreen", exact: true }),
    );
  } finally {
    await app.evaluate(async () => {
      const state = globalThis as unknown as {
        pendingTestZoom: Promise<unknown>;
        restoreTestZoom: () => void;
      };
      await state.pendingTestZoom;
      state.restoreTestZoom();
      Reflect.deleteProperty(globalThis, "pendingTestZoom");
      Reflect.deleteProperty(globalThis, "restoreTestZoom");
    });
  }
});

test("error recovery and stream settings remain accessible at large zoom", async () => {
  let page = await launch("cloud-connect-error");
  await page.getByRole("button", { name: /Play again/ }).click();
  await expect(page.getByRole("button", { name: /Try again/ })).toBeVisible();
  await zoom(page, 2);
  await reachable(page, page.getByRole("button", { name: /Try again/ }));
  await reachable(
    page,
    page.getByRole("button", { name: "Back to cloud games" }),
  );
  await accessible(page);
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-error-zoom200.png"),
  });
  await app.close();
  page = await launch();
  await play(page);
  await page.keyboard.press("Escape");
  await zoom(page, 2);
  await reachable(
    page,
    page.getByRole("button", { name: "Enter fullscreen", exact: true }),
  );
  await reachable(
    page,
    page.getByRole("button", { name: "Fill", exact: true }),
  );
  await accessible(page);
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-controls-zoom200.png"),
  });
});

test("retina rendering and compact enlarged Settings preserve actions", async () => {
  const page = await launch("happy", true, false, undefined, 2);
  await expect(page.getByRole("button", { name: /Play again/ })).toBeVisible();
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-library-retina2.png"),
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await zoom(page, 1.5);
  await reachable(page, page.getByRole("switch", { name: "Reduce motion" }));
  await reachable(
    page,
    page.getByRole("button", { name: "Review setup", exact: true }),
  );
  await accessible(page);
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-settings-zoom150.png"),
  });
});

test("DualSense physical prompts and capability diagnostics follow the selected standard controller", async () => {
  const page = await launch();
  await page.evaluate(() => {
    const state = {
      pad: {
        id: "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)",
        index: 0,
        connected: true,
        mapping: "standard",
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({
          pressed: false,
          value: 0,
        })),
        vibrationActuator: {
          type: "dual-rumble",
          effects: ["dual-rumble"],
          playEffect: () => Promise.resolve("complete"),
        },
      },
    };
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [state.pad],
    });
    (
      window as unknown as { controllerFixture: typeof state }
    ).controllerFixture = state;
    window.dispatchEvent(new Event("gamepadconnected"));
  });
  await expect(page.locator(".controller-footer")).toContainText("Cross");
  await expect(page.locator(".controller-footer")).toContainText("Circle");
  await expect(page.getByRole("button", { name: /Play again/ })).toBeVisible();
  await page.setViewportSize({ width: 960, height: 600 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-controller-dualsense.png"),
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const diagnostic = page.getByRole("complementary", {
    name: "Connected controller diagnostics",
  });
  await expect(diagnostic).toContainText("Standard mapping");
  await expect(diagnostic).toContainText("Rumble API available");
  await expect(diagnostic).toContainText("unverified");
  await page.evaluate(() => {
    const state = (
      window as unknown as {
        controllerFixture: {
          pad: { id: string; buttons: { pressed: boolean; value: number }[] };
        };
      }
    ).controllerFixture;
    state.pad.buttons[8] = { pressed: true, value: 1 };
    state.pad.buttons[9] = { pressed: true, value: 1 };
  });
  await expect(diagnostic).toContainText("Create + Options");
  await diagnostic.scrollIntoViewIfNeeded();
  const support = diagnostic.locator(".controller-support");
  await expect
    .poll(() =>
      support.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: join(root, "artifacts/e2e/cloud-controller-dualsense-settings.png"),
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2),
  );
  await support.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      support.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: join(
      root,
      "artifacts/e2e/cloud-controller-dualsense-settings-200.png",
    ),
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  await page.evaluate(() => {
    const state = (
      window as unknown as {
        controllerFixture: {
          pad: { id: string; buttons: { pressed: boolean; value: number }[] };
        };
      }
    ).controllerFixture;
    state.pad.id =
      "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)";
    state.pad.buttons = Array.from({ length: 17 }, () => ({
      pressed: false,
      value: 0,
    }));
    window.dispatchEvent(new Event("gamepaddisconnected"));
    window.dispatchEvent(new Event("gamepadconnected"));
  });
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".controller-footer kbd").first()).toHaveText("A");
  await expect(page.locator(".controller-footer")).not.toContainText("Cross");
});

test("unknown controller mapping stays visible but cannot navigate or claim rumble", async () => {
  const page = await launch();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.evaluate(() => {
    const pad = {
      id: "DualSense raw fixture",
      index: 0,
      connected: true,
      mapping: "",
      axes: [1, 1, 1, 1],
      buttons: Array.from({ length: 17 }, () => ({ pressed: true, value: 1 })),
      vibrationActuator: {
        type: "dual-rumble",
        playEffect: () => Promise.resolve("complete"),
      },
    };
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [pad],
    });
    window.dispatchEvent(new Event("gamepadconnected"));
  });
  const diagnostic = page.getByRole("complementary", {
    name: "Connected controller diagnostics",
  });
  await expect(diagnostic).toContainText("Unsupported mapping");
  await expect(diagnostic).toContainText("game input disabled");
  await expect(diagnostic).toContainText("No browser rumble");
  await expect(diagnostic).toContainText("Button 1");
  await expect(diagnostic).not.toContainText("Cross");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /DualSense raw fixture - slot 1/ }),
  ).toBeDisabled();
});

for (const device of [
  {
    id: "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)",
    prompt: "Cross",
  },
  {
    id: "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)",
    prompt: "A",
  },
]) {
  test(`${device.prompt} fixture drives local gamepad polling through launch and overlay handoff`, async () => {
    const page = await launch();
    await page.evaluate((id) => {
      const pad = {
        id,
        index: 0,
        connected: true,
        mapping: "standard",
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({
          pressed: false,
          value: 0,
        })),
      };
      Object.defineProperty(document, "hasFocus", {
        configurable: true,
        value: () => true,
      });
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: () => [pad],
      });
      (window as unknown as { handoffPad: typeof pad }).handoffPad = pad;
      window.dispatchEvent(new Event("gamepadconnected"));
    }, device.id);
    await expect(page.locator(".controller-footer kbd").first()).toHaveText(
      device.prompt,
    );
    const button = async (index: number, pressed: boolean) =>
      page.evaluate(
        async ({ index, pressed }) => {
          const pad = (
            window as unknown as {
              handoffPad: { buttons: { pressed: boolean; value: number }[] };
            }
          ).handoffPad;
          pad.buttons[index] = { pressed, value: pressed ? 1 : 0 };
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        },
        { index, pressed },
      );
    await expect(
      page.getByRole("button", { name: /Play again/ }),
    ).toBeFocused();
    await button(0, false);
    await button(0, true);
    await expect(page.getByTestId("mock-stream")).toBeVisible();
    await button(0, false);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "Quick settings" }),
    ).toBeVisible();
    await expect(page.getByTestId("mock-stream")).toHaveAttribute(
      "data-input-suspended",
      "true",
    );
    await button(1, false);
    await button(1, true);
    await expect(
      page.getByRole("heading", { name: "Quick settings" }),
    ).toHaveCount(0);
    await button(1, false);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "Quick settings" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Leave Xbox stream" }).focus();
    await button(0, false);
    await expect(
      page.getByRole("button", { name: "Leave Xbox stream" }),
    ).toBeFocused();
    await button(0, true);
    await expect(
      page.getByRole("heading", { name: "Your cloud library." }),
    ).toBeVisible();
  });
}

test("native IPC sends no catalog entries for repeated settings updates", async () => {
  const page = await launch("large-cloud-catalog");
  await expect(page.locator(".game-grid button")).toHaveCount(48);
  const evidence = await page.evaluate(async () => {
    const baseline = await window.afterglideCloud.getSnapshot();
    let messages = 0,
      entries = 0,
      jsonBytes = 0;
    let completed!: () => void;
    const delivered = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const unsubscribe = window.afterglideCloud.onSnapshot((event) => {
      messages++;
      entries += event.cloud.titles?.length ?? 0;
      jsonBytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (messages === 20) completed();
    });
    try {
      for (let index = 0; index < 20; index++)
        await window.afterglideCloud.updateSettings({
          volume: index % 2 === 0 ? 0.5 : 1,
        });
      await delivered;
      return {
        messages,
        entries,
        jsonBytes,
        baselineTitles: baseline.cloud.titles.length,
      };
    } finally {
      unsubscribe();
    }
  });
  expect(evidence.baselineTitles).toBe(80);
  expect(evidence.messages).toBe(20);
  expect(evidence.entries).toBe(0);
  await expect(page.locator(".game-grid button")).toHaveCount(48);
  await page.evaluate(() =>
    window.afterglideCloud.updateSettings({ muted: true }),
  );
  const baseline = await page.evaluate(() =>
    window.afterglideCloud.getSnapshot(),
  );
  expect(baseline.cloud.titles).toHaveLength(80);
  await page.reload();
  await expect(page.locator(".game-grid button")).toHaveCount(48);
});

test("late bootstrap reply and obsolete account events cannot replace a newer catalog", async () => {
  const page = await launch();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeVisible();
  const baseline = await page.evaluate(() =>
    window.afterglideCloud.getSnapshot(),
  );
  await app.evaluate(({ ipcMain }, value) => {
    ipcMain.removeHandler("afterglide-cloud:get-snapshot");
    ipcMain.handle(
      "afterglide-cloud:get-snapshot",
      () =>
        new Promise((resolve) => {
          (
            globalThis as unknown as { releaseCloudBaseline: () => void }
          ).releaseCloudBaseline = () => resolve(value);
        }),
    );
  }, baseline);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          typeof (
            globalThis as unknown as { releaseCloudBaseline?: () => void }
          ).releaseCloudBaseline,
      ),
    )
    .toBe("function");
  const fresh = {
    ...baseline,
    revision: baseline.revision + 10,
    cloud: {
      ...baseline.cloud,
      titles: [{ ...baseline.cloud.titles[0], name: "Newer catalog fixture" }],
    },
  };
  await app.evaluate(({ BrowserWindow }, value) => {
    const target = BrowserWindow.getAllWindows()[0].webContents;
    target.send("afterglide-cloud:snapshot", value);
    const { titles: _titles, ...cloud } = value.cloud;
    target.send("afterglide-cloud:snapshot", {
      ...value,
      revision: value.revision + 1,
      cloud,
    });
    (
      globalThis as unknown as { releaseCloudBaseline: () => void }
    ).releaseCloudBaseline();
  }, fresh);
  await expect(
    page.getByRole("heading", { name: "Newer catalog fixture", exact: true }),
  ).toBeVisible();
  await app.evaluate(({ BrowserWindow }, value) => {
    const target = BrowserWindow.getAllWindows()[0].webContents;
    target.send("afterglide-cloud:snapshot", {
      ...value,
      revision: value.revision + 12,
      auth: { status: "signed-out" },
      cloud: { available: false, status: "idle", titles: [] },
    });
    target.send("afterglide-cloud:snapshot", value);
  }, baseline);
  await expect(
    page.getByRole("button", { name: /Sign in with Microsoft/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Newer catalog fixture", exact: true }),
  ).toHaveCount(0);
});

test("Smooth mode persists, switches live, and repair diagnostics stay readable", async () => {
  let page = await launch();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const modes = () =>
    page.getByRole("group", { name: "Stream smoothness", exact: true });
  await expect(
    modes().getByRole("button", { name: "Smooth", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await modes().getByRole("button", { name: "Automatic", exact: true }).click();
  await modes().getByRole("button", { name: "Smooth", exact: true }).click();
  await expect(
    modes().getByRole("button", { name: "Smooth", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await app.close();
  page = await launch("happy", true, false, directory);
  await play(page);
  await expect(page.getByTestId("mock-stream")).toHaveAttribute(
    "data-playback-mode",
    "smooth",
  );
  const sessionId = await page.evaluate(
    async () => (await window.afterglideCloud.getSnapshot()).session.sessionId,
  );
  await page.evaluate(() =>
    window.afterglideCloudTest!.injectGamepad("controls"),
  );
  for (const factor of [1, 2]) {
    await zoom(page, factor);
    await modes()
      .getByRole("button", { name: "Automatic", exact: true })
      .click();
    await expect(page.getByTestId("mock-stream")).toHaveAttribute(
      "data-playback-mode",
      "automatic",
    );
    await modes().getByRole("button", { name: "Smooth", exact: true }).click();
    await expect(page.getByTestId("mock-stream")).toHaveAttribute(
      "data-playback-mode",
      "smooth",
    );
    await accessible(page);
    await page.screenshot({
      path: join(root, `artifacts/e2e/cloud-smooth-controls-${factor}.png`),
    });
  }
  expect(
    await page.evaluate(
      async () =>
        (await window.afterglideCloud.getSnapshot()).session.sessionId,
    ),
  ).toBe(sessionId);
  await zoom(page, 1);
  await page.keyboard.press("F10");
  await page.keyboard.press("F3");
  await expect(
    page
      .getByLabel("Stream performance")
      .locator(".metric")
      .filter({ hasText: "RTX" }),
  ).toContainText("0 PKT/S");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Leave Xbox stream" }).click();
  await page.getByRole("button", { name: "Health", exact: true }).click();
  await expect(
    page.getByText("Video retransmission rate", { exact: true }).locator(".."),
  ).toContainText("0 packets/s");
  await expect(
    page.getByText("Full frame requests (FIR)", { exact: true }).locator(".."),
  ).toContainText("Not reported");
  for (const factor of [1, 2]) {
    await zoom(page, factor);
    await page
      .getByText("Retransmitted video packets", { exact: true })
      .scrollIntoViewIfNeeded();
    await accessible(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: join(root, `artifacts/e2e/cloud-smooth-health-${factor}.png`),
    });
  }
});

test("Health identifies measured region selection and default fallback without calling it gameplay ping", async () => {
  const page = await launch();
  await expect(page.getByRole("button", { name: /Play again/ })).toBeVisible();
  const baseline = await page.evaluate(() =>
    window.afterglideCloud.getSnapshot(),
  );
  await page.getByRole("button", { name: "Health", exact: true }).click();
  const row = (label: string) =>
    page.getByText(label, { exact: true }).locator("..");
  for (const measured of [false, true]) {
    await app.evaluate(
      ({ BrowserWindow }, snapshot) =>
        BrowserWindow.getAllWindows()[0].webContents.send(
          "afterglide-cloud:snapshot",
          snapshot,
        ),
      {
        ...baseline,
        revision: baseline.revision + (measured ? 102 : 101),
        regionSelection: {
          requestedRegion: "Default region",
          xboxDefaultRegion: "Default region",
          method: "xbox-default",
          reason: measured ? "media-route-unverified" : "probes-unavailable",
          measuredAt: 123,
          scanComplete: true,
          medianProbeMs: measured ? 0 : undefined,
          candidates: [],
        },
      },
    );
    await expect(row("Requested cloud region")).toContainText("Default region");
    await expect(row("Region selection")).toContainText(
      measured
        ? "Xbox default · service probes are diagnostic"
        : "Xbox default · probes unavailable",
    );
    await expect(row("Region probe latency (not gameplay ping)")).toContainText(
      measured ? "0.0 ms · median of 3" : "Not measured",
    );
  }
  for (const factor of [1, 2]) {
    await zoom(page, factor);
    await row("Requested cloud region").scrollIntoViewIfNeeded();
    await accessible(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: join(root, `artifacts/e2e/cloud-region-health-${factor}.png`),
    });
  }
});
