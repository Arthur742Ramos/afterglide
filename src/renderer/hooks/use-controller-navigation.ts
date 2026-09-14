import { useEffect, useRef } from "react";
import { selectController } from "../stream/controller-input";

const actionKeys: Record<string, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

const arrowKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
const repeatingActions = new Set(["up", "down", "left", "right"]);
const repeatDelayMs = 360;
const repeatIntervalMs = 95;

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function center(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function nextInDirection(
  items: HTMLElement[],
  current: HTMLElement,
  key: string,
): HTMLElement | undefined {
  const originRect = current.getBoundingClientRect();
  const origin = center(originRect);
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const sign = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;

  return items
    .filter((item) => item !== current)
    .map((item) => {
      const rect = item.getBoundingClientRect();
      const point = center(rect);
      const primary =
        sign * (horizontal ? point.x - origin.x : point.y - origin.y);
      const secondary = Math.abs(
        horizontal ? point.y - origin.y : point.x - origin.x,
      );
      const overlaps = horizontal
        ? rect.bottom >= originRect.top && rect.top <= originRect.bottom
        : rect.right >= originRect.left && rect.left <= originRect.right;
      return {
        item,
        primary,
        score: primary + secondary * (overlaps ? 0.2 : 2.2),
      };
    })
    .filter(({ primary }) => primary > 2)
    .sort((a, b) => a.score - b.score)[0]?.item;
}

export function useControllerNavigation(
  enabled: boolean,
  focusScope?: string,
  preferredControllerId = "",
): void {
  const previousScope = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    const scopeChanged =
      previousScope.current !== undefined &&
      previousScope.current !== focusScope;
    previousScope.current = focusScope;
    const focusables = (): HTMLElement[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-focusable]:not([disabled])",
        ),
      ).filter((element) => element.offsetParent !== null);

    const perform = (action: string): void => {
      if (action === "accept") {
        (document.activeElement as HTMLElement | null)?.click();
        return;
      }
      if (action === "back") {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        return;
      }
      const key = actionKeys[action] ?? action;
      if (!arrowKeys.includes(key)) return;
      const items = focusables();
      if (items.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const current = active ? items.indexOf(active) : -1;
      if (current < 0 || !active) {
        items[0]?.focus();
        return;
      }
      const direction = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
      const next =
        nextInDirection(items, active, key) ??
        items[(current + direction + items.length) % items.length];
      next?.focus({ preventScroll: true });
      next?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!arrowKeys.includes(event.key) || isTextEntry(event.target)) return;
      perform(event.key);
      event.preventDefault();
    };
    const onGamepad = (event: Event): void => {
      perform((event as CustomEvent<string>).detail);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("afterglide-gamepad", onGamepad);

    let previous = new Set<string>();
    const repeatAt = new Map<string, number>();
    let activeGamepadIndex: number | undefined;
    let frame = 0;
    const pollGamepad = (now: number): void => {
      const gamepad = selectController(
        navigator.getGamepads(),
        preferredControllerId,
        activeGamepadIndex,
      );
      activeGamepadIndex = gamepad?.index;
      const active = new Set<string>();
      if (gamepad) {
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
      }
      active.forEach((action) => {
        if (!previous.has(action)) {
          perform(action);
          if (repeatingActions.has(action))
            repeatAt.set(action, now + repeatDelayMs);
        } else if (
          repeatingActions.has(action) &&
          now >= (repeatAt.get(action) ?? Number.POSITIVE_INFINITY)
        ) {
          perform(action);
          repeatAt.set(action, now + repeatIntervalMs);
        }
      });
      repeatAt.forEach((_time, action) => {
        if (!active.has(action)) repeatAt.delete(action);
      });
      previous = active;
      frame = requestAnimationFrame(pollGamepad);
    };
    frame = requestAnimationFrame(pollGamepad);

    const initial = window.setTimeout(() => {
      const items = focusables();
      if (
        !scopeChanged &&
        items.includes(document.activeElement as HTMLElement)
      )
        return;
      (
        items.find((item) => item.hasAttribute("data-autofocus")) ?? items[0]
      )?.focus();
    }, 40);
    return () => {
      clearTimeout(initial);
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("afterglide-gamepad", onGamepad);
    };
  }, [enabled, focusScope, preferredControllerId]);
}
