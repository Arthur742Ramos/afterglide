import { useEffect } from "react";

const actionKeys: Record<string, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

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
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key))
        return;
      const items = focusables();
      if (items.length === 0) return;
      const current = Math.max(
        0,
        items.indexOf(document.activeElement as HTMLElement),
      );
      const direction = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
      items[(current + direction + items.length) % items.length]?.focus();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
      )
        return;
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
