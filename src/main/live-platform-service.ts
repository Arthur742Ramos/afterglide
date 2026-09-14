import { Msal } from "xal-node";
import XboxWebApi from "xbox-webapi";
import type {
  CloudTitle,
  DeviceCode,
  IceCandidatePayload,
  XboxConsole,
} from "../shared/contracts";
import {
  isTransientHttpStatus,
  NETWORK_POLICY,
  retryDelayMs,
} from "../shared/network-policy";
import { AfterglideError, errorForLog } from "./errors";
import type {
  PlatformService,
  SessionStart,
  SessionStateResult,
  StreamTarget,
} from "./platform-service";
import { SecureTokenStore } from "./secure-token-store";

const XboxWebApiConstructor =
  typeof XboxWebApi === "function"
    ? XboxWebApi
    : (XboxWebApi as unknown as { default: typeof XboxWebApi }).default;

interface StreamTokenData {
  gsToken: string;
  market: string;
  offeringSettings: {
    regions: Array<{
      baseUri: string;
      isDefault: boolean;
      name?: string;
      networkTestHostname?: string;
    }>;
  };
}

interface CloudTitleResult {
  titleId?: string;
  details?: {
    productId?: string;
    supportedInputTypes?: string[];
  };
}

interface CloudTitlesResponse {
  results?: CloudTitleResult[];
}

interface CatalogProduct {
  StoreId?: string;
  XCloudTitleId?: string;
  ProductTitle?: string;
  PublisherName?: string;
  Image_Tile?: { URL?: string };
  Image_Poster?: { URL?: string };
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
  private cloudToken?: StreamTokenData;
  private webToken?: XstsTokenData;
  private currentSession?: SessionContext;
  private cloudCatalog?: { expiresAt: number; titles: CloudTitle[] };
  private authGeneration = 0;

  constructor(private readonly tokenStore: SecureTokenStore) {
    tokenStore.load();
    this.msal = new Msal(tokenStore);
  }

  get hasStoredAuthentication(): boolean {
    return this.tokenStore.getUserToken() !== undefined;
  }

