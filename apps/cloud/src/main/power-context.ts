import type { PowerMonitor } from "electron";
import type { PowerContext } from "../shared/contracts";

const thermalStates = new Set([
  "unknown",
  "nominal",
  "fair",
  "serious",
  "critical",
]);

/** Event-driven OS context. Unknown speed is never filled with an assumed 100%. */
export function observePowerContext(
  monitor: Pick<
    PowerMonitor,
    "on" | "removeListener" | "isOnBatteryPower" | "getCurrentThermalState"
  >,
  platform: string,
  publish: (context: PowerContext) => void,
  now = Date.now,
): () => void {
  let disposed = false;
  const context: PowerContext = {};
  const emit = () => {
    if (!disposed) publish({ ...context });
  };
  const power = (onBattery: boolean) => {
    if (disposed || context.onBattery === onBattery) return;
    context.onBattery = onBattery;
    context.powerObservedAt = now();
    emit();
  };
  const thermal = ({ state }: { state: string }) => {
    if (disposed || !thermalStates.has(state) || context.thermalState === state)
      return;
    context.thermalState = state as PowerContext["thermalState"];
    context.thermalObservedAt = now();
    emit();
  };
  const speed = ({ limit }: { limit: number }) => {
    if (
      disposed ||
      !Number.isFinite(limit) ||
      limit < 0 ||
      limit > 100 ||
      context.speedLimitPercent === limit
    )
      return;
    context.speedLimitPercent = limit;
    context.speedLimitObservedAt = now();
    emit();
  };
  const refresh = () => {
    if (disposed) return;
    // Suspend/wake invalidates the last notification, without inventing a reading.
    delete context.speedLimitPercent;
    delete context.speedLimitObservedAt;
    delete context.onBattery;
    delete context.powerObservedAt;
    delete context.thermalState;
    delete context.thermalObservedAt;
    if (platform === "darwin" || platform === "win32") {
      try {
        const value = monitor.isOnBatteryPower();
        if (typeof value === "boolean") {
          context.onBattery = value;
          context.powerObservedAt = now();
        }
      } catch {
        delete context.onBattery;
        delete context.powerObservedAt;
      }
    }
    if (platform === "darwin") {
      try {
        const state = monitor.getCurrentThermalState();
        if (!thermalStates.has(state)) throw new Error("Unknown thermal value");
        context.thermalState = state;
        context.thermalObservedAt = now();
      } catch {
        delete context.thermalState;
        delete context.thermalObservedAt;
      }
    }
    emit();
  };
  const onAc = () => power(false);
  const onBattery = () => power(true);
  if (platform === "darwin" || platform === "win32") {
    monitor.on("on-ac", onAc);
    monitor.on("on-battery", onBattery);
    monitor.on("speed-limit-change", speed);
    monitor.on("resume", refresh);
  }
  if (platform === "darwin") monitor.on("thermal-state-change", thermal);
  refresh();
  return () => {
    disposed = true;
    monitor.removeListener("on-ac", onAc);
    monitor.removeListener("on-battery", onBattery);
    monitor.removeListener("speed-limit-change", speed);
    monitor.removeListener("thermal-state-change", thermal);
    monitor.removeListener("resume", refresh);
  };
}
