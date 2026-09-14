import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CloudTitle,
  DeviceCode,
  StreamTelemetry,
  XboxConsole,
} from "../../src/shared/contracts";
import { AppController } from "../../src/main/app-controller";
import { AfterglideError } from "../../src/main/errors";
import type {
  PlatformService,
  SessionStateResult,
  StreamTarget,
} from "../../src/main/platform-service";
import { SettingsStore } from "../../src/main/settings-store";
import { emptyTelemetry } from "../../src/shared/contracts";

let directory = "";
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const consoleFixture: XboxConsole = {
  id: "den",
  name: "Den Xbox",
  model: "Xbox Series X",
  power: "standby",
  remotePlayEnabled: true,
  remoteManagementEnabled: true,
  wirelessWarning: false,
  outOfHomeWarning: false,
};

class FakePlatform implements PlatformService {
  readonly mock = true;
  readonly hasStoredAuthentication = true;
  readonly cloudAvailable = true;
  states: SessionStateResult[] = [
    { state: "Provisioning" },
    { state: "ReadyToConnect" },
    { state: "Provisioned" },
  ];
  wakeCount = 0;
  authorizeCount = 0;
  failStart = false;
  startedTarget?: StreamTarget;
  async restore() {
    return true;
  }
  async beginDeviceCode() {
    return {
      code: "CODE",
      verificationUrl: "https://microsoft.com/link",
      expiresAt: Date.now() + 1000,
      message: "",
      internalDeviceCode: "internal",
    } as DeviceCode;
  }
  async pollDeviceCode() {}
  cancelAuthentication() {}
  async signOut() {}
  async listConsoles() {
    return [consoleFixture];
  }
  async listCloudTitles(): Promise<CloudTitle[]> {
    return [
      {
        id: "cloud-game",
        productId: "product",
        name: "Cloud Game",
        publisher: "Xbox",
        supportedInputTypes: ["Controller"],
        recentlyPlayed: true,
      },
    ];
  }
  async wakeConsole() {
    this.wakeCount += 1;
  }
  async startSession(target: StreamTarget) {
    this.startedTarget = target;
    if (this.failStart)
      throw new AfterglideError("UNAVAILABLE", "The console is busy.");
    return {
      sessionId: "session",
      sessionPath: `v5/sessions/${target.source}/session`,
    };
  }
  async getSessionState() {
    return this.states.shift() ?? { state: "Provisioned" };
  }
  async authorizeSession() {
    this.authorizeCount += 1;
  }
  async exchangeSdp() {
    return JSON.stringify({ sdp: "answer" });
  }
  async exchangeIce() {
    return "[]";
  }
  async keepalive() {}
  async stopSession() {}
}

function makeController(platform: FakePlatform) {
  directory = mkdtempSync(join(tmpdir(), "afterglide-controller-"));
  return new AppController(
    platform,
    new SettingsStore(join(directory, "preferences.json")),
    {
      acceleration: "enabled",
      videoDecode: "enabled",
      gpu: "test",
      secureStorage: true,
      credentialStorage: {
        backend: "Test keyring",
        detail: "Test credentials persist securely.",
      },
    },
    "test",
  );
}

