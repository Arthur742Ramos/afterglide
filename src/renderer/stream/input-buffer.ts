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
const frameFields: Array<keyof XboxInputFrame> = [
  "GamepadIndex",
  ...buttons,
  "LeftThumbXAxis",
  "LeftThumbYAxis",
  "RightThumbXAxis",
  "RightThumbYAxis",
  ...triggers,
];

export const INPUT_TRANSITION_POLICY = { capacity: 32, maxAgeMs: 250 } as const;
export type InputBufferFailure = "overflow" | "expired";

function copyFrame(target: XboxInputFrame, source: XboxInputFrame): void {
  frameFields.forEach((field) => {
    target[field] = source[field];
  });
}

function framesEqual(left: XboxInputFrame, right: XboxInputFrame): boolean {
  return frameFields.every((field) => left[field] === right[field]);
}

function pressedControls(frame: XboxInputFrame): number {
  let mask = 0;
  controls.forEach((control, index) => {
    if (frame[control] > 0) mask |= 1 << index;
  });
  return mask;
}

/**
 * Preserve button and tuned trigger rest/pressed (>0) edges, not historical
 * analog travel. Queued trigger presses use the latest nonzero magnitude;
 * sticks always use the latest position. Limits apply before sending, including
 * on drain. Exceeding either fails visibly and prioritizes neutral.
 */
export class InputTransitionBuffer {
  private transitions: { controls: number; at: number }[] = [];
  private latest = emptyXboxInputFrame();
  private observed = 0;
  private triggerMagnitudes = [0, 0];
  private sent = emptyXboxInputFrame();
  private hasSent = false;

  constructor(
    private readonly capacity: number = INPUT_TRANSITION_POLICY.capacity,
    private readonly maxAgeMs: number = INPUT_TRANSITION_POLICY.maxAgeMs,
  ) {}

  clear(): void {
    this.transitions = [];
    this.latest = emptyXboxInputFrame();
    this.observed = 0;
    this.triggerMagnitudes = [0, 0];
    this.sent = emptyXboxInputFrame();
    this.hasSent = false;
  }

  observe(frame: XboxInputFrame, now: number): InputBufferFailure | undefined {
    if (this.expired(now)) return "expired";
    copyFrame(this.latest, frame);
    triggers.forEach((trigger, index) => {
      if (frame[trigger] > 0) this.triggerMagnitudes[index] = frame[trigger];
    });
    const next = pressedControls(frame);
    if (next !== this.observed) {
      if (this.transitions.length >= this.capacity) return "overflow";
      this.transitions.push({ controls: next, at: now });
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
        frame[button] = Number(
          Boolean(this.transitions[0].controls & (1 << index)),
        );
      });
      triggers.forEach((trigger, index) => {
        frame[trigger] =
          this.transitions[0].controls & (1 << (buttons.length + index))
            ? this.triggerMagnitudes[index]
            : 0;
      });
      if (!send(frame)) return undefined;
      copyFrame(this.sent, frame);
      this.hasSent = true;
      this.transitions.shift();
      sent = true;
    }
    if (
      !this.hasSent ||
      !framesEqual(this.latest, this.sent) ||
      (heartbeat && !sent)
    ) {
      if (send(this.latest)) {
        copyFrame(this.sent, this.latest);
        this.hasSent = true;
      }
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
