import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import axeCore from "axe-core";

const axeSource = axeCore.source;

const root = join(import.meta.dirname, "../..");
const screenshots = join(root, "artifacts/e2e");
const temporaryDirectories: string[] = [];
const rendererErrors: string[] = [];

test.afterEach(() => {
  expect(rendererErrors.splice(0), "renderer errors").toEqual([]);
  temporaryDirectories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    );
});

async function launch(
  options: { signedIn?: boolean; scenario?: string; userData?: string } = {},
): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  mkdirSync(screenshots, { recursive: true });
  const userData =
    options.userData ?? mkdtempSync(join(tmpdir(), "afterglide-e2e-"));
  if (!options.userData) temporaryDirectories.push(userData);
  const app = await electron.launch({
    args: ["."],
    cwd: root,
    env: {
      ...process.env,
      AFTERGLIDE_E2E: "1",
      AFTERGLIDE_E2E_SIGNED_IN: options.signedIn ? "1" : "0",
      AFTERGLIDE_E2E_SCENARIO: options.scenario ?? "happy",
      AFTERGLIDE_E2E_USER_DATA: userData,
    },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  return { app, page, userData };
}

async function expectNoAccessibilityViolations(
  page: Page,
  surface: string,
): Promise<void> {
  await page.evaluate(axeSource);
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Document,
            options: { runOnly: { type: string; values: string[] } },
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[] }>;
            }>;
          }>;
        };
      }
    ).axe;
    return (
      await axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
        },
      })
    ).violations;
  });
  expect(
    violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    })),
    `${surface} accessibility violations`,
  ).toEqual([]);
}

