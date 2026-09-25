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
import { waitForFiniteAnimationsToSettle } from "./animation-settling";

const root = join(import.meta.dirname, "../..");
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

async function launch(options: { userData?: string } = {}): Promise<{
  app: ElectronApplication;
  page: Page;
  userData: string;
}> {
  const artifacts = join(root, "artifacts/e2e");
  mkdirSync(artifacts, { recursive: true });
  const userData =
    options.userData ?? mkdtempSync(join(artifacts, "input-e2e-"));
  if (!options.userData) temporaryDirectories.push(userData);
  const app = await electron.launch({
    args: ["."],
    cwd: root,
    env: {
      ...process.env,
      AFTERGLIDE_E2E: "1",
      AFTERGLIDE_E2E_SIGNED_IN: "1",
      AFTERGLIDE_E2E_SCENARIO: "happy",
      AFTERGLIDE_E2E_USER_DATA: userData,
      AFTERGLIDE_E2E_ONBOARDING: "skip",
    },
  });
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") rendererErrors.push(message.text());
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    return { app, page, userData };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function expectNoAccessibilityViolations(
  page: Page,
  surface: string,
): Promise<void> {
  await page.evaluate(axeCore.source);
  await page.evaluate(waitForFiniteAnimationsToSettle);
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

test("keyboard navigation reaches every signed-in shell screen", async () => {
  const { app, page } = await launch();
  try {
    await expect(
      page.getByRole("heading", { name: "Pick up where you left off." }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page, "home");

    await page.getByRole("button", { name: "Home" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("button", { name: "Cloud", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Your library. Ready anywhere." }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page, "cloud library");

    await page.getByRole("button", { name: "Cloud", exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("button", { name: "Health" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Ready before you play." }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page, "health");

    await page.getByRole("button", { name: "Health" }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Settings" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Tuned to how you play." }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page, "settings");

    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "Pick up where you left off." }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("controller profiles remain available after an application restart", async () => {
  const first = await launch();
  let running: ElectronApplication | undefined = first.app;
  try {
    await first.page.evaluate(() => {
      const buttons = Array.from({ length: 17 }, () => ({
        pressed: false,
        touched: false,
        value: 0,
      }));
      const controller = {
        id: "E2E Profile Controller",
        index: 0,
        connected: true,
        mapping: "standard",
        axes: [0, 0, 0, 0],
        buttons,
        timestamp: 1,
      };
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: () => [controller],
      });
    });
    await first.page.getByRole("button", { name: "Settings" }).click();
    await first.page
      .getByLabel("Active controller")
      .selectOption({ label: "E2E Profile Controller · slot 1" });
    await expect(first.page.getByLabel("Active controller")).toHaveValue(
      "E2E Profile Controller",
    );
    await first.page.getByRole("button", { name: "Low" }).click();
    await first.page
      .getByRole("button", { name: "Relaxed 12 percent deadzone" })
      .click();
    await expect(
      first.page.getByRole("button", { name: "Low" }),
    ).toHaveAttribute("aria-pressed", "true");

    await first.app.close();
    running = undefined;
    const restarted = await launch({ userData: first.userData });
    running = restarted.app;
    await restarted.page.getByRole("button", { name: "Settings" }).click();

    await expect(restarted.page.getByLabel("Active controller")).toHaveValue(
      "E2E Profile Controller",
    );
    await expect(
      restarted.page.getByRole("button", { name: "Low" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      restarted.page.getByRole("button", {
        name: "Relaxed 12 percent deadzone",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await expectNoAccessibilityViolations(restarted.page, "settings profile");
  } finally {
    await running?.close();
  }
});

test("Health keeps the latest latency and input buffer readings after a stream", async () => {
  const { app, page } = await launch();
  try {
    await page.getByRole("button", { name: /Play now/ }).click();
    await expect(page.getByTestId("mock-stream")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const telemetry = (await window.afterglide.getSnapshot()).telemetry;
          return [
            telemetry.roundTripMs,
            telemetry.jitterBufferMs,
            telemetry.inputQueueBytes,
          ];
        }),
      )
      .toEqual([23, 8.4, 0]);

    await page.keyboard.press("F10");
    await page.getByRole("button", { name: "Leave Xbox stream" }).click();
    await expect(
      page.getByRole("heading", { name: "Studio Series S" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Health" }).click();

    for (const [label, value] of [
      ["Last round trip", "23 ms"],
      ["Decode time per frame", "4.2 ms"],
      ["Video buffer delay", "8.4 ms"],
      ["Input send queue", "0 bytes"],
      ["Frame interval p95", "16.7 ms"],
      ["Frame interval p99", "17.4 ms"],
    ]) {
      await expect(
        page.locator(".diagnostic-row").filter({ hasText: label }),
      ).toContainText(value);
    }
    await expectNoAccessibilityViolations(page, "measured health");
  } finally {
    await app.close();
  }
});
