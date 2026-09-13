import type { DeviceCode, XboxConsole } from "../shared/contracts";
import { AfterglideError } from "./errors";
import type {
  PlatformService,
  SessionStart,
  SessionStateResult,
} from "./platform-service";

const consoles: XboxConsole[] = [
  {
    id: "den-series-x",
    name: "Den Series X",
    model: "Xbox Series X",
    power: "standby",
    remotePlayEnabled: true,
    remoteManagementEnabled: true,
    wirelessWarning: false,
    outOfHomeWarning: false,
  },
  {
    id: "studio-series-s",
    name: "Studio Series S",
    model: "Xbox Series S",
    power: "on",
    remotePlayEnabled: true,
    remoteManagementEnabled: true,
    wirelessWarning: true,
    outOfHomeWarning: false,
  },
];

export class MockPlatformService implements PlatformService {
  readonly mock = true;
  private signedIn: boolean;
  private cancelled = false;
  private statusChecks = 0;
  private firstConnection = true;
  private readonly scenario = process.env.AFTERGLIDE_E2E_SCENARIO ?? "happy";

  constructor(initiallySignedIn: boolean) {
    this.signedIn = initiallySignedIn;
  }

  get hasStoredAuthentication(): boolean {
    return this.signedIn;
  }

  async restore(): Promise<boolean> {
    await delay(80);
    return this.signedIn;
  }

  async beginDeviceCode(): Promise<DeviceCode> {
    this.cancelled = false;
    await delay(80);
    return {
      code: "DECK-7G",
      verificationUrl: "https://microsoft.com/link",
      expiresAt: Date.now() + 15 * 60_000,
      message: "Enter this code to sign in to Xbox.",
      ...({ internalDeviceCode: "mock-device-code" } as object),
    } as DeviceCode & { internalDeviceCode: string };
  }

  async pollDeviceCode(): Promise<void> {
    await delay(550);
    if (this.cancelled)
      throw new AfterglideError(
        "AUTH_CANCELLED",
        "Sign-in was cancelled.",
        false,
      );
    this.signedIn = true;
  }

  cancelAuthentication(): void {
    this.cancelled = true;
  }

  async signOut(): Promise<void> {
    this.signedIn = false;
  }

  async listConsoles(): Promise<XboxConsole[]> {
    await delay(180);
    if (this.scenario === "empty") return [];
    return structuredClone(consoles);
  }

  async wakeConsole(): Promise<void> {
    await delay(240);
  }

  async startSession(): Promise<SessionStart> {
    await delay(220);
    if (this.scenario === "connect-error" && this.firstConnection) {
      this.firstConnection = false;
      throw new AfterglideError(
        "CONSOLE_UNAVAILABLE",
        "Your Xbox did not answer. Check that remote play is enabled and try again.",
      );
    }
    this.statusChecks = 0;
    return {
      sessionId: "e2e-session-01",
      sessionPath: "v5/sessions/home/e2e-session-01",
    };
  }

  async getSessionState(): Promise<SessionStateResult> {
    await delay(120);
    this.statusChecks += 1;
    if (this.statusChecks === 1) return { state: "Provisioning" };
    if (this.statusChecks === 2) return { state: "ReadyToConnect" };
    return { state: "Provisioned" };
  }

  async authorizeSession(): Promise<void> {
    await delay(140);
  }

  async exchangeSdp(): Promise<string> {
    return JSON.stringify({ type: "answer", sdp: "" });
  }

  async exchangeIce(): Promise<string> {
    return "[]";
  }

  async keepalive(): Promise<void> {}

  async stopSession(): Promise<void> {}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
