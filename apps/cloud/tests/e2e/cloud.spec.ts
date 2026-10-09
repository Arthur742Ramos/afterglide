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
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeInViewport({ ratio: 1 });
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
  const expected = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({ x: 80, y: 70, width: 1100, height: 700 });
    return window.getNormalBounds();
  });
  const stored = directory;
  await app.close();
  await launch("happy", true, false, stored);
  const restored = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getNormalBounds(),
  );
  expect(restored).toEqual(expected);
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
    state.pad.buttons[0] = { pressed: true, value: 1 };
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(playButton).toBeVisible();
  await page.evaluate(async () => {
    (window as unknown as { focusPad: { focused: boolean } }).focusPad.focused =
      true;
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
