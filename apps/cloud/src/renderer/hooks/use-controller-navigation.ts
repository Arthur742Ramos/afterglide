import { useEffect, useRef } from "react";
import { selectController } from "../stream/controller-input";
import {
  ControllerNavigationInput,
  createControllerPolling,
} from "./controller-polling";

const actionKeys: Record<string, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

const arrowKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

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
        ? rect.bottom > originRect.top && rect.top < originRect.bottom
        : rect.right > originRect.left && rect.left < originRect.right;
      return {
        item,
        primary,
        overlaps,
        score: primary + secondary * (overlaps ? 0.2 : 2.2),
      };
    })
    .filter(({ primary }) => primary > 2)
    .sort(
      (a, b) => Number(b.overlaps) - Number(a.overlaps) || a.score - b.score,
    )[0]?.item;
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
    const startingFocus = document.activeElement;
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

    const input = new ControllerNavigationInput();
    let activeGamepadIndex: number | undefined;
    const polling = createControllerPolling(
      {
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (handle) => window.cancelAnimationFrame(handle),
        setTimer: (callback, delay) => window.setTimeout(callback, delay),
        clearTimer: (handle) => window.clearTimeout(handle),
        now: () => performance.now(),
      },
      () => !document.hidden && document.hasFocus(),
      (now) => {
        const gamepad = selectController(
          navigator.getGamepads(),
          preferredControllerId,
          activeGamepadIndex,
        );
        activeGamepadIndex = gamepad?.index;
        input.actions(gamepad, now).forEach(perform);
        return Boolean(gamepad);
      },
      () => {
        activeGamepadIndex = undefined;
        input.reset();
      },
    );
    const refreshPolling = (): void => polling.refresh();
    const disconnect = (): void => {
      activeGamepadIndex = undefined;
      input.reset();
      polling.refresh();
    };
    window.addEventListener("focus", refreshPolling);
    window.addEventListener("blur", refreshPolling);
    window.addEventListener("gamepadconnected", refreshPolling);
    window.addEventListener("gamepaddisconnected", disconnect);
    document.addEventListener("visibilitychange", refreshPolling);
    polling.refresh();
    const initial = window.setTimeout(() => {
      const items = focusables();
      if (
        (!scopeChanged || document.activeElement !== startingFocus) &&
        (items.includes(document.activeElement as HTMLElement) ||
          isTextEntry(document.activeElement))
      )
        return;
      (
        items.find((item) => item.hasAttribute("data-autofocus")) ?? items[0]
      )?.focus();
    }, 40);
    return () => {
      clearTimeout(initial);
      polling.dispose();
      window.removeEventListener("focus", refreshPolling);
      window.removeEventListener("blur", refreshPolling);
      window.removeEventListener("gamepadconnected", refreshPolling);
      window.removeEventListener("gamepaddisconnected", disconnect);
      document.removeEventListener("visibilitychange", refreshPolling);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("afterglide-gamepad", onGamepad);
    };
  }, [enabled, focusScope, preferredControllerId]);
}
