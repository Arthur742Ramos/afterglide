import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeviceCode, XboxConsole } from "../../src/shared/contracts";
import { AppController } from "../../src/main/app-controller";
import { AfterglideError } from "../../src/main/errors";
import type {
  PlatformService,
  SessionStateResult,
} from "../../src/main/platform-service";
import { SettingsStore } from "../../src/main/settings-store";

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
  states: SessionStateResult[] = [
    { state: "Provisioning" },
    { state: "ReadyToConnect" },
    { state: "Provisioned" },
  ];
  wakeCount = 0;
  authorizeCount = 0;
  failStart = false;
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
  async wakeConsole() {
    this.wakeCount += 1;
  }
  async startSession() {
    if (this.failStart)
      throw new AfterglideError("UNAVAILABLE", "The console is busy.");
    return { sessionId: "session", sessionPath: "v5/sessions/home/session" };
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
      consoleId: "den",
      mock: true,
    });
    expect(platform.wakeCount).toBe(1);
    expect(platform.authorizeCount).toBe(1);
    expect(controller.getSnapshot().session.phase).toBe("negotiating");
    await controller.reportStreamEvent("session", "connected");
    expect(controller.getSnapshot().session.phase).toBe("streaming");
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
});