  get cloudAvailable(): boolean {
    return this.cloudToken !== undefined;
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
    this.cloudToken = undefined;
    this.webToken = undefined;
    this.currentSession = undefined;
    this.cloudCatalog = undefined;
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

    const client = new XboxWebApiConstructor({
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

  async listCloudTitles(): Promise<CloudTitle[]> {
    await this.ensureTokens();
    if (!this.cloudToken) await this.refreshServiceTokens();
    const cloud = this.cloudToken;
    if (!cloud)
      throw new AfterglideError(
        "XCLOUD_UNAVAILABLE",
        "Cloud gaming is not available for this account or region.",
        false,
      );
    if (this.cloudCatalog && this.cloudCatalog.expiresAt > Date.now())
      return structuredClone(this.cloudCatalog.titles);

    const region = chooseRegion(cloud);
    const host = normalizeHost(region.baseUri);
    const [all, recent] = await Promise.all([
      this.requestJson<CloudTitlesResponse>(host, cloud.gsToken, "/v2/titles"),
      this.requestJson<CloudTitlesResponse>(
        host,
        cloud.gsToken,
        "/v2/titles/mru?mr=25",
      ).catch(() => ({ results: [] })),
    ]);
    const rows = (all.results ?? []).filter(
      (row): row is CloudTitleResult & { titleId: string } =>
        typeof row.titleId === "string" && row.titleId.length > 0,
    );
    const productIds = [
      ...new Set(
        rows
          .map((row) => row.details?.productId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const batches = Array.from(
      { length: Math.ceil(productIds.length / 100) },
      (_, index) => productIds.slice(index * 100, index * 100 + 100),
    );
    const catalogResults = await Promise.all(
      batches.map((batch) =>
        this.requestJson<{
          Products?: CatalogProduct[] | Record<string, CatalogProduct>;
        }>(
          "https://catalog.gamepass.com",
          "",
          `/v3/products?hydration=RemoteHighSapphire0&market=${encodeURIComponent(cloud.market || "US")}&language=en-US`,
          {
            method: "POST",
            headers: {
              "ms-cv": "0.0",
              "calling-app-name": "Afterglide",
              "calling-app-version": "0.2.0",
            },
            body: JSON.stringify({ Products: batch }),
          },
        )
          .then((catalog) => ({ catalog, complete: true }))
          .catch(() => ({ catalog: { Products: [] }, complete: false })),
      ),
    );
    const products = catalogResults.flatMap(({ catalog }) =>
      Array.isArray(catalog.Products)
        ? catalog.Products
        : Object.values(catalog.Products ?? {}),
    );
    const recentIds = new Set(
      (recent.results ?? [])
        .map((row) => row.titleId)
        .filter((id): id is string => Boolean(id)),
    );
    const titles = mapCloudTitles(rows, products, recentIds);
    if (catalogResults.every((result) => result.complete))
      this.cloudCatalog = {
        expiresAt: Date.now() + NETWORK_POLICY.cloudCatalogCacheMs,
        titles,
      };
    return structuredClone(titles);
  }

  async wakeConsole(consoleId: string): Promise<void> {
    await this.ensureTokens();
    const web = this.webToken;
    if (!web)
      throw new AfterglideError(
        "AUTH_EXPIRED",
        "Sign in again to wake your Xbox.",
      );
    const client = new XboxWebApiConstructor({
      uhs: web.DisplayClaims.xui[0]?.uhs ?? "",
      token: web.Token,
    });
    await client.providers.smartglass.powerOn(consoleId);
  }

  async startSession(
    target: StreamTarget,
    resolution: 720 | 1080,
  ): Promise<SessionStart> {
    await this.ensureTokens();
    const token = target.source === "cloud" ? this.cloudToken : this.homeToken;
    if (!token)
      throw new AfterglideError(
        target.source === "cloud" ? "XCLOUD_UNAVAILABLE" : "AUTH_EXPIRED",
        target.source === "cloud"
          ? "Cloud gaming is not available for this account or region."
          : "Sign in again to start remote play.",
      );
    const region = chooseRegion(token);
    if (!region)
      throw new AfterglideError(
        "NO_REGION",
        "Xbox remote play is not available in this region.",
        false,
      );

    const host = normalizeHost(region.baseUri);
    const response = await this.requestJson<SessionStart>(
      host,
      token.gsToken,
      `/v5/sessions/${target.source}/play`,
      {
        method: "POST",
        body: JSON.stringify(buildSessionPayload(target, resolution)),
        headers: { "X-MS-Device-Info": deviceInfo(resolution) },
      },
    );

    this.currentSession = {
      host,
      token: token.gsToken,
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
    if (!session || session.sessionPath !== sessionPath) return;
    this.currentSession = undefined;
    await this.requestJson(session.host, session.token, `/${sessionPath}`, {
      method: "DELETE",
    }).catch((error: unknown) => {
      console.warn(
        "Could not stop the remote Xbox session",
        errorForLog(error),
      );
    });
  }

  private async refreshServiceTokens(): Promise<void> {
    const [streaming, web] = await Promise.all([
      this.msal.getStreamingTokens(),
      this.msal.getWebToken(),
    ]);
    this.homeToken = streaming.xHomeToken.data as StreamTokenData;
    this.cloudToken = streaming.xCloudToken?.data as
      | StreamTokenData
      | undefined;
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
    const deadline = Date.now() + NETWORK_POLICY.exchangeTimeoutMs;
    while (Date.now() < deadline) {
      const response = await this.requestJson<
        | {
            exchangeResponse?: string | null;
            errorDetails?: { code?: string | null; message?: string | null };
          }
        | undefined
      >(session.host, session.token, path, {}, true);
      if (response?.exchangeResponse) return response;
      if (response?.errorDetails?.message)
        throw new AfterglideError(
          response.errorDetails.code || "EXCHANGE_FAILED",
          "Xbox could not complete video negotiation. Try again.",
          true,
          { cause: new Error(response.errorDetails.message) },
        );
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
    const method = init.method?.toUpperCase() ?? "GET";
    const attempts = method === "GET" ? NETWORK_POLICY.maxReadRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        host.includes("catalog.gamepass.com")
          ? NETWORK_POLICY.catalogTimeoutMs
          : NETWORK_POLICY.requestTimeoutMs,
      );
      try {
        const response = await fetch(`${host}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Gssv-Client": "XboxComBrowser",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "X-MS-Device-Info": deviceInfo(
              this.currentSession?.resolution ?? 1080,
            ),
            ...init.headers,
          },
        });
        if (!response.ok) {
          if (
            attempt + 1 < attempts &&
            isTransientHttpStatus(response.status)
          ) {
            await delay(
              retryDelayMs(attempt, response.headers.get("retry-after")),
            );
            continue;
          }
          throw new AfterglideError(
            `XBOX_HTTP_${response.status}`,
            `Xbox streaming returned status ${response.status}.`,
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
      } catch (error) {
        if (attempt + 1 < attempts && isTransientRequestError(error)) {
          await delay(retryDelayMs(attempt));
          continue;
        }
        if (error instanceof DOMException && error.name === "AbortError")
          throw new AfterglideError(
            "XBOX_TIMEOUT",
            "Xbox services took too long to respond. Check your network and try again.",
          );
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new AfterglideError("XBOX_NETWORK", "Xbox services did not respond.");
  }
}

function chooseRegion(token: StreamTokenData) {
  return (
    token.offeringSettings.regions.find((candidate) => candidate.isDefault) ??
    token.offeringSettings.regions[0]
  );
}

export function buildSessionPayload(
  target: StreamTarget,
  resolution: 720 | 1080,
) {
  return {
    clientSessionId: "",
    titleId: target.source === "cloud" ? target.id : "",
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
    serverId: target.source === "home" ? target.id : "",
    fallbackRegionNames: [],
  };
}

function isTransientRequestError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

export function mapCloudTitles(
  rows: CloudTitleResult[],
  products: CatalogProduct[],
  recentIds: ReadonlySet<string>,
): CloudTitle[] {
  const byProduct = new Map(
    products
      .filter((product) => product.StoreId)
      .map((product) => [product.StoreId as string, product]),
  );
  const byTitle = new Map(
    products
      .filter((product) => product.XCloudTitleId)
      .map((product) => [product.XCloudTitleId as string, product]),
  );
  return rows
    .map((row) => {
      const titleId = row.titleId ?? "";
      const productId = row.details?.productId ?? "";
      const product = byTitle.get(titleId) ?? byProduct.get(productId);
      return {
        id: titleId,
        productId,
        name: product?.ProductTitle?.trim() || `Xbox Cloud Game ${titleId}`,
        publisher: product?.PublisherName?.trim() || "Xbox Cloud Gaming",
        imageUrl: safeCatalogImageUrl(
          product?.Image_Tile?.URL ?? product?.Image_Poster?.URL,
        ),
        supportedInputTypes: row.details?.supportedInputTypes ?? [],
        recentlyPlayed: recentIds.has(titleId),
      };
    })
    .sort((left, right) =>
      left.recentlyPlayed === right.recentlyPlayed
        ? left.name.localeCompare(right.name)
        : left.recentlyPlayed
          ? -1
          : 1,
    );
}

function safeCatalogImageUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    const allowed =
      url.protocol === "https:" &&
      (url.hostname.endsWith(".microsoft.com") ||
        url.hostname.endsWith(".s-microsoft.com") ||
        url.hostname.endsWith(".xboxlive.com"));
    return allowed ? url.toString() : undefined;
  } catch {
    return undefined;
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
      hw: { make: "Microsoft", model: "unknown", sdktype: "web" },
      os: {
        name: resolution === 1080 ? "windows" : "android",
        ver: "22631.2715",
        platform: "desktop",
      },
      displayInfo: {
        dimensions: {
          widthInPixels: 1920,
          heightInPixels: 1080,
        },
        pixelDensity: { dpiX: 2, dpiY: 2 },
      },
      browser: { browserName: "chrome", browserVersion: "119.0" },
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
