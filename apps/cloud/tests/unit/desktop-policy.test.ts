import { describe, expect, it } from "vitest";
import {
  desktopMenuTemplate,
  restoreWindowPlacement,
  shouldQuitAfterLastWindow,
} from "../../src/main/desktop-policy";

const primary = { x: 0, y: 0, width: 1366, height: 728 };
describe("desktop placement and native policy", () => {
  it("fits high-DPI laptop work areas, including minimum dimensions", () => {
    const area = { x: 0, y: 0, width: 910, height: 480 };
    expect(restoreWindowPlacement(undefined, [area], area)).toMatchObject({
      bounds: area,
      minWidth: 910,
      minHeight: 480,
    });
  });
  it("restores a connected negative-coordinate display", () => {
    const area = { x: -1920, y: 0, width: 1920, height: 1040 };
    const bounds = { x: -1600, y: 80, width: 1200, height: 740 };
    expect(
      restoreWindowPlacement(
        { bounds, maximized: true },
        [primary, area],
        primary,
      ),
    ).toMatchObject({ bounds, maximized: true });
  });
  it("keeps the entire window visible after disconnecting a monitor", () => {
    const result = restoreWindowPlacement(
      { bounds: { x: 4000, y: -500, width: 2400, height: 1400 } },
      [primary],
      primary,
    );
    expect(result.bounds).toEqual(primary);
  });
  it("ignores malformed saved geometry without destroying preferences", () => {
    const result = restoreWindowPlacement(
      { bounds: { x: NaN, y: 0, width: -1, height: 500 } },
      [primary],
      primary,
    );
    expect(result.bounds.width).toBe(1280);
    expect(result.bounds.height).toBe(728);
    expect(result.bounds.x).toBeGreaterThanOrEqual(0);
  });
  it("keeps a live Mac app open for Dock reopen and quits Windows", () => {
    expect(shouldQuitAfterLastWindow("darwin", false)).toBe(false);
    expect(shouldQuitAfterLastWindow("win32", false)).toBe(true);
    expect(shouldQuitAfterLastWindow("darwin", true)).toBe(true);
  });
  it("uses Mac app preferences and the native fullscreen shortcut", () => {
    const menu = desktopMenuTemplate("darwin", () => {});
    expect(menu[0].role).toBe("appMenu");
    const view = menu.find((m) => m.label === "View")!.submenu as Array<{
      id?: string;
      accelerator?: string;
    }>;
    expect(view.find((m) => m.id === "desktop-fullscreen")!.accelerator).toBe(
      "Ctrl+Command+F",
    );
  });
  it("provides useful commands without reload/developer actions during play", () => {
    const commands: string[] = [];
    const menu = desktopMenuTemplate("win32", (command) =>
      commands.push(command),
    );
    const items = menu.flatMap((m) =>
      Array.isArray(m.submenu) ? m.submenu : [],
    );
    expect(items.map((m) => m.role)).not.toContain("reload");
    expect(items.map((m) => m.role)).not.toContain("toggleDevTools");
    const search = items.find((m) => m.id === "desktop-search")!;
    expect(search.accelerator).toBe("CmdOrCtrl+F");
    search.click?.({} as never, undefined, {} as never);
    expect(commands).toEqual(["search"]);
  });
});
