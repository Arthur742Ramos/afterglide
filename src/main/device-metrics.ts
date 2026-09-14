import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeviceMetrics } from "./performance-report";

async function readNumber(path: string): Promise<number> {
  const text = (await readFile(path, "utf8")).trim();
  const value = text.length > 0 ? Number(text) : Number.NaN;
  if (!Number.isFinite(value)) throw new Error(`Invalid sensor value: ${path}`);
  return value;
}

export async function readDeviceMetrics(
  processCpuPercent: number | undefined,
  platform = process.platform,
  sysRoot = "/sys",
): Promise<DeviceMetrics> {
  const result: DeviceMetrics = {
    observedAt: Date.now(),
    processCpuPercent:
      processCpuPercent !== undefined && Number.isFinite(processCpuPercent)
        ? Math.max(0, processCpuPercent)
        : undefined,
    unavailable: [],
  };
  if (result.processCpuPercent === undefined)
    result.unavailable.push("Electron process CPU readings unavailable.");
  if (platform !== "linux") {
    result.unavailable.push("Battery and thermal capture require Linux sysfs.");
    return result;
  }
  try {
    const root = join(sysRoot, "class/power_supply");
    const supplies = await readdir(root);
    let battery: string | undefined;
    for (const name of supplies.sort()) {
      const path = join(root, name);
      if ((await readFile(join(path, "type"), "utf8")).trim() === "Battery") {
        battery = path;
        break;
      }
    }
    if (!battery) throw new Error("No battery sensor found.");
    result.batteryState = (
      await readFile(join(battery, "status"), "utf8")
    ).trim();
    const capacity = await readNumber(join(battery, "capacity"));
    if (capacity >= 0 && capacity <= 100) result.batteryPercent = capacity;
    else
      result.unavailable.push("Battery capacity is outside its valid range.");
    if (result.batteryState === "Discharging") {
      let watts: number;
      try {
        watts = (await readNumber(join(battery, "power_now"))) / 1_000_000;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
        watts =
          ((await readNumber(join(battery, "current_now"))) *
            (await readNumber(join(battery, "voltage_now")))) /
          1_000_000_000_000;
      }
      result.batteryWatts = Math.abs(watts);
    } else {
      result.unavailable.push(
        "Discharge power unavailable while battery is not discharging.",
      );
    }
  } catch (error) {
    result.unavailable.push(
      `Battery capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const root = join(sysRoot, "class/hwmon");
    const devices = await readdir(root);
    const temperatures: number[] = [];
    for (const device of devices.sort()) {
      const path = join(root, device);
      const name = (await readFile(join(path, "name"), "utf8")).trim();
      if (!["amdgpu", "k10temp", "coretemp", "zenpower"].includes(name))
        continue;
      for (const sensor of await readdir(path)) {
        if (!/^temp\d+_input$/.test(sensor)) continue;
        const value = (await readNumber(join(path, sensor))) / 1_000;
        if (value >= -20 && value <= 150) temperatures.push(value);
      }
    }
    if (temperatures.length > 0)
      result.temperatureCelsius = Math.max(...temperatures);
    else
      result.unavailable.push("No supported CPU/GPU temperature sensor found.");
  } catch (error) {
    result.unavailable.push(
      `Thermal capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result;
}
