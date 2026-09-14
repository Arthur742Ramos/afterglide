import {
  emptyXboxInputFrame,
  type XboxButtonName,
  type XboxInputFrame,
} from "./input-schema";

const buttons: XboxButtonName[] = [
  "Nexus",
  "Menu",
  "View",
  "A",
  "B",
  "X",
  "Y",
  "DPadUp",
  "DPadDown",
  "DPadLeft",
  "DPadRight",
  "LeftShoulder",
  "RightShoulder",
  "LeftThumb",
  "RightThumb",
];
const triggers = ["LeftTrigger", "RightTrigger"] as const;
const controls = [...buttons, ...triggers];

export const INPUT_TRANSITION_POLICY = { capacity: 32, maxAgeMs: 250 } as const;
export type InputBufferFailure = "overflow" | "expired";

/**
 * Preserve button and tuned trigger rest/pressed (>0) edges, not historical
 * analog travel. Queued trigger presses use the latest nonzero magnitude;
 * sticks always use the latest position. Limits apply before sending, including
 * on drain. Exceeding either fails visibly and prioritizes neutral.
 */
export class InputTransitionBuffer {
  private transitions: { buttons: number[]; at: number }[] = [];
  private latest = emptyXboxInputFrame();
  private observed = controls.map(() => 0);
  private triggerMagnitudes = [0, 0];
  private sentSignature = "";

  constructor(
    private readonly capacity: number = INPUT_TRANSITION_POLICY.capacity,
    private readonly maxAgeMs: number = INPUT_TRANSITION_POLICY.maxAgeMs,
  ) {}

  clear(): void {
    this.transitions = [];
    this.latest = emptyXboxInputFrame();
    this.observed = controls.map(() => 0);
    this.triggerMagnitudes = [0, 0];
    this.sentSignature = "";
  }

  observe(frame: XboxInputFrame, now: number): InputBufferFailure | undefined {
    if (this.expired(now)) return "expired";
    this.latest = { ...frame };
    triggers.forEach((trigger, index) => {
      if (frame[trigger] > 0) this.triggerMagnitudes[index] = frame[trigger];
    });
    const next = controls.map((control) => Number(frame[control] > 0));
    if (next.some((value, index) => value !== this.observed[index])) {
      if (this.transitions.length >= this.capacity) return "overflow";
      this.transitions.push({ buttons: next, at: now });
      this.observed = next;
    }
    return undefined;
  }

  flush(
    now: number,
    send: (frame: XboxInputFrame) => boolean,
    heartbeat = false,
  ): InputBufferFailure | undefined {
    if (this.expired(now)) return "expired";
    let sent = false;
    while (this.transitions.length) {
      const frame = { ...this.latest };
      buttons.forEach((button, index) => {
        frame[button] = this.transitions[0].buttons[index];
      });
      triggers.forEach((trigger, index) => {
        frame[trigger] = this.transitions[0].buttons[buttons.length + index]
          ? this.triggerMagnitudes[index]
          : 0;
      });
      if (!send(frame)) return undefined;
      this.sentSignature = JSON.stringify(frame);
      this.transitions.shift();
      sent = true;
    }
    const signature = JSON.stringify(this.latest);
    if (signature !== this.sentSignature || (heartbeat && !sent)) {
      if (send(this.latest)) this.sentSignature = signature;
    }
    return undefined;
  }

  private expired(now: number): boolean {
    return (
      this.transitions.length > 0 &&
      now - this.transitions[0].at > this.maxAgeMs
    );
  }
}
