import { Msal } from "xal-node";
import XboxWebApi from "xbox-webapi";
import type {
  DeviceCode,
  IceCandidatePayload,
  XboxConsole,
} from "../shared/contracts";
import { AfterglideError } from "./errors";
import type {
  PlatformService,
  SessionStart,
  SessionStateResult,
} from "./platform-service";
import { SecureTokenStore } from "./secure-token-store";

interface StreamTokenData {
  gsToken: string;
  market: string;
  offeringSettings: {
    regions: Array<{ baseUri: string; isDefault: boolean }>;
  };
}

interface XstsTokenData {
  Token: string;
  DisplayClaims: { xui: Array<{ uhs: string }> };
}

interface SessionContext {
  host: string;
  token: string;
  sessionPath: string;
  resolution: 720 | 1080;
}

export class LivePlatformService implements PlatformService {
  readonly mock = false;
  private readonly msal: Msal;
  private homeToken?: StreamTokenData;
  private webToken?: XstsTokenData;
  private currentSession?: SessionContext;
  private authGeneration = 0;

  constructor(private readonly tokenStore: SecureTokenStore) {
    tokenStore.load();
    this.msal = new Msal(tokenStore);
  }

  get hasStoredAuthentication(): boolean {
    return this.tokenStore.getUserToken() !== undefined;
  }

  async restore(): Promise<boolean> {
    if (!this.hasStoredAuthentication) return false;
    try {
      await this.refreshServiceTokens();
      return true;
    } catch {
      return false;
    }
  }

  async beginDeviceCode(): Promise<DeviceCode> {
    this.authGeneration += 1;
    const code = await this.msal.doDeviceCodeAuth();
    return {
      code: code.user_code,
      verificationUrl: code.verification_uri,
      expiresAt: Date.now() + code.expires_in * 1_000,
      message: code.message,
      // The protocol-only value stays in the main process.
      ...({ internalDeviceCode: code.device_code } as object),
    } as DeviceCode & { internalDeviceCode: string };
  }

  async pollDeviceCode(deviceCode: string, timeoutMs: number): Promise<void> {
    const generation = this.authGeneration;
    await this.msal.doPollForDeviceCodeAuth(deviceCode, timeoutMs);
    if (generation !== this.authGeneration) {
      this.tokenStore.removeAll();
      throw new AfterglideError(
        "AUTH_CANCELLED",
        "Sign-in was cancelled.",
        false,
      );
    }
    await this.refreshServiceTokens();
  }

  cancelAuthentication(): void {
    this.authGeneration += 1;
  }

  async signOut(): Promise<void> {
    this.cancelAuthentication();
    this.homeToken = undefined;
    this.webToken = undefined;
    this.currentSession = undefined;
    this.tokenStore.removeAll();
  }

  async listConsoles(): Promise<XboxConsole[]> {
    await this.ensureTokens();
    const web = this.webToken;
    if (!web)
      throw new AfterglideError(
        "AUTH_EXPIRED",
        "Sign in again to find your Xbox.",
      );

    const client = new XboxWebApi({
      uhs: web.DisplayClaims.xui[0]?.uhs ?? "",
      token: web.Token,
    });
    const response = await client.providers.smartglass.getConsolesList();
    return response.data.result.map((console) => ({
      id: console.id,
      name: console.name || "Xbox console",
      model: friendlyConsoleType(console.consoleType),
      power: normalizePower(console.powerState),
      remotePlayEnabled: console.consoleStreamingEnabled,
      remoteManagementEnabled: console.remoteManagementEnabled,
      wirelessWarning: console.wirelessWarning,
      outOfHomeWarning: console.outOfHomeWarning,
    }));
  }

  async wakeConsole(consoleId: string): Promise<void> {
    await this.ensureTokens();
    const web = this.webToken;
    if (!web)
      throw new AfterglideError(
        "AUTH_EXPIRED",
        "Sign in again to wake your Xbox.",
      );
    const client = new XboxWebApi({
      uhs: web.DisplayClaims.xui[0]?.uhs ?? "",
      token: web.Token,
    });
    await client.providers.smartglass.powerOn(consoleId);
  }

