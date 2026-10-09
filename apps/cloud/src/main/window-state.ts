import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DesktopRectangle } from "./desktop-policy";

export function readWindowState(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function saveWindowState(
  path: string,
  bounds: DesktopRectangle,
  maximized: boolean,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ bounds, maximized }), {
    mode: 0o600,
  });
  renameSync(temporary, path);
}
