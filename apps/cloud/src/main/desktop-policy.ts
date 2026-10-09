import type { MenuItemConstructorOptions } from "electron";
import type { DesktopCommand } from "../shared/contracts";

export interface DesktopRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function restoreWindowPlacement(
  stored: unknown,
  workAreas: DesktopRectangle[],
  primary: DesktopRectangle,
) {
  const state = stored as
    | { bounds?: Partial<DesktopRectangle>; maximized?: boolean }
    | undefined;
  const rect = state?.bounds;
  const valid =
    rect &&
    [rect.x, rect.y, rect.width, rect.height].every(
      (v) => typeof v === "number" && Number.isFinite(v),
    ) &&
    rect.width! > 0 &&
    rect.height! > 0;
  const area = valid
    ? (workAreas
        .map((work) => ({
          work,
          overlap:
            Math.max(
              0,
              Math.min(rect.x! + rect.width!, work.x + work.width) -
                Math.max(rect.x!, work.x),
            ) *
            Math.max(
              0,
              Math.min(rect.y! + rect.height!, work.y + work.height) -
                Math.max(rect.y!, work.y),
            ),
        }))
        .sort((a, b) => b.overlap - a.overlap)
        .find((item) => item.overlap > 0)?.work ?? primary)
    : primary;
  const minWidth = Math.min(960, area.width);
  const minHeight = Math.min(600, area.height);
  const width = Math.round(
    Math.min(area.width, Math.max(minWidth, valid ? rect.width! : 1280)),
  );
  const height = Math.round(
    Math.min(area.height, Math.max(minHeight, valid ? rect.height! : 800)),
  );
  return {
    bounds: {
      x: Math.round(
        valid
          ? Math.min(area.x + area.width - width, Math.max(area.x, rect.x!))
          : area.x + (area.width - width) / 2,
      ),
      y: Math.round(
        valid
          ? Math.min(area.y + area.height - height, Math.max(area.y, rect.y!))
          : area.y + (area.height - height) / 2,
      ),
      width,
      height,
    },
    minWidth,
    minHeight,
    maximized: state?.maximized === true,
  };
}

export function shouldQuitAfterLastWindow(platform: string, test: boolean) {
  return platform !== "darwin" || test;
}

export function desktopMenuTemplate(
  platform: string,
  send: (command: DesktopCommand) => void,
): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const preferences: MenuItemConstructorOptions = {
    id: "desktop-settings",
    label: "Settings",
    accelerator: "CmdOrCtrl+,",
    click: () => send("settings"),
  };
  return [
    ...(mac
      ? [
          {
            role: "appMenu" as const,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              preferences,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : [
          {
            label: "File",
            submenu: [
              preferences,
              { type: "separator" as const },
              { role: "close" as const },
              { role: "quit" as const },
            ],
          },
        ]),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          id: "desktop-search",
          label: "Search Library",
          accelerator: "CmdOrCtrl+F",
          click: () => send("search"),
        },
        {
          id: "desktop-controls",
          label: "Stream controls",
          accelerator: "F10",
          click: () => send("controls"),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        {
          id: "desktop-fullscreen",
          role: "togglefullscreen",
          accelerator: mac ? "Ctrl+Command+F" : "F11",
        },
      ],
    },
    { role: "windowMenu" },
  ];
}