  async startSession(
    consoleId: string,
    resolution: 720 | 1080,
  ): Promise<SessionStart> {
    await this.ensureTokens();
    const home = this.homeToken;
    if (!home)
      throw new AfterglideError(
        "AUTH_EXPIRED",
        "Sign in again to start remote play.",
      );
    const region =
      home.offeringSettings.regions.find((candidate) => candidate.isDefault) ??
      home.offeringSettings.regions[0];
    if (!region)
      throw new AfterglideError(
        "NO_REGION",
        "Xbox remote play is not available in this region.",
        false,
      );

    const host = normalizeHost(region.baseUri);
    const response = await this.requestJson<SessionStart>(
      host,
      home.gsToken,
      "/v5/sessions/home/play",
      {
        method: "POST",
        body: JSON.stringify({
          clientSessionId: "",
          titleId: "",
          systemUpdateGroup: "",
          settings: {
            nanoVersion: "V3;WebrtcTransport.dll",
            enableOptionalDataCollection: false,
            enableTextToSpeech: false,
            highContrast: 0,
            locale: "en-US",
            useIceConnection: false,
            timezoneOffsetMinutes: new Date().getTimezoneOffset(),
            sdkType: "web",
            osName: resolution === 1080 ? "windows" : "android",
          },
          serverId: consoleId,
          fallbackRegionNames: [],
        }),
        headers: { "X-MS-Device-Info": deviceInfo(resolution) },
      },
    );

    this.currentSession = {
      host,
      token: home.gsToken,
      sessionPath: response.sessionPath,
      resolution,
    };
    return response;
  }

  async getSessionState(sessionPath: string): Promise<SessionStateResult> {
    const session = this.requireSession(sessionPath);
    return this.requestJson(
      session.host,
      session.token,
      `/${sessionPath}/state`,
    );
  }

  async authorizeSession(sessionPath: string): Promise<void> {
    const session = this.requireSession(sessionPath);
    const transferToken = await this.msal.getMsalToken();
    await this.requestJson(
      session.host,
      session.token,
      `/${sessionPath}/connect`,
      {
        method: "POST",
        body: JSON.stringify({ userToken: transferToken.data.lpt }),
      },
    );
  }

  async exchangeSdp(
    sessionPath: string,
    offer: RTCSessionDescriptionInit,
  ): Promise<string> {
    const session = this.requireSession(sessionPath);
    await this.requestJson(session.host, session.token, `/${sessionPath}/sdp`, {
      method: "POST",
      body: JSON.stringify({
        messageType: "offer",
        sdp: offer.sdp,
        requestId: "1",
        configuration: {
          chatConfiguration: {
            bytesPerSample: 2,
            expectedClipDurationMs: 20,
            format: { codec: "opus", container: "webm" },
            numChannels: 1,
            sampleFrequencyHz: 24_000,
          },
          chat: { minVersion: 1, maxVersion: 1 },
          control: { minVersion: 1, maxVersion: 3 },
          input: { minVersion: 1, maxVersion: 9 },
          message: { minVersion: 1, maxVersion: 1 },
          reliableinput: { minVersion: 9, maxVersion: 9 },
          unreliableinput: { minVersion: 9, maxVersion: 9 },
        },
      }),
    });
    const answer = await this.pollExchange(session, `/${sessionPath}/sdp`);
    if (!answer.exchangeResponse)
      throw new AfterglideError(
        "SDP_EMPTY",
        "The Xbox returned an empty video response.",
      );
    return answer.exchangeResponse;
  }

  async exchangeIce(
    sessionPath: string,
    candidates: string[],
  ): Promise<string> {
    const session = this.requireSession(sessionPath);
    await this.requestJson(session.host, session.token, `/${sessionPath}/ice`, {
      method: "POST",
      body: JSON.stringify({ candidates }),
    });
    const response = await this.pollExchange(session, `/${sessionPath}/ice`);
    if (!response.exchangeResponse)
      throw new AfterglideError(
        "ICE_EMPTY",
        "The Xbox returned no network route.",
      );
    return response.exchangeResponse;
  }

  async keepalive(sessionPath: string): Promise<void> {
    const session = this.requireSession(sessionPath);
    await this.requestJson(
      session.host,
      session.token,
      `/${sessionPath}/keepalive`,
      {
        method: "POST",
        body: "{}",
      },
    );
  }

