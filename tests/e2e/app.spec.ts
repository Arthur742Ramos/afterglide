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

test.afterEach(() => {
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
    await expect(page.getByText("Waiting for Microsoft")).toBeVisible();
    await page.screenshot({ path: join(screenshots, "auth-1280x800.png") });
    await expect(
      page.getByRole("heading", { name: "Pick up where you left off." }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Studio Series S" }),
    ).toBeVisible();
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
    await page.getByRole("button", { name: "Leave remote play" }).click();
    await expect(
      page.getByRole("heading", { name: "Studio Series S" }),
    ).toBeVisible();
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
    await page.evaluate(() => window.afterglideTest!.injectGamepad("accept"));
    await expect(
      page.getByRole("heading", { name: "Ready before you play." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("switch", { name: "Performance overlay" }).click();
    await expect(
      page.getByRole("switch", { name: "Performance overlay" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "720p" }).click();
    await expect(page.getByRole("button", { name: "720p" })).toHaveClass(
      /active/,
    );
    await page.screenshot({ path: join(screenshots, "settings-1280x800.png") });
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
    await page.screenshot({ path: join(screenshots, "error-1280x800.png") });
    await page.getByRole("button", { name: /Try again/ }).click();
    await expect(page.getByTestId("mock-stream")).toBeVisible();
  } finally {
    await app.close();
  }
});
