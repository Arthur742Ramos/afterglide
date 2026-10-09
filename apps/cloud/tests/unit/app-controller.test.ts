import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type {
  CloudTitle,
  DeviceCode,
  StreamTelemetry,
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
    throw new Error(
      "Console discovery must never be used by cloud-only client",
    );
  }
  async listCloudTitles(
    _onProgress?: (titles: CloudTitle[]) => void,
  ): Promise<CloudTitle[]> {
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
  async searchCloudTitles(_query: string): Promise<CloudTitle[]> {
    return this.listCloudTitles();
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
  it("adds an unloaded search match for launch and discards results after sign-out", async () => {
    const platform = new FakePlatform();
    const controller = makeController(platform);
    await controller.initialize();
    const late = {
      ...controller.getSnapshot().cloud.titles[0],
      id: "late",
      name: "Late game",
    };
    vi.spyOn(platform, "searchCloudTitles").mockResolvedValue([late]);
    expect(await controller.searchCloudTitles("late")).toEqual([late]);
    await controller.startCloudStream(late.id);
    expect(platform.startedTarget?.id).toBe("late");
    let finish!: (titles: CloudTitle[]) => void;
    vi.spyOn(platform, "searchCloudTitles").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const searching = controller.searchCloudTitles("late");
    await controller.signOut();
    finish([late]);
    expect(await searching).toEqual([]);
    expect(controller.getSnapshot().cloud.titles).toEqual([]);
    await expect(controller.searchCloudTitles("x".repeat(129))).rejects.toThrow(
      "128",
    );
  });

  it("makes partial catalog games playable and ignores late progress after sign-out", async () => {
    const platform = new FakePlatform();
    const controller = makeController(platform);
    await controller.initialize();
    const titles = controller.getSnapshot().cloud.titles;
    let publish!: (titles: CloudTitle[]) => void;
    let finish!: (titles: CloudTitle[]) => void;
    vi.spyOn(platform, "listCloudTitles").mockImplementation((onProgress) => {
      publish = onProgress!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const refreshing = controller.refreshCloudTitles();
    publish(titles);
    expect(controller.getSnapshot().cloud).toMatchObject({
      status: "ready",
      hydrating: true,
      titles,
    });
    await controller.startCloudStream(titles[0].id);
    expect(platform.startedTarget?.id).toBe(titles[0].id);
    await controller.signOut();
    publish(titles);
    finish(titles);
    await refreshing;
    expect(controller.getSnapshot().cloud.titles).toEqual([]);
    expect(controller.getSnapshot().cloud.hydrating).toBeUndefined();
  });

  it("cleans up a provisioned session if Xbox reports failure", async () => {
    const platform = new FakePlatform();
    platform.states = [
      { state: "Failed", errorDetails: { message: "Service unavailable" } },
    ];
    const stop = vi.spyOn(platform, "stopSession");
    const controller = makeController(platform);
    await controller.initialize();
    await expect(
      controller.startCloudStream("cloud-game"),
    ).rejects.toBeDefined();
    expect(stop).toHaveBeenCalledWith("v5/sessions/cloud/session");
    expect(controller.getSnapshot().session.phase).toBe("error");
  });

  it("does not restore a catalog after sign-out while refresh is pending", async () => {
    const platform = new FakePlatform();
    const controller = makeController(platform);
    await controller.initialize();
    let finish!: (titles: CloudTitle[]) => void;
    vi.spyOn(platform, "listCloudTitles").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refreshing = controller.refreshCloudTitles();
    await controller.signOut();
    finish([
      {
        id: "late",
        productId: "late",
        name: "Late",
        publisher: "Xbox",
        supportedInputTypes: [],
        recentlyPlayed: false,
      },
    ]);
    await refreshing;
    expect(controller.getSnapshot().auth.status).toBe("signed-out");
    expect(controller.getSnapshot().cloud.titles).toEqual([]);
  });

  it("rejects a second launch without changing active telemetry or selection", async () => {
    const controller = makeController(new FakePlatform());
    await controller.initialize();
    await controller.startCloudStream("cloud-game");
    controller.updateTelemetry({ ...emptyTelemetry, framesPerSecond: 60 });
    const before = controller.getSnapshot();
    await expect(controller.startCloudStream("cloud-game")).rejects.toThrow(
      "Leave the current stream",
    );
    expect(controller.getSnapshot()).toEqual(before);
  });

  it("restores cloud library, authorizes and reaches a simulated media handoff", async () => {
    const platform = new FakePlatform();
    const controller = makeController(platform);
    await controller.initialize();
    expect(controller.getSnapshot().cloud.selectedTitleId).toBe("cloud-game");
    const descriptor = await controller.startCloudStream("cloud-game");
    expect(descriptor).toEqual({
      sessionId: "session",
      source: "cloud",
      targetId: "cloud-game",
      displayName: "Cloud Game",
      titleId: "cloud-game",
      mock: true,
    });
    expect(platform.wakeCount).toBe(0);
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
    await expect(controller.startCloudStream("cloud-game")).rejects.toThrow(
      "console is busy",
    );
    expect(controller.getSnapshot().session).toMatchObject({
      phase: "error",
      errorCode: "UNAVAILABLE",
      recoverable: true,
    });
  });

  it("keeps a late device-code failure from replacing a cancelled sign-in", async () => {
    const platform = new FakePlatform();
    let rejectStart!: (error: Error) => void;
    vi.spyOn(platform, "beginDeviceCode").mockImplementation(
      () =>
        new Promise<DeviceCode>((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    const controller = makeController(platform);
    const starting = controller.beginSignIn();

    expect(controller.getSnapshot().auth.status).toBe("waiting");
    await controller.cancelSignIn();
    rejectStart(new Error("The device-code service failed late."));
    await starting;

    expect(controller.getSnapshot().auth).toEqual({ status: "signed-out" });
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

  it("retains telemetry without rebroadcasting the full snapshot", () => {
    const controller = makeController(new FakePlatform());
    const send = vi.fn();
    controller.attachWindow({
      isDestroyed: () => false,
      webContents: { send },
    } as unknown as BrowserWindow);

    controller.updateTelemetry({
      ...emptyTelemetry,
      framesPerSecond: 60,
      updatedAt: 1,
    });

    expect(controller.getSnapshot().telemetry.framesPerSecond).toBe(60);
    expect(send).not.toHaveBeenCalled();
    controller.updateSettings({ muted: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("deduplicates wake interruptions and rejects a late connected event", async () => {
    const controller = makeController(new FakePlatform());
    await controller.initialize();
    controller.handleSystemResume();
    expect(controller.getSnapshot().session.phase).toBe("idle");
    await controller.startCloudStream("cloud-game");
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
    await controller.startCloudStream("cloud-game");
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
    const starting = controller.startCloudStream("cloud-game");
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
    await controller.startCloudStream("cloud-game");
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

  it("retains the latest stream measurements for Health after stopping", async () => {
    const controller = makeController(new FakePlatform());
    await controller.initialize();
    await controller.startCloudStream("cloud-game");
    await controller.reportStreamEvent("session", "connected");
    controller.updateTelemetry({
      ...emptyTelemetry,
      roundTripMs: 23,
      jitterBufferMs: 8.4,
      inputQueueBytes: 0,
    });

    await controller.stopStream();

    expect(controller.getSnapshot().session.phase).toBe("idle");
    expect(controller.getSnapshot().telemetry).toMatchObject({
      roundTripMs: 23,
      jitterBufferMs: 8.4,
      inputQueueBytes: 0,
    });

    await controller.startCloudStream("cloud-game");
    expect(controller.getSnapshot().telemetry).toMatchObject(emptyTelemetry);
  });

  it("does not attribute a cached device reading to a new polling configuration", async () => {
    const controller = makeController(new FakePlatform());
    await controller.initialize();
    await controller.startCloudStream("cloud-game");
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