  async stopSession(sessionPath: string): Promise<void> {
    const session = this.currentSession;
    this.currentSession = undefined;
    if (!session || session.sessionPath !== sessionPath) return;
    await this.requestJson(session.host, session.token, `/${sessionPath}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }

  private async refreshServiceTokens(): Promise<void> {
    const [streaming, web] = await Promise.all([
      this.msal.getStreamingTokens(),
      this.msal.getWebToken(),
    ]);
    this.homeToken = streaming.xHomeToken.data as StreamTokenData;
    this.webToken = web.data as XstsTokenData;
  }

  private async ensureTokens(): Promise<void> {
    if (!this.homeToken || !this.webToken) await this.refreshServiceTokens();
  }

  private requireSession(sessionPath: string): SessionContext {
    if (
      !this.currentSession ||
      this.currentSession.sessionPath !== sessionPath
    ) {
      throw new AfterglideError(
        "SESSION_MISSING",
        "The remote-play session is no longer active.",
      );
    }
    return this.currentSession;
  }

  private async pollExchange(
    session: SessionContext,
    path: string,
  ): Promise<{ exchangeResponse?: string | null }> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await this.requestJson<
        { exchangeResponse?: string | null } | undefined
      >(session.host, session.token, path, {}, true);
      if (response?.exchangeResponse) return response;
      await delay(250);
    }
    throw new AfterglideError(
      "EXCHANGE_TIMEOUT",
      "The Xbox did not finish negotiating the stream.",
    );
  }

  private async requestJson<T>(
    host: string,
    token: string,
    path: string,
    init: RequestInit = {},
    allowEmpty = false,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${host}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Gssv-Client": "XboxComBrowser",
          Authorization: `Bearer ${token}`,
          "X-MS-Device-Info": deviceInfo(
            this.currentSession?.resolution ?? 1080,
          ),
          ...init.headers,
        },
      });
      if (!response.ok) {
        throw new AfterglideError(
          `XBOX_HTTP_${response.status}`,
          `Xbox remote play returned status ${response.status}.`,
        );
      }
      if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
      ) {
        return (allowEmpty ? undefined : {}) as T;
      }
      const body = await response.text();
      if (!body) return (allowEmpty ? undefined : {}) as T;
      return JSON.parse(body) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeHost(baseUri: string): string {
  return baseUri.replace(/\/$/, "");
}

function normalizePower(power: string): XboxConsole["power"] {
  if (power === "On") return "on";
  if (power === "ConnectedStandby") return "standby";
  if (power === "Off") return "offline";
  return "unknown";
}

function friendlyConsoleType(type: string): string {
  const names: Record<string, string> = {
    XboxOne: "Xbox One",
    XboxOneS: "Xbox One S",
    XboxOneX: "Xbox One X",
    XboxSeriesS: "Xbox Series S",
    XboxSeriesX: "Xbox Series X",
    XboxScarlett: "Xbox Series X|S",
  };
  return names[type] ?? type.replace(/([a-z])([A-Z])/g, "$1 $2") ?? "Xbox";
}

function deviceInfo(resolution: 720 | 1080): string {
  return JSON.stringify({
    appInfo: {
      env: {
        clientAppId: "www.xbox.com",
        clientAppType: "browser",
        clientAppVersion: "21.1.98",
        clientSdkVersion: "8.5.3",
        httpEnvironment: "prod",
        sdkInstallId: "",
      },
    },
    dev: {
      hw: { make: "Valve", model: "Steam Deck", sdktype: "web" },
      os: {
        name: resolution === 1080 ? "windows" : "android",
        ver: "1",
        platform: "desktop",
      },
      displayInfo: {
        dimensions: {
          widthInPixels: resolution === 1080 ? 1920 : 1280,
          heightInPixels: resolution,
        },
        pixelDensity: { dpiX: 1, dpiY: 1 },
      },
      browser: { browserName: "chrome", browserVersion: "128.0" },
    },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseIceExchange(exchange: string): IceCandidatePayload[] {
  const parsed = JSON.parse(exchange) as IceCandidatePayload[];
  return parsed;
}
