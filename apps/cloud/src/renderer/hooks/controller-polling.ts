import type { GamepadLike } from "../stream/controller-input";

export const controllerDiscoveryIntervalMs = 250;

interface PollingClock {
  requestFrame(callback: (now: number) => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(handle: number): void;
  now(): number;
}

/** Poll only while the surface is active. Hotplug/focus events call refresh. */
export function createControllerPolling(
  clock: PollingClock,
  isActive: () => boolean,
  sample: (now: number) => boolean,
  suspend: () => void,
  activeIntervalMs?: number,
): { refresh(): void; dispose(): void } {
  let frame: number | undefined;
  let timer: number | undefined;
  let active = false;
  let disposed = false;

  const cancel = (): void => {
    if (frame !== undefined) clock.cancelFrame(frame);
    if (timer !== undefined) clock.clearTimer(timer);
    frame = timer = undefined;
  };
  const poll = (now: number): void => {
    if (disposed) return;
    if (!isActive()) {
      cancel();
      if (active) suspend();
      active = false;
      return;
    }
    active = true;
    const connected = sample(now);
    if (disposed) return;
    if (connected && activeIntervalMs === undefined) {
      frame = clock.requestFrame((time) => {
        frame = undefined;
        poll(time);
      });
    } else {
      timer = clock.setTimer(
        () => {
          timer = undefined;
          poll(clock.now());
        },
        connected ? activeIntervalMs! : controllerDiscoveryIntervalMs,
      );
    }
  };
  return {
    refresh() {
      cancel();
      poll(clock.now());
    },
    dispose() {
      disposed = true;
      cancel();
      suspend();
    },
  };
}

const repeatingActions = new Set(["up", "down", "left", "right"]);
const repeatDelayMs = 360;
const repeatIntervalMs = 95;

/** Keep physical edges separate from synthetic UI actions and screen changes. */
export class ControllerNavigationInput {
  private previous = new Set<string>();
  private readonly repeatAt = new Map<string, number>();
  private controller?: Pick<GamepadLike, "id" | "index">;

  reset(): void {
    this.previous.clear();
    this.repeatAt.clear();
    this.controller = undefined;
  }

  actions(gamepad: GamepadLike | undefined, now: number): string[] {
    if (!gamepad) {
      this.reset();
      return [];
    }
    const changed =
      this.controller?.index !== gamepad.index ||
      this.controller?.id !== gamepad.id;
    if (changed) this.reset();
    this.controller = { id: gamepad.id, index: gamepad.index };
    const active = new Set<string>();
    const dpad = [
      gamepad.buttons[12]?.pressed ? "up" : "",
      gamepad.buttons[13]?.pressed ? "down" : "",
      gamepad.buttons[14]?.pressed ? "left" : "",
      gamepad.buttons[15]?.pressed ? "right" : "",
    ].filter(Boolean);
    if (dpad.length > 0) dpad.forEach((action) => active.add(action));
    else {
      const x = gamepad.axes[0] ?? 0;
      const y = gamepad.axes[1] ?? 0;
      if (Math.max(Math.abs(x), Math.abs(y)) > 0.65)
        active.add(
          Math.abs(x) > Math.abs(y)
            ? x < 0
              ? "left"
              : "right"
            : y < 0
              ? "up"
              : "down",
        );
    }
    if (gamepad.buttons[1]?.pressed) active.add("back");
    else if (gamepad.buttons[0]?.pressed) active.add("accept");
    // Confirmation/back held on mount, refocus or hotplug must be released.
    if (changed) {
      for (const action of ["accept", "back"]) {
        if (active.has(action)) this.previous.add(action);
      }
    }
    const actions: string[] = [];
    active.forEach((action) => {
      if (!this.previous.has(action)) {
        actions.push(action);
        if (repeatingActions.has(action))
          this.repeatAt.set(action, now + repeatDelayMs);
      } else if (
        repeatingActions.has(action) &&
        now >= (this.repeatAt.get(action) ?? Number.POSITIVE_INFINITY)
      ) {
        actions.push(action);
        this.repeatAt.set(action, now + repeatIntervalMs);
      }
    });
    this.repeatAt.forEach((_time, action) => {
      if (!active.has(action)) this.repeatAt.delete(action);
    });
    this.previous = active;
    return actions;
  }
}
