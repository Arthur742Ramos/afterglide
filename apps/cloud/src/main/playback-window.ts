import type { BrowserWindow, PowerMonitor } from "electron";
import type { PlaybackWindowState, SessionPhase } from "../shared/contracts";

/** Keep focused gameplay rendering through macOS occlusion transitions. */
export function observePlaybackWindow(
  window: Pick<
    BrowserWindow,
    | "on"
    | "removeListener"
    | "isVisible"
    | "isMinimized"
    | "isFocused"
    | "isDestroyed"
    | "webContents"
  >,
  power: Pick<PowerMonitor, "on" | "removeListener">,
  publish: (state: PlaybackWindowState) => void,
  backgroundTest = false,
) {
  let phase: SessionPhase = "idle";
  let screenLocked = false;
  let suspended = false;
  let disposed = false;
  let previous = "";
  const sync = () => {
    if (disposed || window.isDestroyed() || window.webContents.isDestroyed())
      return;
    const visible = window.isVisible();
    const minimized = window.isMinimized();
    const focused = window.isFocused();
    const playing =
      phase === "negotiating" ||
      phase === "streaming" ||
      phase === "recovering";
    const backgroundThrottling =
      !backgroundTest &&
      !(
        playing &&
        visible &&
        !minimized &&
        focused &&
        !screenLocked &&
        !suspended
      );
    if (window.webContents.getBackgroundThrottling() !== backgroundThrottling)
      window.webContents.setBackgroundThrottling(backgroundThrottling);
    const state = {
      visible,
      minimized,
      focused,
      screenLocked,
      suspended,
      backgroundThrottling,
    };
    const key = JSON.stringify(state);
    if (key !== previous) {
      previous = key;
      publish(state);
    }
  };
  const lock = () => {
    screenLocked = true;
    sync();
  };
  const unlock = () => {
    screenLocked = false;
    sync();
  };
  const suspend = () => {
    suspended = true;
    sync();
  };
  const resume = () => {
    suspended = false;
    sync();
  };
  window.on("show", sync);
  window.on("hide", sync);
  window.on("minimize", sync);
  window.on("restore", sync);
  window.on("focus", sync);
  window.on("blur", sync);
  power.on("lock-screen", lock);
  power.on("unlock-screen", unlock);
  power.on("suspend", suspend);
  power.on("resume", resume);
  sync();
  return {
    setPhase(value: SessionPhase) {
      phase = value;
      sync();
    },
    dispose() {
      disposed = true;
      window.removeListener("show", sync);
      window.removeListener("hide", sync);
      window.removeListener("minimize", sync);
      window.removeListener("restore", sync);
      window.removeListener("focus", sync);
      window.removeListener("blur", sync);
      power.removeListener("lock-screen", lock);
      power.removeListener("unlock-screen", unlock);
      power.removeListener("suspend", suspend);
      power.removeListener("resume", resume);
    },
  };
}
