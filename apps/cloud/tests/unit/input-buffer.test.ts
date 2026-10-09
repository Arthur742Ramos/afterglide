import { describe, expect, it, vi } from "vitest";
import { InputTransitionBuffer } from "../../src/renderer/stream/input-buffer";
import {
  emptyXboxInputFrame,
  type XboxInputFrame,
} from "../../src/renderer/stream/input-schema";

const frame = (values: Partial<XboxInputFrame>) => ({
  ...emptyXboxInputFrame(),
  ...values,
});

describe("bounded input transition buffer", () => {
  it("preserves ordered multi-button transitions while using latest analog only", () => {
    const buffer = new InputTransitionBuffer();
    buffer.observe(frame({ A: 1, LeftThumbXAxis: 0.3 }), 0);
    buffer.observe(frame({ A: 1, B: 1, LeftThumbXAxis: 0.6 }), 4);
    buffer.observe(frame({ B: 1, LeftThumbXAxis: 0.9 }), 8);
    buffer.observe(frame({ LeftThumbXAxis: -1, LeftTrigger: 0.5 }), 12);
    const sent: XboxInputFrame[] = [];
    buffer.flush(16, (value) => {
      sent.push(value);
      return true;
    });
    expect(sent.map(({ A, B }) => [A, B])).toEqual([
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ]);
    expect(sent.every(({ LeftThumbXAxis }) => LeftThumbXAxis === -1)).toBe(
      true,
    );
    expect(sent.map(({ LeftTrigger }) => LeftTrigger)).toEqual([0, 0, 0, 0.5]);
  });
  it("preserves short trigger pulls/releases and coalesces held trigger travel", () => {
    const buffer = new InputTransitionBuffer();
    buffer.observe(frame({ LeftTrigger: 0.2 }), 0);
    buffer.observe(frame({ LeftTrigger: 0.6 }), 4);
    buffer.observe(frame({ LeftTrigger: 0.9, RightTrigger: 0.3 }), 8);
    buffer.observe(frame({ RightTrigger: 0.7 }), 12);
    buffer.observe(frame({}), 16);
    const sent: XboxInputFrame[] = [];
    buffer.flush(20, (value) => {
      sent.push(value);
      return true;
    });
    expect(
      sent.map(({ LeftTrigger, RightTrigger }) => [LeftTrigger, RightTrigger]),
    ).toEqual([
      [0.9, 0],
      [0.9, 0.7],
      [0, 0.7],
      [0, 0],
    ]);
  });
  it("shares trigger and button edge bounds without refreshing age for analog travel", () => {
    const buffer = new InputTransitionBuffer(2, 20);
    expect(buffer.observe(frame({ LeftTrigger: 0.2 }), 0)).toBeUndefined();
    expect(buffer.observe(frame({ LeftTrigger: 0.8 }), 12)).toBeUndefined();
    expect(
      buffer.observe(frame({ A: 1, LeftTrigger: 0.8 }), 16),
    ).toBeUndefined();
    expect(buffer.observe(frame({ A: 1 }), 18)).toBe("overflow");
    expect(buffer.flush(21, () => true)).toBe("expired");
    buffer.clear();
    expect(buffer.observe(frame({}), 100)).toBeUndefined();
    const sent: XboxInputFrame[] = [];
    buffer.flush(100, (value) => {
      sent.push(value);
      return true;
    });
    expect(sent).toEqual([emptyXboxInputFrame()]);
  });
  it("retains unsent edges when draining blocks partway", () => {
    const buffer = new InputTransitionBuffer();
    buffer.observe(frame({ A: 1 }), 0);
    buffer.observe(frame({}), 4);
    const sent: number[] = [];
    buffer.flush(8, (value) => {
      if (sent.length) return false;
      sent.push(value.A);
      return true;
    });
    expect(sent).toEqual([1]);
    buffer.flush(12, (value) => {
      sent.push(value.A);
      return true;
    });
    expect(sent).toEqual([1, 0]);
  });
  it("bounds count and age, including expiry at drain, without mutating transport", () => {
    const buffer = new InputTransitionBuffer(2, 20);
    expect(buffer.observe(frame({ A: 1 }), 0)).toBeUndefined();
    expect(buffer.observe(frame({}), 4)).toBeUndefined();
    expect(buffer.observe(frame({ A: 1 }), 8)).toBe("overflow");
    let calls = 0;
    expect(
      buffer.flush(21, () => {
        calls++;
        return true;
      }),
    ).toBe("expired");
    expect(calls).toBe(0);
    buffer.clear();
    expect(buffer.observe(frame({ B: 1 }), 100)).toBeUndefined();
    expect(buffer.flush(120, () => true)).toBeUndefined();
  });
  it("coalesces purely analog input, suppresses duplicates, and permits heartbeats", () => {
    const buffer = new InputTransitionBuffer();
    for (let i = 0; i < 100; i++)
      buffer.observe(frame({ LeftThumbXAxis: i / 100 }), i);
    const sent: XboxInputFrame[] = [];
    const send = (value: XboxInputFrame) => {
      sent.push(value);
      return true;
    };
    buffer.flush(101, send);
    buffer.flush(102, send);
    expect(sent.map((value) => value.LeftThumbXAxis)).toEqual([0.99]);
    buffer.flush(103, send, true);
    expect(sent).toHaveLength(2);
  });
  it("compares compact frame state without JSON serialization", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const buffer = new InputTransitionBuffer();
    buffer.observe(frame({ A: 1, LeftThumbXAxis: 0.5 }), 0);
    buffer.observe(frame({ A: 0, LeftThumbXAxis: 0.75 }), 4);
    const sent: XboxInputFrame[] = [];
    buffer.flush(8, (value) => {
      sent.push({ ...value });
      return true;
    });
    buffer.flush(12, () => true);
    expect(sent.map(({ A, LeftThumbXAxis }) => [A, LeftThumbXAxis])).toEqual([
      [1, 0.75],
      [0, 0.75],
    ]);
    expect(stringify).not.toHaveBeenCalled();
  });
  it("clearing discards queued transitions and analog history", () => {
    const buffer = new InputTransitionBuffer();
    buffer.observe(frame({ A: 1, LeftThumbXAxis: 1 }), 0);
    buffer.observe(frame({}), 4);
    buffer.clear();
    const sent: XboxInputFrame[] = [];
    buffer.flush(1000, (value) => {
      sent.push(value);
      return true;
    });
    expect(sent).toEqual([emptyXboxInputFrame()]);
  });
});
