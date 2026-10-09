import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("native Mac fullscreen enters, exits and preserves window placement", async () => {
  test.skip(
    process.platform !== "darwin" ||
      process.env.AFTERGLIDE_CLOUD_NATIVE_MAC !== "1",
    "Run npm run test:mac-native on a Mac; this test opens a visible native window.",
  );
  test.setTimeout(60_000);
  const root = join(import.meta.dirname, "../..");
  mkdirSync(join(root, "artifacts/e2e"), { recursive: true });
  const directory = mkdtempSync(join(root, "artifacts/e2e/native-mac-"));
  const launch = () =>
    electron.launch({
      args: ["."],
      cwd: root,
      env: {
        ...process.env,
        AFTERGLIDE_CLOUD_E2E: "1",
        AFTERGLIDE_CLOUD_E2E_SIGNED_IN: "1",
        AFTERGLIDE_CLOUD_E2E_HEADED: "1",
        AFTERGLIDE_CLOUD_E2E_USER_DATA: directory,
      },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Your cloud library." }),
    ).toBeVisible();
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFullScreenable(),
      ),
    ).toBe(true);
    // OS fullscreen requires a shown, active window. Renderer readiness can
    // precede ready-to-show on a busy machine.
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
      )
      .toBe(true);
    await app.evaluate(({ app: host, BrowserWindow }) => {
      host.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isFocused(),
        ),
      )
      .toBe(true);
    await page.evaluate(() => window.afterglideCloud.setFullscreen(true));
    await expect
      .poll(
        () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].isFullScreen(),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    // Wait for the real OS event, rather than emitting a synthetic event.
    await expect(
      page.getByRole("button", { name: "Exit fullscreen", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFullScreen(),
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Exit fullscreen", exact: true }),
    ).toHaveCount(0, { timeout: 15_000 });
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFullScreen(),
      ),
    ).toBe(false);
    const bounds = await app.evaluate(({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea;
      const window = BrowserWindow.getAllWindows()[0];
      window.setBounds({
        x: area.x + 20,
        y: area.y + 20,
        width: Math.min(1000, area.width),
        height: Math.min(650, area.height),
      });
      return window.getNormalBounds();
    });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Your cloud library." }),
    ).toBeVisible();
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getNormalBounds(),
      ),
    ).toEqual(bounds);
    await page.screenshot({
      path: join(root, "artifacts/e2e/native-mac-compact-library.png"),
    });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
