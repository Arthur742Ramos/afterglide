import type {
  AppSettings,
  ControllerButtonLayout,
  ControllerDeadzone,
  ControllerProfile,
  ControllerRumble,
  ControllerTriggerRange,
  ControllerTuning,
} from "./contracts";
import { defaultControllerTuning, defaultSettings } from "./contracts";

const rumbleValues = new Set<ControllerRumble>(["off", "low", "full"]);
const layoutValues = new Set<ControllerButtonLayout>([
  "standard",
  "swap-ab",
  "swap-xy",
  "swap-both",
]);
const deadzoneValues = new Set<ControllerDeadzone>([0.04, 0.08, 0.12]);
const triggerValues = new Set<ControllerTriggerRange>([0.5, 0.75, 1]);

function tuning(value: unknown, fallback: ControllerTuning): ControllerTuning {
  const candidate =
    value && typeof value === "object"
      ? (value as Partial<ControllerTuning>)
      : {};
  return {
    rumble: rumbleValues.has(candidate.rumble as ControllerRumble)
      ? (candidate.rumble as ControllerRumble)
      : fallback.rumble,
    buttonLayout: layoutValues.has(
      candidate.buttonLayout as ControllerButtonLayout,
    )
      ? (candidate.buttonLayout as ControllerButtonLayout)
      : fallback.buttonLayout,
    stickDeadzone: deadzoneValues.has(
      candidate.stickDeadzone as ControllerDeadzone,
    )
      ? (candidate.stickDeadzone as ControllerDeadzone)
      : fallback.stickDeadzone,
    triggerRange: triggerValues.has(
      candidate.triggerRange as ControllerTriggerRange,
    )
      ? (candidate.triggerRange as ControllerTriggerRange)
      : fallback.triggerRange,
  };
}

function profiles(value: unknown): ControllerProfile[] {
  if (!Array.isArray(value)) return [];
  const result: ControllerProfile[] = [];
  const ids = new Set<string>();
  for (const candidate of value.slice(0, 16)) {
    if (!candidate || typeof candidate !== "object") continue;
    const id = String((candidate as { id?: unknown }).id ?? "").trim();
    if (!id || id.length > 256 || ids.has(id)) continue;
    ids.add(id);
    result.push({ id, ...tuning(candidate, defaultControllerTuning) });
  }
  return result;
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const candidate =
    value && typeof value === "object" ? (value as Partial<AppSettings>) : {};
  const preferredControllerId =
    typeof candidate.preferredControllerId === "string" &&
    candidate.preferredControllerId.length <= 256
      ? candidate.preferredControllerId
      : "";
  return {
    resolution: candidate.resolution === 720 ? 720 : 1080,
    reducedMotion:
      typeof candidate.reducedMotion === "boolean"
        ? candidate.reducedMotion
        : defaultSettings.reducedMotion,
    showPerformance:
      typeof candidate.showPerformance === "boolean"
        ? candidate.showPerformance
        : defaultSettings.showPerformance,
    keyboardControls:
      typeof candidate.keyboardControls === "boolean"
        ? candidate.keyboardControls
        : defaultSettings.keyboardControls,
    controllerMenuShortcut:
      candidate.controllerMenuShortcut === "steam-input"
        ? "steam-input"
        : "stick-chord",
    preferredControllerId,
    controllerDefaults: tuning(
      candidate.controllerDefaults,
      defaultControllerTuning,
    ),
    controllerProfiles: profiles(candidate.controllerProfiles),
    launchFullscreen:
      typeof candidate.launchFullscreen === "boolean"
        ? candidate.launchFullscreen
        : defaultSettings.launchFullscreen,
    onboardingComplete:
      typeof candidate.onboardingComplete === "boolean"
        ? candidate.onboardingComplete
        : defaultSettings.onboardingComplete,
  };
}

export function sanitizeSettingsUpdate(
  update: Partial<AppSettings>,
  current: AppSettings,
): Partial<AppSettings> {
  const allowed: Partial<AppSettings> = {};
  if (update.resolution === 720 || update.resolution === 1080)
    allowed.resolution = update.resolution;
  if (
    update.controllerMenuShortcut === "stick-chord" ||
    update.controllerMenuShortcut === "steam-input"
  )
    allowed.controllerMenuShortcut = update.controllerMenuShortcut;
  for (const key of [
    "reducedMotion",
    "showPerformance",
    "keyboardControls",
    "launchFullscreen",
    "onboardingComplete",
  ] as const) {
    if (typeof update[key] === "boolean") allowed[key] = update[key];
  }
  if (
    typeof update.preferredControllerId === "string" &&
    update.preferredControllerId.length <= 256
  )
    allowed.preferredControllerId = update.preferredControllerId;
  if (
    update.controllerDefaults !== undefined &&
    typeof update.controllerDefaults === "object" &&
    update.controllerDefaults !== null
  )
    allowed.controllerDefaults = tuning(
      update.controllerDefaults,
      current.controllerDefaults,
    );
  if (Array.isArray(update.controllerProfiles))
    allowed.controllerProfiles = profiles(update.controllerProfiles);
  return allowed;
}

export function tuningForController(
  settings: Pick<AppSettings, "controllerDefaults" | "controllerProfiles">,
  controllerId: string,
): ControllerTuning {
  return (
    settings.controllerProfiles.find(
      (profile) => profile.id === controllerId,
    ) ?? settings.controllerDefaults
  );
}