describe("AppController", () => {
  it("restores, discovers, wakes, authorizes, and reaches a real media handoff", async () => {
    const platform = new FakePlatform();
    const controller = makeController(platform);
    await controller.initialize();
    expect(controller.getSnapshot().selectedConsoleId).toBe("den");
    const descriptor = await controller.startStream("den");
    expect(descriptor).toEqual({
      sessionId: "session",
      source: "home",
      targetId: "den",
      displayName: "Den Xbox",
      consoleId: "den",
      mock: true,
    });
    expect(platform.wakeCount).toBe(1);
    expect(platform.authorizeCount).toBe(1);
    expect(controller.getSnapshot().session.phase).toBe("negotiating");
    await controller.reportStreamEvent("session", "connected");
    expect(controller.getSnapshot().session.phase).toBe("streaming");
    await controller.stopStream();
    await expect(
      controller.reportStreamEvent("session", "interrupted"),
    ).resolves.toBeUndefined();
    expect(controller.getSnapshot().session.phase).toBe("idle");
  });

  it("discovers and launches a cloud title without waking a console", async () => {
    const platform = new FakePlatform();
    const controller = makeController(platform);
    await controller.initialize();
    expect(controller.getSnapshot().cloud).toMatchObject({
      available: true,
      status: "ready",
      selectedTitleId: "cloud-game",
    });
    const descriptor = await controller.startCloudStream("cloud-game");
    expect(platform.startedTarget).toEqual({
      source: "cloud",
      id: "cloud-game",
      name: "Cloud Game",
    });
    expect(platform.wakeCount).toBe(0);
    expect(descriptor).toMatchObject({
      source: "cloud",
      titleId: "cloud-game",
      displayName: "Cloud Game",
    });
  });

  it("publishes a recoverable, user-facing failure", async () => {
    const platform = new FakePlatform();
    platform.failStart = true;
    const controller = makeController(platform);
    await controller.initialize();
    await expect(controller.startStream("den")).rejects.toThrow(
      "console is busy",
    );
    expect(controller.getSnapshot().session).toMatchObject({
      phase: "error",
      errorCode: "UNAVAILABLE",
      recoverable: true,
    });
  });

  it("bounds numeric telemetry and rejects unknown status values", () => {
    const controller = makeController(new FakePlatform());
    controller.updateTelemetry({
      resolution: "x".repeat(80),
      framesPerSecond: Number.NaN,
      roundTripMs: Number.POSITIVE_INFINITY,
      packetLossPercent: 180,
      bitrateMbps: -4,
      codec: "codec".repeat(20),
      connection: "spoofed",
      videoDecoder: "decoder".repeat(20),
      networkQuality: "perfect",
      frameIntervalP95Ms: Number.NaN,
      frameIntervalP99Ms: -4,
      framesDropped: 12,
      freezeCount: Number.POSITIVE_INFINITY,
      freezeDurationMs: 1200,
      recoveryMs: 999,
      updatedAt: 1,
    } as unknown as StreamTelemetry);

    expect(controller.getSnapshot().telemetry).toMatchObject({
      resolution: "x".repeat(32),
      framesPerSecond: 0,
      roundTripMs: 0,
      packetLossPercent: 100,
      bitrateMbps: 0,
      codec: "codec".repeat(9) + "cod",
      connection: "unknown",
      videoDecoder: "decoder".repeat(11) + "dec",
      networkQuality: "measuring",
      frameIntervalP95Ms: undefined,
      frameIntervalP99Ms: undefined,
      framesDropped: 12,
      freezeCount: undefined,
      freezeDurationMs: 1200,
      recoveryMs: undefined,
    });
  });

  it("deduplicates wake interruptions and rejects a late connected event", async () => {
    const controller = makeController(new FakePlatform());
    await controller.initialize();
    controller.handleSystemResume();
    expect(controller.getSnapshot().session.phase).toBe("idle");
    await controller.startStream("den");
    controller.handleSystemResume();
    expect(controller.getSnapshot().session.phase).toBe("negotiating");
    await controller.reportStreamEvent("session", "connected");
    controller.handleSystemResume();
    const recovery = controller.getSnapshot().session;
    expect(recovery.phase).toBe("recovering");
    controller.handleSystemResume();
    await controller.reportStreamEvent("session", "connected");
    expect(controller.getSnapshot().session).toEqual(recovery);
    await controller.retryStream();
    await controller.reportStreamEvent("session", "connected");
    controller.updateTelemetry({ ...emptyTelemetry });
    expect(
      controller.getSnapshot().telemetry.recoveryMs,
    ).toBeGreaterThanOrEqual(0);
    expect(controller.exportPerformanceReport().recoveries).toHaveLength(1);
    await controller.stopStream();
    controller.handleSystemResume();
    expect(controller.getSnapshot().session.phase).toBe("idle");
  });

  it("does not restart if the user leaves while recovery is stopping the old session", async () => {
    const platform = new FakePlatform();
    const controller = makeController(platform);
    await controller.initialize();
    await controller.startStream("den");
    let finishStop!: () => void;
    vi.spyOn(platform, "stopSession").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const start = vi.spyOn(platform, "startSession");
    const retry = controller.retryStream();
    const rejected = expect(retry).rejects.toThrow("Connection cancelled");
    await controller.stopStream();
    finishStop();
    await rejected;
    expect(start).not.toHaveBeenCalled();
    expect(controller.getSnapshot().session.phase).toBe("idle");
  });

  it("cleans up a service session that finishes provisioning after cancellation", async () => {
    const platform = new FakePlatform();
    const controller = makeController(platform);
    await controller.initialize();
    let finishStart!: (value: {
      sessionId: string;
      sessionPath: string;
    }) => void;
    const startCalled = new Promise<void>((resolveCalled) => {
      vi.spyOn(platform, "startSession").mockImplementation(
        () =>
          new Promise((resolve) => {
            finishStart = resolve;
            resolveCalled();
          }),
      );
    });
    const stop = vi.spyOn(platform, "stopSession");
    const starting = controller.startStream("den");
    const rejected = expect(starting).rejects.toThrow("Connection cancelled");
    await startCalled;
    await controller.stopStream();
    finishStart({ sessionId: "late", sessionPath: "late-path" });
    await rejected;
    expect(stop).toHaveBeenCalledWith("late-path");
    expect(controller.getSnapshot().session.phase).toBe("idle");
  });

  it("exports only sanitized active telemetry and preserves evidence after exit", async () => {
    const controller = makeController(new FakePlatform());
    await controller.initialize();
    controller.updateTelemetry({ ...emptyTelemetry });
    expect(controller.exportPerformanceReport().retainedSamples).toBe(0);
    await controller.startStream("den");
    await controller.reportStreamEvent("session", "connected");
    controller.updateTelemetry({ ...emptyTelemetry, framesDropped: 2 });
    await controller.stopStream();
    controller.updateTelemetry({ ...emptyTelemetry, framesDropped: 1234 });
    const report = controller.exportPerformanceReport();
    expect(report.retainedSamples).toBe(1);
    expect(report.samples[0].telemetry.framesDropped).toBe(2);
    expect(JSON.stringify(report)).not.toContain("Den Xbox");
    expect(JSON.stringify(report)).not.toContain("sessionPath");
  });

  it("does not attribute a cached device reading to a new polling configuration", async () => {
    const controller = makeController(new FakePlatform());
    await controller.initialize();
    await controller.startStream("den");
    await controller.reportStreamEvent("session", "connected");
    controller.updateDeviceMetrics({
      observedAt: 100,
      batteryWatts: 10,
      unavailable: [],
    });
    controller.updateTelemetry({ ...emptyTelemetry });
    controller.updateSettings({ inputPolling: "efficient" });
    controller.updateTelemetry({ ...emptyTelemetry });
    const samples = controller.exportPerformanceReport().samples;
    expect(samples[0].device?.batteryWatts).toBe(10);
    expect(samples[1].device).toBeUndefined();
    expect(samples[1].settings.inputPolling).toBe("efficient");
  });
});
