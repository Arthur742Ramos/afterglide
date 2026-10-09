import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDeviceMetrics } from "../../src/main/device-metrics";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

async function fixtures(files: Record<string, string>) {
  root = await mkdtemp(join(tmpdir(), "afterglide-sensors-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

const battery = {
  "class/power_supply/BAT1/type": "Battery",
  "class/power_supply/BAT1/status": "Discharging",
  "class/power_supply/BAT1/capacity": "78",
};
const thermal = {
  "class/hwmon/hwmon0/name": "amdgpu",
  "class/hwmon/hwmon0/temp1_input": "58000",
  "class/hwmon/hwmon0/temp2_input": "62000",
};

describe("device performance capture", () => {
  it("converts Linux units and records the hottest supported sensor", async () => {
    await fixtures({
      ...battery,
      ...thermal,
      "class/power_supply/BAT1/power_now": "9500000",
    });
    expect(await readDeviceMetrics(23, "linux", root)).toMatchObject({
      processCpuPercent: 23,
      batteryWatts: 9.5,
      batteryPercent: 78,
      batteryState: "Discharging",
      temperatureCelsius: 62,
      unavailable: [],
    });
  });

  it("uses current times voltage only when the power sensor is absent", async () => {
    await fixtures({
      ...battery,
      ...thermal,
      "class/power_supply/BAT1/current_now": "1000000",
      "class/power_supply/BAT1/voltage_now": "8000000",
    });
    expect((await readDeviceMetrics(10, "linux", root)).batteryWatts).toBe(8);
    await writeFile(join(root, "class/power_supply/BAT1/power_now"), "broken");
    const broken = await readDeviceMetrics(10, "linux", root);
    expect(broken.batteryWatts).toBeUndefined();
    expect(broken.unavailable.join()).toContain("Invalid sensor value");
  });

  it("does not mistake charging power for battery consumption", async () => {
    await fixtures({
      ...battery,
      ...thermal,
      "class/power_supply/BAT1/status": "Charging",
      "class/power_supply/BAT1/power_now": "20000000",
    });
    const reading = await readDeviceMetrics(10, "linux", root);
    expect(reading.batteryWatts).toBeUndefined();
    expect(reading.unavailable.join()).toContain("not discharging");
  });

  it("reports absent or unsupported readings without fabricated zeros", async () => {
    const unsupported = await readDeviceMetrics(undefined, "darwin");
    expect(unsupported.batteryWatts).toBeUndefined();
    expect(unsupported.processCpuPercent).toBeUndefined();
    expect(unsupported.unavailable).toHaveLength(2);
    await fixtures({});
    const missing = await readDeviceMetrics(0, "linux", root);
    expect(missing.batteryWatts).toBeUndefined();
    expect(missing.temperatureCelsius).toBeUndefined();
    expect(missing.unavailable).toHaveLength(2);
  });
});
