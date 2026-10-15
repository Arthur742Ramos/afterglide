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
import { syncDisplaySleepBlocker } from "../../src/main/desktop-policy";

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

function makeController(
  platform: FakePlatform,
  onPhase?: ConstructorParameters<typeof AppController>[5],
) {
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
    undefined,
    onPhase,
  );
}

describe("AppController", () => {
  it("retains main-process region selection in Health and reports before video arrives", async () => {
    const platform = new FakePlatform();
    const selection = {
      requestedRegion: "Fast",
      xboxDefaultRegion: "Default",
      method: "lowest-probe-latency" as const,
      reason: "measured" as const,
      measuredAt: 123,
      scanComplete: true,
      medianProbeMs: 20,
      candidates: [],
    };
    const started = {
      sessionId: "session",
      sessionPath: "v5/sessions/cloud/session",
      regionSelection: selection,
    };
    vi.spyOn(platform, "startSession").mockResolvedValue(started);
    const controller = makeController(platform);
    await controller.initialize();
    await controller.startCloudStream("cloud-game");
    expect(controller.getSnapshot().regionSelection).toEqual(selection);
    expect(controller.exportPerformanceReport().regionSelections).toEqual([
      selection,
    ]);
    selection.requestedRegion = "changed";
    expect(
      controller.exportPerformanceReport().regionSelections[0]?.requestedRegion,
    ).toBe("Fast");
    await controller.stopStream();
    expect(controller.exportPerformanceReport().regionSelections).toHaveLength(
      1,
    );
  });

  it("exports selected Smooth mode and sanitized repair evidence without inventing missing values", async () => {
    const controller = makeController(new FakePlatform());
    await controller.initialize();
    await controller.updateSettings({ playbackMode: "smooth" });
    await controller.startCloudStream("cloud-game");
    await controller.reportStreamEvent("session", "connected");
    controller.updateTelemetry({
      ...emptyTelemetry,
      retransmittedPacketsReceived: 0,
      retransmittedPacketsPerSecond: 12,
      nackCount: -1,
      pliCount: Number.NaN,
      playoutMode: "smooth",
      playoutTargetMs: 67,
      playoutTargetAccepted: false,
    });
    const report = controller.exportPerformanceReport();
    expect(report.samples[0].settings.playbackMode).toBe("smooth");
    expect(report.samples[0].telemetry).toMatchObject({
      retransmittedPacketsReceived: 0,
      retransmittedPacketsPerSecond: 12,
      nackCount: undefined,
      pliCount: undefined,
      playoutMode: "smooth",
      playoutTargetMs: 67,
      playoutTargetAccepted: false,
    });
  });
  it("retains typed cadence and false decoder evidence, takes power only from main and rejects malformed cadence", async () => {
    const controller = makeController(new FakePlatform());
    await controller.initialize();
    await controller.startCloudStream("cloud-game");
    await controller.reportStreamEvent("session", "connected");
    controller.updatePowerContext({
      onBattery: false,
      powerObservedAt: 123,
      speedLimitPercent: 0,
      speedLimitObservedAt: 124,
    });
    const inputPolling = {
      targetMs: 4 as const,
      samples: 250,
      windowMs: 1000,
      meanIntervalMs: 4,
      p95UpperMs: 4,
      maxIntervalMs: 4,
      meanJitterMs: 0,
      longGaps: 0,
    };
    controller.updateTelemetry({
      ...emptyTelemetry,
      inputPolling: {
        ...inputPolling,
        rawButtons: "private",
      } as typeof inputPolling,
      powerEfficientDecoder: false,
      frameTiming: {
        observedFrames: 30,
        decodeP95Ms: 0,
        presentationLeadP95Ms: -10,
        receiveIntervalP95Ms: Number.NaN,
        callbackLatenessP95Ms: -1,
        privateField: "not retained",
      } as NonNullable<typeof emptyTelemetry.frameTiming>,
      powerContext: { onBattery: true },
    });
    const first = controller.exportPerformanceReport();
    expect(first.samples[0].telemetry).toMatchObject({
      inputPolling,
      powerEfficientDecoder: false,
      powerContext: { onBattery: false, speedLimitPercent: 0 },
    });
    expect(JSON.stringify(first)).not.toContain("rawButtons");
    expect(first.samples[0].telemetry.frameTiming).toMatchObject({
      observedFrames: 30,
      decodeP95Ms: 0,
      presentationLeadP95Ms: -10,
      receiveIntervalP95Ms: undefined,
      callbackLatenessP95Ms: undefined,
    });
    expect(JSON.stringify(first)).not.toContain("privateField");
    expect(first.summaries[0].inputPollMeanJitterMs?.median).toBe(0);
    controller.updateTelemetry({
      ...emptyTelemetry,
      inputPolling: { ...inputPolling, samples: 0 },
      powerEfficientDecoder: "false" as unknown as boolean,
    });
    const second = controller.exportPerformanceReport();
    expect(second.samples[1].telemetry.inputPolling).toBeUndefined();
    expect(second.samples[1].telemetry.powerEfficientDecoder).toBeUndefined();
    expect(second.summaries[0].inputPollMeanIntervalMs?.count).toBe(1);
    controller.updatePowerContext({});
    controller.updateTelemetry({ ...emptyTelemetry });
    expect(controller.getSnapshot().powerContext).toEqual({});
    expect(
      controller.exportPerformanceReport().samples[2].telemetry.powerContext,
    ).toEqual({});
    await controller.stopStream();
  });

  it.each(["cancel", "failure"] as const)(
    "holds display-sleep protection before creation settles, then releases on %s",
    async (outcome) => {
      const platform = new FakePlatform();
      const active = new Set<number>();
      const blocker = {
        start: vi.fn(() => {
          active.add(1);
          return 1;
        }),
        stop: vi.fn((id: number) => {
          active.delete(id);
        }),
        isStarted: (id: number) => active.has(id),
      };
      let id: number | undefined;
      const phases: string[] = [];
      const controller = makeController(platform, (phase) => {
        phases.push(phase);
        expect(controller.getSessionPhase()).toBe(phase);
        id = syncDisplaySleepBlocker(phase, id, blocker);
      });
      await controller.initialize();
      let resolve!: (value: { sessionId: string; sessionPath: string }) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<{ sessionId: string; sessionPath: string }>(
        (yes, no) => {
          resolve = yes;
          reject = no;
        },
      );
      vi.spyOn(platform, "startSession").mockImplementation(() => {
        expect(active.has(1)).toBe(true);
        return pending;
      });
      const stop = vi.spyOn(platform, "stopSession");
      const starting = controller.startCloudStream("cloud-game");
      const rejected = expect(starting).rejects.toThrow();
      expect(phases).toEqual(["provisioning"]);
      expect(blocker.start).toHaveBeenCalledTimes(1);
      if (outcome === "cancel") {
        await controller.stopStream();
        expect(active.size).toBe(0);
        resolve({ sessionId: "late", sessionPath: "late-path" });
      } else reject(new Error("Synthetic creation failure"));
      await rejected;
      expect(active.size).toBe(0);
      expect(phases.at(-1)).toBe(outcome === "cancel" ? "idle" : "error");
      expect(blocker.stop).toHaveBeenCalledTimes(1);
      expect(blocker.start).toHaveBeenCalledTimes(1);
      if (outcome === "cancel")
        await vi.waitFor(() =>
          expect(stop).toHaveBeenCalledWith("late-path", "late"),
        );
    },
  );

  it("holds one blocker through provisioning, authorization, negotiation and recovery", async () => {
    const platform = new FakePlatform();
    const active = new Set<number>();
    const blocker = {
      start: vi.fn(() => {
        active.add(1);
        return 1;
      }),
      stop: vi.fn((id: number) => {
        active.delete(id);
      }),
      isStarted: (id: number) => active.has(id),
    };
    let id: number | undefined;
    const phases: string[] = [];
    const controller = makeController(platform, (phase) => {
      phases.push(phase);
      id = syncDisplaySleepBlocker(phase, id, blocker);
    });
    await controller.initialize();
    vi.spyOn(platform, "authorizeSession").mockImplementation(async () => {
      expect(controller.getSessionPhase()).toBe("authorizing");
      expect(active.has(1)).toBe(true);
    });
    await controller.startCloudStream("cloud-game");
    expect(active.has(1)).toBe(true);
    await controller.reportStreamEvent("session", "connected");
    await controller.reportStreamEvent("session", "interrupted");
    expect(active.has(1)).toBe(true);
    expect(phases).toEqual([
      "provisioning",
      "authorizing",
      "negotiating",
      "streaming",
      "recovering",
    ]);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    await controller.stopStream();
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(0);
  });

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
    expect(stop).toHaveBeenCalledWith("v5/sessions/cloud/session", "session");
    expect(stop).toHaveBeenCalledTimes(1);
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
      incomingFramesPerSecond: -1,
      decodedFramesPerSecond: Number.NaN,
      displayedFramesPerSecond: 30,
      displayedFpsSource: "spoofed",
      playbackVisible: "yes",
      playbackFocused: false,
      roundTripMs: Number.POSITIVE_INFINITY,
      packetLossPercent: 180,
      bitrateMbps: -4,
      codec: "codec".repeat(20),
      connection: "spoofed",
      videoDecoder: "decoder".repeat(20),
      jitterMs: Number.NaN,
      playoutMode: "invalid",
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
      framesPerSecond: undefined,
      incomingFramesPerSecond: undefined,
      decodedFramesPerSecond: undefined,
      displayedFramesPerSecond: 30,
      displayedFpsSource: undefined,
      playbackVisible: undefined,
      playbackFocused: false,
      roundTripMs: undefined,
      packetLossPercent: 100,
      bitrateMbps: undefined,
      codec: "codec".repeat(9) + "cod",
      connection: "unknown",
      videoDecoder: "decoder".repeat(11) + "dec",
      jitterMs: undefined,
      playoutMode: undefined,
      networkQuality: "measuring",
      frameIntervalP95Ms: undefined,
      frameIntervalP99Ms: undefined,
      framesDropped: 12,
      freezeCount: undefined,
      freezeDurationMs: 1200,
      recoveryMs: undefined,
    });
  });

  it("keeps missing and invalid telemetry unknown through snapshots and exports", async () => {
    const controller = makeController(new FakePlatform());
    await controller.initialize();
    await controller.startCloudStream("cloud-game");
    await controller.reportStreamEvent("session", "connected");
    controller.updateTelemetry({
      ...emptyTelemetry,
      framesPerSecond: undefined,
      roundTripMs: Number.NaN,
      packetLossPercent: undefined,
      bitrateMbps: undefined,
      codec: undefined,
      videoDecoder: undefined,
      networkQuality: "excellent",
    } as unknown as StreamTelemetry);
    expect(controller.getSnapshot().telemetry).toMatchObject({
      framesPerSecond: undefined,
      roundTripMs: undefined,
      packetLossPercent: undefined,
      bitrateMbps: undefined,
      codec: undefined,
      videoDecoder: undefined,
      networkQuality: "measuring",
    });
    const report = controller.exportPerformanceReport();
    expect(report.samples[0].telemetry.roundTripMs).toBeUndefined();
    expect(report.summaries[0].packetLossPercent).toBeUndefined();

    controller.updateTelemetry({
      ...emptyTelemetry,
      framesPerSecond: 60,
      roundTripMs: 0,
      packetLossPercent: 0,
      bitrateMbps: 0,
      networkQuality: "excellent",
    });
    expect(controller.getSnapshot().telemetry).toMatchObject({
      roundTripMs: 0,
      packetLossPercent: 0,
      bitrateMbps: 0,
      networkQuality: "excellent",
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
    const rejected = expect(starting).rejects.toMatchObject({
      code: "OPERATION_CANCELLED",
      recoverable: false,
    });
    await startCalled;
    await controller.stopStream();
    finishStart({ sessionId: "late", sessionPath: "late-path" });
    await rejected;
    await vi.waitFor(() =>
      expect(stop).toHaveBeenCalledWith("late-path", "late"),
    );
    expect(stop).toHaveBeenCalledTimes(1);
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