test("first run uses device-code auth and lands on the console stage", async () => {
  const { app, page } = await launch();
  try {
    await expect(
      page.getByRole("heading", { name: "Your Xbox. Wherever you land." }),
    ).toBeVisible();
    await page.screenshot({
      path: join(screenshots, "welcome-1280x800.png"),
    });
    await page.getByRole("button", { name: /Sign in with Microsoft/ }).click();
    await expect(
      page.getByRole("button", { name: /Copy code DECK-7G/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Open microsoft.com\/link/ }),
    ).toBeFocused();
    await expect(page.getByText("Waiting for Microsoft")).toBeVisible();
    await page.screenshot({ path: join(screenshots, "auth-1280x800.png") });
    await expect(
      page.getByRole("heading", { name: "Pick up where you left off." }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Studio Series S" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Play now/ })).toBeFocused();
    await page.screenshot({ path: join(screenshots, "home-1280x800.png") });
  } finally {
    await app.close();
  }
});

test("device-code sign-in can be cancelled without a late authentication race", async () => {
  const { app, page } = await launch();
  try {
    await page.getByRole("button", { name: /Sign in with Microsoft/ }).click();
    await expect(
      page.getByRole("button", { name: /Copy code DECK-7G/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "Your Xbox. Wherever you land." }),
    ).toBeVisible();
    await page.waitForTimeout(700);
    await expect(
      page.getByRole("heading", { name: "Your Xbox. Wherever you land." }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a declined Microsoft sign-in returns an actionable first-run error", async () => {
  const { app, page } = await launch({ scenario: "auth-denied" });
  try {
    await page.getByRole("button", { name: /Sign in with Microsoft/ }).click();
    await expect(
      page.getByText(
        "Microsoft sign-in was declined. Start again when you’re ready.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Sign in with Microsoft/ }),
    ).toBeFocused();
    await expectNoAccessibilityViolations(page, "declined sign-in");
    await page.screenshot({
      path: join(screenshots, "auth-denied-1280x800.png"),
    });
  } finally {
    await app.close();
  }
});

test("console selection, connection stages, stream overlay, and clean exit work", async () => {
  const { app, page } = await launch({ signedIn: true });
  try {
    await expect(
      page.getByRole("heading", { name: "Studio Series S" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Den Series X/ }).click();
    await expect(
      page.getByRole("heading", { name: "Den Series X" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Studio Series S/ }).click();
    await expect(
      page.getByRole("heading", { name: "Studio Series S" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Play now/ }).click();
    await expect(
      page.getByText(
        /Preparing remote play|Securing the connection|Starting video/,
      ),
    ).toBeVisible();
    await expect(page.getByTestId("mock-stream")).toBeVisible();
    await expect(page.getByLabel("Stream performance")).toHaveCount(0);
    await page.getByRole("button", { name: "Show performance stats" }).click();
    await expect(page.getByText("60 FPS")).toBeVisible();
    await page.screenshot({ path: join(screenshots, "stream-1280x800.png") });
    await page.keyboard.press("F10");
    await expect(page.locator(".stream-view")).toHaveClass(/controls-captured/);
    await page.keyboard.press("F10");
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(
      page.locator('.stream-header button[aria-label="Leave Xbox stream"]'),
    ).toHaveAttribute("tabindex", "-1");
    await expect(page.getByLabel("Stream performance")).toBeVisible();
    await page.keyboard.press("F3");
    await expect(page.getByLabel("Stream performance")).toHaveCount(0);
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Leave Xbox stream" }).click();
    await expect(
      page.getByRole("heading", { name: "Studio Series S" }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("stream chrome stays out of keyboard play and survives shortcut stress", async () => {
  const { app, page } = await launch({ signedIn: true });
  try {
    await page.evaluate(() =>
      window.afterglide.updateSettings({ keyboardControls: true }),
    );
    await page.getByRole("button", { name: /Play now/ }).click();
    await expect(page.getByTestId("mock-stream")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    for (const key of [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Enter",
      "Backspace",
      "x",
      "y",
      "[",
      "]",
      "m",
      "v",
      "n",
    ])
      await page.keyboard.press(key);
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    await page.keyboard.press("F3");
    await expect(page.getByLabel("Stream performance")).toBeVisible();
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await page.keyboard.press("F3");
    await expect(page.getByLabel("Stream performance")).toHaveCount(0);

    await page.keyboard.press("F9");
    await expect(page.getByLabel("Stream performance")).toBeVisible();
    await page.keyboard.press("F9");
    await expect(page.getByLabel("Stream performance")).toHaveCount(0);
    await page.keyboard.press("F10");
    await expect(page.locator(".stream-view")).toHaveClass(/controls-captured/);
    await page.keyboard.press("F10");
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    await page.evaluate(() => window.afterglideTest!.injectGamepad("controls"));
    await expect(page.locator(".stream-view")).toHaveClass(/controls-captured/);
    await expect(page.getByTestId("mock-stream")).toHaveAttribute(
      "data-input-suspended",
      "true",
    );
    await expect(
      page.getByRole("button", { name: "Show performance stats" }),
    ).toBeFocused();
    await expect(page.getByText("game input paused")).toBeVisible();
    await page.screenshot({
      path: join(screenshots, "stream-controls-1280x800.png"),
    });
    await page.evaluate(() => window.afterglideTest!.injectGamepad("accept"));
    await expect(page.getByLabel("Stream performance")).toBeVisible();
    await page.evaluate(() => window.afterglideTest!.injectGamepad("right"));
    await expect(
      page.getByRole("button", { name: "Leave Xbox stream" }),
    ).toBeFocused();
    await page.evaluate(() => window.afterglideTest!.injectGamepad("back"));
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(page.locator(".stream-view")).not.toHaveClass(
      /controls-captured/,
    );
    await expect(page.getByTestId("mock-stream")).toHaveAttribute(
      "data-input-suspended",
      "false",
    );

    await page.keyboard.down("F10");
    await page.keyboard.down("F10");
    await page.keyboard.up("F10");
    await expect(page.locator(".stream-view")).toHaveClass(/controls-captured/);
    await page.keyboard.press("F10");
    for (let index = 0; index < 20; index += 1)
      await page.keyboard.press("Escape");
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: /performance stats/ }),
    ).toBeFocused();
    await page.waitForTimeout(4_200);
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "false",
    );

    await page.keyboard.press("Escape");
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(
      page.locator('.stream-header button[aria-label*="performance stats"]'),
    ).not.toBeFocused();
    await expectNoAccessibilityViolations(page, "hidden stream chrome");

    await page.mouse.move(101, 101);
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "false",
    );
    await page.locator(".stream-view").focus();
    await page.waitForTimeout(4_200);
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Leave Xbox stream" }).click();
  } finally {
    await app.close();
  }
});

test("cloud library selection launches an xCloud stream", async () => {
  const { app, page } = await launch({ signedIn: true });
  try {
    await page.getByRole("button", { name: "Cloud" }).click();
    await expect(
      page.getByRole("heading", { name: "Your library. Ready anywhere." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Play from cloud/ }),
    ).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "Starfield" }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Forza Horizon 5, Xbox Game Studios",
      })
      .click();
    await expect(
      page.getByRole("heading", { name: "Forza Horizon 5" }),
    ).toBeVisible();
    await page.screenshot({
      path: join(screenshots, "cloud-library-1280x800.png"),
    });
    await page.getByRole("button", { name: /Play from cloud/ }).click();
    await expect(page.getByTestId("mock-stream")).toBeVisible();
    await expect(page.getByText("Forza Horizon 5")).toBeVisible();
    await page.screenshot({
      path: join(screenshots, "cloud-stream-1280x800.png"),
    });
    await page.getByRole("button", { name: "Leave Xbox stream" }).click();
  } finally {
    await app.close();
  }
});

test("cloud eligibility has a clear unavailable state", async () => {
  const { app, page } = await launch({
    signedIn: true,
    scenario: "cloud-unavailable",
  });
  try {
    await page.getByRole("button", { name: "Cloud" }).click();
    await expect(
      page.getByRole("heading", { name: "Cloud gaming isn’t active here." }),
    ).toBeVisible();
    await expect(
      page.getByText("Cloud gaming requires a supported account and region."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Check again/ }),
    ).toBeFocused();
    await expectNoAccessibilityViolations(page, "cloud unavailable");
  } finally {
    await app.close();
  }
});

test("console discovery failure recovers in place", async () => {
  const { app, page } = await launch({
    signedIn: true,
    scenario: "console-error-once",
  });
  try {
    await expect(
      page.getByRole("heading", { name: "We couldn’t refresh your consoles" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Try again/ })).toBeFocused();
    await expectNoAccessibilityViolations(page, "console discovery error");
    await page.screenshot({
      path: join(screenshots, "console-discovery-error-1280x800.png"),
    });
    await page.getByRole("button", { name: /Try again/ }).click();
    await expect(
      page.getByRole("heading", { name: "Studio Series S" }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("empty and disabled console states explain the next action", async () => {
  const empty = await launch({ signedIn: true, scenario: "empty" });
  try {
    await expect(
      empty.page.getByRole("heading", {
        name: "No remote-play consoles found",
      }),
    ).toBeVisible();
    await expect(
      empty.page.getByRole("button", { name: /Check again/ }),
    ).toBeFocused();
    await expectNoAccessibilityViolations(empty.page, "empty consoles");
    await empty.page.screenshot({
      path: join(screenshots, "empty-consoles-1280x800.png"),
    });
  } finally {
    await empty.app.close();
  }

  const disabled = await launch({
    signedIn: true,
    scenario: "remote-play-disabled",
  });
  try {
    await expect(
      disabled.page.getByRole("button", { name: /Play now/ }),
    ).toBeDisabled();
    await expect(disabled.page.getByText("Remote play is off")).toBeVisible();
    await expect(
      disabled.page.getByText(/Enable remote features on your Xbox/),
    ).toBeVisible();
    await expectNoAccessibilityViolations(
      disabled.page,
      "remote play disabled",
    );
    await disabled.page.screenshot({
      path: join(screenshots, "remote-play-disabled-1280x800.png"),
    });
  } finally {
    await disabled.app.close();
  }
});

test("cloud catalog failure retries and empty search states stay usable", async () => {
  const failed = await launch({
    signedIn: true,
    scenario: "cloud-error-once",
  });
  try {
    await failed.page.getByRole("button", { name: "Cloud" }).click();
    await expect(
      failed.page.getByRole("heading", {
        name: "Your cloud library didn’t load.",
      }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(failed.page, "cloud catalog error");
    await failed.page.screenshot({
      path: join(screenshots, "cloud-catalog-error-1280x800.png"),
    });
    await failed.page.getByRole("button", { name: /Check again/ }).click();
    await expect(
      failed.page.getByRole("button", { name: /Play from cloud/ }),
    ).toBeVisible();
  } finally {
    await failed.app.close();
  }

  const empty = await launch({ signedIn: true, scenario: "cloud-empty" });
  try {
    await empty.page.getByRole("button", { name: "Cloud" }).click();
    await expect(
      empty.page.getByText(
        "No cloud games are currently available for this account.",
      ),
    ).toBeVisible();
    await expect(
      empty.page.getByRole("textbox", { name: "Search cloud games" }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(empty.page, "empty cloud catalog");
    await empty.page.screenshot({
      path: join(screenshots, "cloud-empty-1280x800.png"),
    });
  } finally {
    await empty.app.close();
  }
});

test("cloud search filters case-insensitively and reports no matches", async () => {
  const { app, page } = await launch({ signedIn: true });
  try {
    await page.getByRole("button", { name: "Cloud" }).click();
    const search = page.getByRole("textbox", { name: "Search cloud games" });
    await search.fill("FORZA");
    await expect(page.getByText("1 title")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Forza Horizon 5, Xbox Game Studios",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Starfield, Bethesda Softworks" }),
    ).toHaveCount(0);

    await search.fill("definitely not a game");
    await expect(page.getByText("0 titles")).toBeVisible();
    await expect(
      page.getByText("No games match “definitely not a game”."),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("large cloud libraries stay light and controller movement follows the grid", async () => {
  const { app, page } = await launch({
    signedIn: true,
    scenario: "large-cloud-catalog",
  });
  try {
    await page.setViewportSize({ width: 960, height: 600 });
    await page.getByRole("button", { name: "Cloud" }).click();
    const search = page.getByRole("textbox", { name: "Search cloud games" });
    const cards = page.locator(".game-grid > button");

    await expect(cards).toHaveCount(48);
    await expect(page.getByText("Showing 48 of 80")).toBeVisible();
    await page.screenshot({
      path: join(screenshots, "large-cloud-960x600.png"),
    });

    await search.fill("Cloud Game 80");
    await search.press("ArrowRight");
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("Cloud Game 80");
    await page.getByRole("button", { name: "Clear game search" }).click();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");

    await page.getByRole("button", { name: "Show 32 more games" }).click();
    await expect(cards).toHaveCount(80);
    await expect(page.getByText("80 titles")).toBeVisible();

    const rowTops = await cards.evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().top),
    );
    const secondRowIndex = rowTops.findIndex((top) => top > rowTops[0]! + 2);
    expect(secondRowIndex).toBeGreaterThan(1);

    await cards.first().focus();
    await page.evaluate(() => window.afterglideTest!.injectGamepad("down"));
    const activeIndex = await cards.evaluateAll((buttons) =>
      buttons.indexOf(document.activeElement as HTMLButtonElement),
    );
    expect(activeIndex).toBe(secondRowIndex);

    const activeCard = cards.nth(activeIndex);
    await page.evaluate(() => window.afterglideTest!.injectGamepad("accept"));
    await expect(activeCard).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => window.afterglideTest!.injectGamepad("accept"));
    await expect(page.getByTestId("mock-stream")).toBeVisible();
    await page.getByRole("button", { name: "Leave Xbox stream" }).click();
  } finally {
    await app.close();
  }
});

test("vetted Xbox catalog artwork loads under the renderer security policy", async () => {
  const { app, page } = await launch({
    signedIn: true,
    scenario: "cloud-artwork",
  });
  try {
    await page.route("https://images.xboxlive.com/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#2463a8"/></svg>',
      }),
    );
    await page.getByRole("button", { name: "Cloud" }).click();
    await expect(page.locator(".featured-art")).toHaveJSProperty(
      "naturalWidth",
      320,
    );
  } finally {
    await app.close();
  }
});

test("controller semantics navigate to health and settings persist in the shell", async () => {
  const { app, page } = await launch({ signedIn: true });
  try {
    await expect(
      page.getByRole("heading", { name: "Pick up where you left off." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Home" }).focus();
    await page.evaluate(() => window.afterglideTest!.injectGamepad("down"));
    await expect(page.getByRole("button", { name: "Cloud" })).toBeFocused();
    await page.evaluate(() => window.afterglideTest!.injectGamepad("down"));
    await expect(page.getByRole("button", { name: "Health" })).toBeFocused();
    await page.evaluate(() => window.afterglideTest!.injectGamepad("accept"));
    await expect(
      page.getByRole("heading", { name: "Ready before you play." }),
    ).toBeVisible();
    await page.evaluate(() => window.afterglideTest!.injectGamepad("back"));
    await expect(
      page.getByRole("heading", { name: "Pick up where you left off." }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Play now/ })).toBeFocused();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("button", { name: "1080p" })).toBeFocused();
    await page.getByRole("switch", { name: "Performance overlay" }).focus();
    await page.evaluate(() => window.afterglideTest!.injectGamepad("accept"));
    await expect(
      page.getByRole("switch", { name: "Performance overlay" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.getByRole("switch", { name: "Keyboard controls" }).click();
    await expect(page.getByRole("button", { name: "L3 + R3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Steam Input" }).click();
    await expect(
      page.getByRole("button", { name: "Steam Input" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Keyboard game controls")).toContainText(
      "Arrows D-pad",
    );
    await expect(page.getByLabel("Keyboard game controls")).toContainText(
      "WASD Left stick",
    );
    await expect(page.getByLabel("Keyboard game controls")).toContainText(
      "Z / C LT / RT",
    );
    await expect(page.getByLabel("Keyboard game controls")).toContainText(
      "Esc / F10 controls",
    );
    await expect(page.getByLabel("Controller controls")).toContainText(
      "F10 Afterglide controls",
    );
    await expect(page.getByLabel("Controller controls")).toContainText(
      "L4 → F10 Afterglide controls",
    );
    await expect(page.getByLabel("Controller controls")).toContainText(
      "L3 + R3 passes through to the Xbox",
    );
    await page.getByRole("button", { name: "720p" }).click();
    await expect(page.getByRole("button", { name: "720p" })).toHaveClass(
      /active/,
    );
    await page.screenshot({ path: join(screenshots, "settings-1280x800.png") });
    await page.getByRole("button", { name: "Home" }).click();
    await page.getByRole("button", { name: /Play now/ }).click();
    await expect(page.getByTestId("mock-stream")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(page.locator(".performance-strip")).toBeVisible();
    await page.keyboard.press("F3");
    await expect(page.getByLabel("Stream performance")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Leave Xbox stream" }).click();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(
      page.getByRole("switch", { name: "Performance overlay" }),
    ).toHaveAttribute("aria-checked", "false");
  } finally {
    await app.close();
  }
});

test("an interrupted stream recovers autonomously", async () => {
  const { app, page } = await launch({ signedIn: true });
  try {
    await page.getByRole("button", { name: /Den Series X/ }).click();
    await page.getByRole("button", { name: /Wake & play/ }).click();
    await expect(page.getByTestId("mock-stream")).toBeVisible();
    await page.evaluate(() => window.afterglideTest!.simulateNetworkDrop());
    await expect(page.getByText("Restoring the stream")).toBeVisible();
    await expect(page.getByTestId("mock-stream")).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});

test("connecting can be cancelled without a delayed stream appearing", async () => {
  const { app, page } = await launch({ signedIn: true });
  try {
    await page.getByRole("button", { name: /Den Series X/ }).click();
    await page.getByRole("button", { name: /Wake & play/ }).click();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expectNoAccessibilityViolations(page, "connecting");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "Den Series X" }),
    ).toBeVisible();
    await page.waitForTimeout(900);
    await expect(page.getByTestId("mock-stream")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("an in-session media failure is explained and can reconnect", async () => {
  const { app, page } = await launch({ signedIn: true });
  try {
    await page.getByRole("button", { name: /Play now/ }).click();
    await expect(page.getByTestId("mock-stream")).toBeVisible();
    await expectNoAccessibilityViolations(page, "stream");
    await page.evaluate(async () => {
      const snapshot = await window.afterglide.getSnapshot();
      await window.afterglide.reportStreamEvent(
        snapshot.session.sessionId!,
        "failed",
        "The video channel stopped unexpectedly.",
      );
    });
    await expect(
      page.getByRole("heading", { name: "The stream stopped" }),
    ).toBeVisible();
    await expect(
      page.getByText("The video channel stopped unexpectedly."),
    ).toBeVisible();
    await expect(page.getByText("Reference: MEDIA_FAILED")).toBeVisible();
    await expectNoAccessibilityViolations(page, "session error");
    await page.getByRole("button", { name: /Try again/ }).click();
    await expect(page.getByTestId("mock-stream")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a failed connection explains the problem and retries successfully", async () => {
  const { app, page } = await launch({
    signedIn: true,
    scenario: "connect-error",
  });
  try {
    await page.getByRole("button", { name: /Den Series X/ }).click();
    await page.getByRole("button", { name: /Wake & play/ }).click();
    await expect(
      page.getByRole("heading", { name: "Couldn’t start remote play" }),
    ).toBeVisible();
    await expect(page.getByText("Your Xbox did not answer.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Back to consoles/ }),
    ).toBeVisible();
    await page.screenshot({ path: join(screenshots, "error-1280x800.png") });
    await page.getByRole("button", { name: /Try again/ }).click();
    await expect(page.getByTestId("mock-stream")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a cloud launch failure returns to the cloud library", async () => {
  const { app, page } = await launch({
    signedIn: true,
    scenario: "cloud-connect-error",
  });
  try {
    await page.getByRole("button", { name: "Cloud" }).click();
    await page.getByRole("button", { name: /Play from cloud/ }).click();
    await expect(
      page.getByRole("heading", { name: "Couldn’t start cloud play" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Back to cloud games/ }).click();
    await expect(
      page.getByRole("heading", { name: "Your library. Ready anywhere." }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("primary surfaces remain usable at the minimum window size", async () => {
  const { app, page } = await launch({ signedIn: true });
  try {
    await page.setViewportSize({ width: 960, height: 600 });
    await expect(
      page.getByRole("heading", { name: "Pick up where you left off." }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Play now/ })).toBeVisible();
    await page.screenshot({ path: join(screenshots, "home-960x600.png") });

    await page.getByRole("button", { name: "Cloud" }).click();
    await expect(
      page.getByRole("button", { name: /Play from cloud/ }),
    ).toBeVisible();
    await page.screenshot({ path: join(screenshots, "cloud-960x600.png") });

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(
      page.getByRole("switch", { name: "Performance overlay" }),
    ).toBeVisible();
    await page.screenshot({ path: join(screenshots, "settings-960x600.png") });

    await page.getByRole("button", { name: "Home" }).click();
    await page.getByRole("button", { name: /Play now/ }).click();
    await expect(page.getByTestId("mock-stream")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.afterglideTest!.injectGamepad("controls"));
    await expect(page.getByText("game input paused")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Leave Xbox stream" }),
    ).toBeVisible();
    await page.screenshot({
      path: join(screenshots, "stream-controls-960x600.png"),
    });

    const dimensions = await page.evaluate(() => ({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
    }));
    expect(dimensions.document.width).toBeLessThanOrEqual(
      dimensions.viewport.width,
    );
    expect(dimensions.document.height).toBeLessThanOrEqual(
      dimensions.viewport.height,
    );
    await page.getByRole("button", { name: "Leave Xbox stream" }).click();
  } finally {
    await app.close();
  }
});

test("desktop widescreen keeps actions comfortably grouped", async () => {
  const { app, page } = await launch({ signedIn: true });
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await expect(
      page.getByRole("heading", { name: "Pick up where you left off." }),
    ).toBeVisible();
    await expect(page.locator(".page")).toHaveCSS("max-width", "1400px");
    await page.screenshot({ path: join(screenshots, "home-1600x1000.png") });

    await page.getByRole("button", { name: "Cloud" }).click();
    await expect(
      page.getByRole("heading", { name: "Your library. Ready anywhere." }),
    ).toBeVisible();
    await page.screenshot({ path: join(screenshots, "cloud-1600x1000.png") });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await app.close();
  }
});

test("preferences and the selected console survive a complete restart", async () => {
  const first = await launch({ signedIn: true });
  let running: ElectronApplication | undefined = first.app;
  try {
    await first.page.getByRole("button", { name: /Den Series X/ }).click();
    await first.page.getByRole("button", { name: "Settings" }).click();
    await first.page.getByRole("button", { name: "720p" }).click();
    await first.page.getByRole("button", { name: "Steam Input" }).click();
    for (const name of [
      "Performance overlay",
      "Keyboard controls",
      "Reduce motion",
      "Launch fullscreen",
    ]) {
      await first.page.getByRole("switch", { name }).click();
      await expect(first.page.getByRole("switch", { name })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    }

    await running.close();
    running = undefined;
    const restarted = await launch({
      signedIn: true,
      userData: first.userData,
    });
    running = restarted.app;

    await expect(
      restarted.page.getByRole("heading", { name: "Den Series X" }),
    ).toBeVisible();
    await restarted.page.getByRole("button", { name: "Settings" }).click();
    await expect(
      restarted.page.getByRole("button", { name: "720p" }),
    ).toHaveClass(/active/);
    await expect(
      restarted.page.getByRole("button", { name: "Steam Input" }),
    ).toHaveAttribute("aria-pressed", "true");
    for (const name of [
      "Performance overlay",
      "Keyboard controls",
      "Reduce motion",
      "Launch fullscreen",
    ])
      await expect(
        restarted.page.getByRole("switch", { name }),
      ).toHaveAttribute("aria-checked", "true");

    await restarted.page.getByRole("button", { name: "Sign out" }).click();
    await expect(
      restarted.page.getByRole("heading", {
        name: "Your Xbox. Wherever you land.",
      }),
    ).toBeVisible();
  } finally {
    await running?.close();
  }
});

test("renderer boundaries reject invalid settings and external navigation", async () => {
  const { app, page } = await launch({ signedIn: true });
  try {
    const settings = await page.evaluate(async () => {
      await window.afterglide.updateSettings({
        resolution: 1440,
        reducedMotion: "yes",
        showPerformance: 1,
        controllerMenuShortcut: "unbound",
        unknownSetting: true,
      } as never);
      return (await window.afterglide.getSnapshot()).settings;
    });
    expect(settings).toEqual({
      resolution: 1080,
      reducedMotion: false,
      showPerformance: false,
      keyboardControls: false,
      controllerMenuShortcut: "stick-chord",
      launchFullscreen: false,
    });

    const externalError = await page.evaluate(async () => {
      try {
        await window.afterglide.openExternal("https://example.com/phishing");
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(externalError).toContain(
      "Only Microsoft sign-in links can be opened.",
    );

    const originalUrl = page.url();
    await page.evaluate(() => window.location.assign("https://example.com"));
    await page.waitForTimeout(100);
    expect(page.url()).toBe(originalUrl);

    const unnamedButtons = await page
      .locator("button:visible")
      .evaluateAll((buttons) =>
        buttons
          .filter(
            (button) =>
              !(button.getAttribute("aria-label") ?? "").trim() &&
              !(button.textContent ?? "").trim(),
          )
          .map((button) => button.outerHTML),
      );
    expect(unnamedButtons).toEqual([]);
  } finally {
    await app.close();
  }
});

test("core signed-out and signed-in surfaces meet automated WCAG checks", async () => {
  const signedOut = await launch();
  try {
    await expect(
      signedOut.page.getByRole("heading", {
        name: "Your Xbox. Wherever you land.",
      }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(signedOut.page, "welcome");
  } finally {
    await signedOut.app.close();
  }

  const signedIn = await launch({ signedIn: true });
  try {
    await expect(
      signedIn.page.getByRole("heading", {
        name: "Pick up where you left off.",
      }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(signedIn.page, "home");

    for (const navigation of [
      { button: "Cloud", heading: "Your library. Ready anywhere." },
      { button: "Health", heading: "Ready before you play." },
      { button: "Settings", heading: "Tuned to how you play." },
    ]) {
      await signedIn.page
        .getByRole("button", { name: navigation.button })
        .click();
      await expect(
        signedIn.page.getByRole("heading", { name: navigation.heading }),
      ).toBeVisible();
      await expectNoAccessibilityViolations(
        signedIn.page,
        navigation.button.toLowerCase(),
      );
    }
  } finally {
    await signedIn.app.close();
  }
});

test("long account content stays contained at the minimum viewport", async () => {
  const { app, page } = await launch({
    signedIn: true,
    scenario: "long-content",
  });
  try {
    await page.setViewportSize({ width: 960, height: 600 });
    await expect(
      page.getByRole("heading", {
        name: "Upstairs Family Room Xbox Series S With A Very Long Console Name",
      }),
    ).toBeVisible();
    await expect(page.locator(".console-stage")).toHaveCSS(
      "overflow",
      "hidden",
    );
    await page.screenshot({ path: join(screenshots, "long-home-960x600.png") });

    await page.getByRole("button", { name: "Cloud" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Microsoft Flight Simulator 2024 Premium Deluxe World Edition",
      }),
    ).toBeVisible();
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - window.innerWidth,
      feature:
        document.querySelector<HTMLElement>(".cloud-feature")!.scrollWidth -
        document.querySelector<HTMLElement>(".cloud-feature")!.clientWidth,
    }));
    expect(overflow.document).toBeLessThanOrEqual(0);
    expect(overflow.feature).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: join(screenshots, "long-cloud-960x600.png"),
    });
  } finally {
    await app.close();
  }
});

test("repeated stream start and clean exit does not leak UI state", async () => {
  const { app, page } = await launch({ signedIn: true });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.getByRole("button", { name: /Play now/ }).click();
      await expect(page.getByTestId("mock-stream")).toBeVisible();
      await expect(page.getByLabel("Stream performance")).toHaveCount(0);
      await page.getByRole("button", { name: "Leave Xbox stream" }).click();
      await expect(
        page.getByRole("heading", { name: "Studio Series S" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Play now/ }),
      ).toBeFocused();
    }
  } finally {
    await app.close();
  }
});
