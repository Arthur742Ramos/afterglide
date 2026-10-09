import { describe, expect, it } from "vitest";
import {
  assessNetworkQuality,
  isTransientHttpStatus,
  retryDelayMs,
} from "../../src/shared/network-policy";

describe("network policy", () => {
  it("retries only transient read failures with bounded backoff", () => {
    expect(isTransientHttpStatus(408)).toBe(true);
    expect(isTransientHttpStatus(429)).toBe(true);
    expect(isTransientHttpStatus(503)).toBe(true);
    expect(isTransientHttpStatus(401)).toBe(false);
    expect(retryDelayMs(0)).toBe(300);
    expect(retryDelayMs(1, "99")).toBe(5_000);
  });

  it("classifies measured stream quality from latency, loss, and frame rate", () => {
    expect(assessNetworkQuality(0, 0, 0)).toBe("measuring");
    expect(assessNetworkQuality(23, 0.1, 60)).toBe("excellent");
    expect(assessNetworkQuality(23, 0.1, 30)).toBe("excellent");
    expect(assessNetworkQuality(70, 1.2, 50)).toBe("good");
    expect(assessNetworkQuality(120, 4, 29)).toBe("unstable");
  });
});
