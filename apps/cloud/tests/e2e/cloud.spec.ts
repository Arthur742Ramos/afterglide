import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  await page.setViewportSize({ width: 960, height: 570 });
  await app.evaluate(
    ({ BrowserWindow }, value) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value),
    factor,
  );
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
) {
  // Choose keyboard focus before scrolling: a pending entry autofocus pass
  // must preserve this newer choice instead of scrolling to its default.
  await action.focus();
  await expect(action).toBeFocused();
  await action.scrollIntoViewIfNeeded();
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
    ).violations.map((v) => ({ id: v.id, nodes: v.nodes.length })),
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

test("captured controller chord stops on blur and requires release after refocus and hotplug", async () => {
  const page = await launch();
  await play(page);
  await page.evaluate(() =>
    window.afterglideCloudTest!.injectGamepad("controls"),
  );
  const settings = page.getByText("Quick settings", { exact: true });
  await expect(settings).toBeVisible();
  await page.evaluate(async () => {
    const state = {
      focused: false,
      reads: 0,
      pad: {
        id: "Simulated chord controller",
        index: 0,
        connected: true,
        mapping: "standard",
        axes: [0, 0],
        buttons: Array.from({ length: 17 }, () => ({
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
      value: () => {
        state.reads += 1;
        return [state.pad];
      },
    });
    (window as unknown as { chordPad: typeof state }).chordPad = state;
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("gamepadconnected"));
    state.pad.buttons[10] = state.pad.buttons[11] = { pressed: true, value: 1 };
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (state.reads !== 0)
      throw new Error("Controller was sampled in background");
  });
  await expect(settings).toBeVisible();
  await page.evaluate(async () => {
    const state = (window as unknown as { chordPad: { focused: boolean } })
      .chordPad;
    state.focused = true;
    window.dispatchEvent(new Event("focus"));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(settings).toBeVisible();
  const setChord = async (pressed: boolean) => {
    await page.evaluate(async (pressed) => {
      const state = (
        window as unknown as {
          chordPad: { pad: { buttons: { pressed: boolean; value: number }[] } };
        }
      ).chordPad;
      state.pad.buttons[10] = state.pad.buttons[11] = {
        pressed,
        value: pressed ? 1 : 0,
      };
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }, pressed);
  };
  await setChord(false);
  await setChord(true);
  await expect(settings).toHaveCount(0);
  await page.evaluate(() =>
    window.afterglideCloudTest!.injectGamepad("controls"),
  );
  await expect(settings).toBeVisible();
  await page.evaluate(async () => {
    const state = (window as unknown as { chordPad: { pad: { id: string } } })
      .chordPad;
    state.pad.id = "Replacement at the same index";
    window.dispatchEvent(new Event("gamepadconnected"));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(settings).toBeVisible();
  await setChord(false);
  await setChord(true);
  await expect(settings).toHaveCount(0);
});

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
