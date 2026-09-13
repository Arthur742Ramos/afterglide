import type { CloudTitle, DeviceCode, XboxConsole } from "../shared/contracts";
import { AfterglideError } from "./errors";
import type {
  PlatformService,
  SessionStart,
  SessionStateResult,
  StreamTarget,
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

const cloudTitles: CloudTitle[] = [
  {
    id: "STARFIELD",
    productId: "9NCJSXWZTP88",
    name: "Starfield",
    publisher: "Bethesda Softworks",
    supportedInputTypes: ["Controller"],
    recentlyPlayed: true,
  },
  {
    id: "FORZA-HORIZON-5",
    productId: "9NNX1VVR3KNQ",
    name: "Forza Horizon 5",
    publisher: "Xbox Game Studios",
    supportedInputTypes: ["Controller"],
    recentlyPlayed: false,
  },
  {
    id: "SEA-OF-THIEVES",
    productId: "9P2N57MC619K",
    name: "Sea of Thieves",
    publisher: "Xbox Game Studios",
    supportedInputTypes: ["Controller", "MouseAndKeyboard"],
    recentlyPlayed: false,
  },
];

export class MockPlatformService implements PlatformService {
  readonly mock = true;
  private signedIn: boolean;
  private cancelled = false;
  private statusChecks = 0;
  private firstConnection = true;
  private firstConsoleDiscovery = true;
  private firstCloudDiscovery = true;
  private readonly scenario = process.env.AFTERGLIDE_E2E_SCENARIO ?? "happy";

  constructor(initiallySignedIn: boolean) {
    this.signedIn = initiallySignedIn;
  }

  get hasStoredAuthentication(): boolean {
    return this.signedIn;
  }

  get cloudAvailable(): boolean {
    return this.signedIn && this.scenario !== "cloud-unavailable";
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
    if (this.scenario === "auth-denied")
      throw new AfterglideError(
        "AUTH_DENIED",
        "Microsoft sign-in was declined. Start again when you’re ready.",
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
    if (this.scenario === "console-error-once" && this.firstConsoleDiscovery) {
      this.firstConsoleDiscovery = false;
      throw new AfterglideError(
        "CONSOLE_DISCOVERY_FAILED",
        "Xbox console discovery is temporarily unavailable.",
      );
    }
    const result = structuredClone(consoles);
    if (this.scenario === "remote-play-disabled") {
      const selected = result.find((console) => console.power === "on");
      if (selected) selected.remotePlayEnabled = false;
    }
    if (this.scenario === "long-content") {
      const selected = result.find((console) => console.power === "on");
      if (selected)
        selected.name =
          "Upstairs Family Room Xbox Series S With A Very Long Console Name";
    }
    return result;
  }

  async listCloudTitles(): Promise<CloudTitle[]> {
    await delay(160);
    if (!this.cloudAvailable)
      throw new AfterglideError(
        "XCLOUD_UNAVAILABLE",
        "Cloud gaming is not available for this account or region.",
        false,
      );
    if (this.scenario === "cloud-error-once" && this.firstCloudDiscovery) {
      this.firstCloudDiscovery = false;
      throw new AfterglideError(
        "CLOUD_CATALOG_FAILED",
        "The cloud catalog is temporarily unavailable.",
      );
    }
    if (this.scenario === "cloud-empty") return [];
    const result = structuredClone(cloudTitles);
    if (this.scenario === "cloud-artwork" && result[0])
      result[0].imageUrl = "https://images.xboxlive.com/e2e-cover.svg";
    if (this.scenario === "long-content" && result[0]) {
      result[0].name =
        "Microsoft Flight Simulator 2024 Premium Deluxe World Edition";
      result[0].publisher =
        "Xbox Game Studios and Partner Publishing International";
    }
    return result;
  }

  async wakeConsole(): Promise<void> {
    await delay(240);
  }

  async startSession(target: StreamTarget): Promise<SessionStart> {
    await delay(220);
    const shouldFail =
      this.scenario === "connect-error" ||
      (this.scenario === "cloud-connect-error" && target.source === "cloud");
    if (shouldFail && this.firstConnection) {
      this.firstConnection = false;
      throw new AfterglideError(
        "CONSOLE_UNAVAILABLE",
        "Your Xbox did not answer. Check that remote play is enabled and try again.",
      );
    }
    this.statusChecks = 0;
    return {
      sessionId: "e2e-session-01",
      sessionPath: `v5/sessions/${target.source}/e2e-session-01`,
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
