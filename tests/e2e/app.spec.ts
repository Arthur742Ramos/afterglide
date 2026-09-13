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
  options: { signedIn?: boolean; scenario?: string } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  mkdirSync(screenshots, { recursive: true });
  const userData = mkdtempSync(join(tmpdir(), "afterglide-e2e-"));
  temporaryDirectories.push(userData);
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
  return { app, page };
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
    await expect(page.getByText("60 FPS")).toBeVisible();
    await page.screenshot({ path: join(screenshots, "stream-1280x800.png") });
    await page.keyboard.press("Escape");
    await expect(page.locator(".stream-header")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(
      page.locator('.stream-header button[aria-label="Leave Xbox stream"]'),
    ).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Leave Xbox stream" }).click();
    await expect(
      page.getByRole("heading", { name: "Studio Series S" }),
    ).toBeVisible();
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
    await page.evaluate(() => window.afterglideTest!.injectGamepad("down"));
    await page.evaluate(() => window.afterglideTest!.injectGamepad("accept"));
    await expect(
      page.getByRole("heading", { name: "Ready before you play." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("button", { name: "1080p" })).toBeFocused();
    await page.getByRole("switch", { name: "Performance overlay" }).click();
    await expect(
      page.getByRole("switch", { name: "Performance overlay" }),
    ).toHaveAttribute("aria-checked", "true");
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
    await expect(page.getByText("60 FPS")).toBeVisible();
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
  } finally {
    await app.close();
  }
});
