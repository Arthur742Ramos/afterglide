import type { CloudTitle, DeviceCode } from "../shared/contracts";
import { AfterglideError } from "./errors";
import type {
  PlatformService,
  SessionStart,
  SessionStateResult,
  StreamTarget,
} from "./platform-service";

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
  private sessionSequence = 0;
  private firstCloudDiscovery = true;
  private readonly scenario =
    process.env.AFTERGLIDE_CLOUD_E2E_SCENARIO ?? "happy";

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
      code: "CLOUD-7G",
      verificationUrl: "https://microsoft.com/link",
      expiresAt: Date.now() + 15 * 60_000,
      message: "Enter this code to sign in to Xbox.",
      ...({ internalDeviceCode: "mock-device-code" } as object),
    } as DeviceCode & { internalDeviceCode: string };
  }

  async pollDeviceCode(): Promise<void> {
    await delay(this.scenario === "auth-wait" ? 6000 : 550);
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
    if (this.scenario === "large-cloud-catalog")
      return Array.from({ length: 80 }, (_, index) => ({
        ...structuredClone(cloudTitles[index % cloudTitles.length]!),
        id: `CLOUD-GAME-${index + 1}`,
        productId: `PRODUCT-${index + 1}`,
        name: `Cloud Game ${String(index + 1).padStart(2, "0")}`,
        recentlyPlayed: index === 0,
      }));
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

  async startSession(target: StreamTarget): Promise<SessionStart> {
    await delay(this.scenario === "slow-cloud-launch" ? 1500 : 220);
    const shouldFail =
      this.scenario === "connect-error" ||
      (this.scenario === "cloud-connect-error" && target.source === "cloud");
    if (shouldFail && this.firstConnection) {
      this.firstConnection = false;
      throw new AfterglideError(
        "CLOUD_UNAVAILABLE",
        "Xbox Cloud Gaming did not answer. Check your network and try again.",
      );
    }
    this.statusChecks = 0;
    const sessionId = `e2e-session-${String(++this.sessionSequence).padStart(2, "0")}`;
    return {
      sessionId,
      sessionPath: `v5/sessions/${target.source}/${sessionId}`,
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
