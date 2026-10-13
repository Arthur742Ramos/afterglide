import type { GamepadLike } from "./controller-input";

/** A physical chord must have a neutral sample after mount, resume or hotplug. */
export class ControllerChordInput {
  private controller?: Pick<GamepadLike, "id" | "index">;
  private released = false;

  reset(): void {
    this.controller = undefined;
    this.released = false;
  }

  consume(gamepad: GamepadLike | undefined): boolean {
    if (!gamepad) {
      this.reset();
      return false;
    }
    if (
      this.controller?.id !== gamepad.id ||
      this.controller?.index !== gamepad.index
    ) {
      this.reset();
      this.controller = { id: gamepad.id, index: gamepad.index };
    }
    const pressed = Boolean(
      gamepad.buttons[10]?.pressed && gamepad.buttons[11]?.pressed,
    );
    if (!pressed) {
      this.released = true;
      return false;
    }
    const activate = this.released;
    this.released = false;
    return activate;
  }
}
