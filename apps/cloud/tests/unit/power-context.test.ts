import { EventEmitter } from "node:events";
import type { PowerMonitor } from "electron";
import { describe, expect, it, vi } from "vitest";
import { observePowerContext } from "../../src/main/power-context";
import type { PowerContext } from "../../src/shared/contracts";

function fixture(platform: string) {
  const monitor = Object.assign(new EventEmitter(), {
    isOnBatteryPower: vi.fn(() => false),
    getCurrentThermalState: vi.fn(() => "nominal"),
  });
  const snapshots: PowerContext[] = [];
  let at = 1;
  const dispose = observePowerContext(
    monitor as unknown as PowerMonitor,
    platform,
    (context) => snapshots.push(context),
    () => at++,
  );
  return { monitor, snapshots, dispose };
}
describe("local OS power context", () => {
  it("preserves AC false and zero speed; deduplicates notifications and removes listeners", () => {
    const { monitor, snapshots, dispose } = fixture("win32");
    expect(snapshots.at(-1)).toEqual({ onBattery: false, powerObservedAt: 1 });
    expect(snapshots.at(-1)?.speedLimitPercent).toBeUndefined();
    expect(monitor.getCurrentThermalState).not.toHaveBeenCalled();
    monitor.emit("on-battery");
    monitor.emit("speed-limit-change", { limit: 0 });
    expect(snapshots.at(-1)).toMatchObject({
      onBattery: true,
      speedLimitPercent: 0,
      speedLimitObservedAt: 3,
    });
    const length = snapshots.length;
    monitor.emit("speed-limit-change", { limit: 0 });
    for (const limit of [undefined, -1, 101, NaN, "50"])
      monitor.emit("speed-limit-change", { limit });
    expect(snapshots).toHaveLength(length);
    dispose();
    expect(monitor.eventNames()).toEqual([]);
    monitor.emit("on-ac");
    expect(snapshots).toHaveLength(length);
  });
  it("initializes Mac severity, refreshes on resume and never assumes a speed limit", () => {
    const { monitor, snapshots, dispose } = fixture("darwin");
    expect(snapshots.at(-1)).toMatchObject({ thermalState: "nominal" });
    monitor.emit("thermal-state-change", { state: "serious" });
    monitor.emit("speed-limit-change", { limit: 60 });
    expect(snapshots.at(-1)).toMatchObject({
      thermalState: "serious",
      speedLimitPercent: 60,
    });
    monitor.getCurrentThermalState.mockReturnValue("unknown");
    monitor.emit("resume");
    expect(snapshots.at(-1)).toMatchObject({
      onBattery: false,
      thermalState: "unknown",
    });
    expect(snapshots.at(-1)?.speedLimitPercent).toBeUndefined();
    monitor.isOnBatteryPower.mockImplementation(() => {
      throw new Error("Unavailable");
    });
    monitor.getCurrentThermalState.mockImplementation(() => {
      throw new Error("Unavailable");
    });
    monitor.emit("resume");
    expect(snapshots.at(-1)).toEqual({});
    dispose();
  });
  it("does not request unsupported platform readings", () => {
    const { monitor, snapshots, dispose } = fixture("linux");
    expect(snapshots).toEqual([{}]);
    expect(monitor.isOnBatteryPower).not.toHaveBeenCalled();
    expect(monitor.getCurrentThermalState).not.toHaveBeenCalled();
    expect(monitor.eventNames()).toEqual([]);
    dispose();
  });
});
