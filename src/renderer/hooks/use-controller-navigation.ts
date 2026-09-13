import { useEffect } from "react";

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
): void {
  useEffect(() => {
    if (!enabled) return;
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
    let frame = 0;
    const pollGamepad = (): void => {
      const gamepad = navigator
        .getGamepads()
        .find((candidate) => candidate?.connected);
      const active = new Set<string>();
      if (gamepad) {
        if (gamepad.buttons[12]?.pressed || (gamepad.axes[1] ?? 0) < -0.65)
          active.add("up");
        if (gamepad.buttons[13]?.pressed || (gamepad.axes[1] ?? 0) > 0.65)
          active.add("down");
        if (gamepad.buttons[14]?.pressed || (gamepad.axes[0] ?? 0) < -0.65)
          active.add("left");
        if (gamepad.buttons[15]?.pressed || (gamepad.axes[0] ?? 0) > 0.65)
          active.add("right");
        if (gamepad.buttons[0]?.pressed) active.add("accept");
        if (gamepad.buttons[1]?.pressed) active.add("back");
      }
      active.forEach((action) => {
        if (!previous.has(action)) perform(action);
      });
      previous = active;
      frame = requestAnimationFrame(pollGamepad);
    };
    frame = requestAnimationFrame(pollGamepad);

    const initial = window.setTimeout(() => {
      const items = focusables();
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
  }, [enabled, focusScope]);
}
