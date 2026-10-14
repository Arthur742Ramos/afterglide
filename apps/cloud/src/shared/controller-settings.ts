import {
  normalizeAppSettings as normalizeBase,
  sanitizeSettingsUpdate as sanitizeBase,
} from "../../../../src/shared/controller-settings";
import type { AppSettings } from "./contracts";
export { tuningForController } from "../../../../src/shared/controller-settings";

export function normalizeAppSettings(value: unknown): AppSettings {
  const mode =
    value && typeof value === "object" && "playbackMode" in value
      ? value.playbackMode
      : undefined;
  return {
    ...normalizeBase(value),
    playbackMode: mode === "smooth" ? "smooth" : "automatic",
  };
}

export function sanitizeSettingsUpdate(
  update: Partial<AppSettings>,
  current: AppSettings,
): Partial<AppSettings> {
  const result: Partial<AppSettings> = sanitizeBase(update, current);
  if (update.playbackMode === "automatic" || update.playbackMode === "smooth")
    result.playbackMode = update.playbackMode;
  return result;
}
