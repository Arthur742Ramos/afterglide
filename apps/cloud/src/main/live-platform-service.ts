import { Msal } from "xal-node";
import { release } from "node:os";
import { randomBytes } from "node:crypto";
import type {
  CloudTitle,
  DeviceCode,
  IceCandidatePayload,
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

interface StreamTokenData {
  gsToken: string;
  durationInSeconds?: number;
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
  XCloudTitleId?: string | null;
  ProductTitle?: string;
  PublisherName?: string;
  Image_Tile?: { URL?: string };
  Image_Poster?: { URL?: string };
}

interface CatalogResponse {
  Products?: CatalogProduct[] | Record<string, CatalogProduct>;
}

interface SessionContext {
  host: string;
  token: string;
  sessionPath: string;
  resolution: 720 | 1080;
}

export class LivePlatformService implements PlatformService {
  readonly mock = false;
  private msal: Msal;
  private cloudToken?: StreamTokenData;
  private cloudTokenExpiresAt = 0;
  private currentSession?: SessionContext;
  private cloudCatalog?: { expiresAt: number; titles: CloudTitle[] };
  private authGeneration = 0;
  private cloudRows: CloudTitleResult[] = [];
  private recentIds = new Set<string>();
  private searchedProducts = new Map<string, CatalogProduct>();

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
    this.cloudToken = undefined;
    this.currentSession = undefined;
    this.cloudCatalog = undefined;
    this.cloudRows = [];
    this.recentIds.clear();
    this.searchedProducts.clear();
    this.tokenStore.removeAll();
    this.msal = new Msal(this.tokenStore);
  }

  async listCloudTitles(
    onProgress?: (titles: CloudTitle[]) => void,
  ): Promise<CloudTitle[]> {
    const generation = this.authGeneration;
    await this.ensureTokens();
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
    if (!region)
      throw new AfterglideError(
        "NO_REGION",
        "Xbox Cloud Gaming has no available region for this account.",
        false,
      );
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
    const recentIds = new Set(
      (recent.results ?? [])
        .map((row) => row.titleId)
        .filter((id): id is string => Boolean(id)),
    );
    // Get recently played games into the first batch so they can launch early.
    this.cloudRows = rows;
    this.recentIds = recentIds;
    const prioritizedRows = [
      ...rows.filter((row) => recentIds.has(row.titleId)),
      ...rows,
    ];
    const productIds = [
      ...new Set(
        prioritizedRows
          .map((row) => row.details?.productId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    // A small first batch gives the initial page a fast path; later batches
    // keep the total request count low for libraries containing thousands.
    const batches = productIds.length ? [productIds.slice(0, 25)] : [];
    for (let offset = 25; offset < productIds.length; offset += 100)
      batches.push(productIds.slice(offset, offset + 100));
    const catalogResults: Array<{
      catalog: CatalogResponse;
      complete: boolean;
    }> = [];
    const hydrate = async (
      batch: string[],
    ): Promise<{ catalog: CatalogResponse; complete: boolean }> => {
      try {
        const catalog = await this.requestJson<CatalogResponse>(
          "https://catalog.gamepass.com",
          "",
          `/v3/products?hydration=RemoteLowJade0&market=${encodeURIComponent(cloud.market || "US")}&language=en-US`,
          {
            method: "POST",
            headers: {
              "ms-cv": correlationVector(),
              "calling-app-name": "Afterglide Cloud",
              "calling-app-version": "0.2.0",
            },
            body: JSON.stringify({ Products: batch }),
          },
        );
        return { catalog, complete: true };
      } catch {
        if (batch.length > 25) {
          // A slow or rejected bulk response should not erase a hundred covers.
          // Recover smaller pieces sequentially within this worker's slot.
          const recovered = [];
          for (let offset = 0; offset < batch.length; offset += 25)
            recovered.push(await hydrate(batch.slice(offset, offset + 25)));
          return {
            catalog: {
              Products: recovered.flatMap(({ catalog }) =>
                catalogProducts(catalog),
              ),
            },
            complete: recovered.every((result) => result.complete),
          };
        }
        return { catalog: { Products: [] }, complete: false };
      }
    };
    // Publish completed batches immediately; the first page must not wait for
    // every slow request in a large library. Keep four concurrent slots.
    for (let offset = 0; offset < batches.length; offset += 4) {
      await Promise.all(
        batches.slice(offset, offset + 4).map(async (batch) => {
          const result = await hydrate(batch);
          catalogResults.push(result);
          if (!onProgress || generation !== this.authGeneration) return;
          const available = [
            ...catalogResults.flatMap(({ catalog }) =>
              catalogProducts(catalog),
            ),
            ...this.searchedProducts.values(),
          ];
          const knownProducts = new Set(
            available.map((product) => product.StoreId),
          );
          const knownTitles = new Set(
            available.map((product) => product.XCloudTitleId),
          );
          const readyRows = rows.filter(
            (row) =>
              knownProducts.has(row.details?.productId) ||
              knownTitles.has(row.titleId),
          );
          if (readyRows.length)
            onProgress(mapCloudTitles(readyRows, available, recentIds));
        }),
      );
    }
    const products = [
      ...catalogResults.flatMap(({ catalog }) => catalogProducts(catalog)),
      ...this.searchedProducts.values(),
    ];
    const titles = mapCloudTitles(rows, products, recentIds);
    if (
      generation === this.authGeneration &&
      catalogResults.every((result) => result.complete)
    )
      this.cloudCatalog = {
        expiresAt: Date.now() + NETWORK_POLICY.cloudCatalogCacheMs,
        titles,
      };
    return structuredClone(titles);
  }

  async searchCloudTitles(query: string): Promise<CloudTitle[]> {
    await this.ensureTokens();
    const generation = this.authGeneration;
    const cloud = this.cloudToken;
    if (!cloud || !query.trim()) return [];
    const products: CatalogProduct[] = [];
    let continuation: string | undefined;
    const seen = new Set<string>();
    do {
      const response = await this.requestJson<
        CatalogResponse & { ContinuationToken?: string }
      >(
        "https://catalog.gamepass.com",
        "",
        `/search/v2?market=${encodeURIComponent(cloud.market || "US")}&language=en-US&hydration=RemoteLowJade0`,
        {
          method: "POST",
          headers: {
            "ms-cv": correlationVector(),
            "calling-app-name": "Afterglide Cloud",
            "calling-app-version": "0.2.0",
            ...(continuation ? { "X-MS-CT": continuation } : {}),
          },
          body: JSON.stringify({
            Query: query.trim(),
            Scope: "EDGEWATER",
            DeviceFamilies: ["Windows.Xbox"],
            ProductFamilies: ["games"],
          }),
        },
      );
      if (generation !== this.authGeneration) return [];
      products.push(...catalogProducts(response));
      continuation = response.ContinuationToken || undefined;
      if (continuation && seen.has(continuation))
        throw new AfterglideError(
          "CATALOG_SEARCH",
          "Cloud search could not finish. Try again.",
        );
      if (continuation) seen.add(continuation);
    } while (continuation);
    const available = new Set(products.map((product) => product.StoreId));
    for (const product of products)
      if (product.StoreId) this.searchedProducts.set(product.StoreId, product);
    // Search is public; only return games present in the authenticated cloud list.
    return mapCloudTitles(
      this.cloudRows.filter((row) => available.has(row.details?.productId)),
      products,
      this.recentIds,
    );
  }

  async startSession(
    target: StreamTarget,
    resolution: 720 | 1080,
  ): Promise<SessionStart> {
    await this.ensureTokens();
    const token = this.cloudToken;
    if (!token)
      throw new AfterglideError(
        "XCLOUD_UNAVAILABLE",
        "Cloud gaming is not available for this account or region.",
      );
    const region = chooseRegion(token);
    if (!region)
      throw new AfterglideError(
        "NO_REGION",
        "Xbox Cloud Gaming is not available in this region.",
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
    // Use the library's supported cloud offering flow directly. Its combined
    // getStreamingTokens() requires xHome to succeed before requesting cloud.
    const generation = this.authGeneration;
    const msal = this.msal;
    const gssv = await msal.getGssvToken();
    let cloud: StreamTokenData | undefined;
    try {
      cloud = (await msal.getStreamToken(gssv.data.Token, "xgpuweb"))
        .data as StreamTokenData;
    } catch {
      try {
        cloud = (await msal.getStreamToken(gssv.data.Token, "xgpuwebf2p"))
          .data as StreamTokenData;
      } catch {
        // Account, subscription and region eligibility remain Xbox decisions.
      }
    }
    if (generation !== this.authGeneration) return;
    this.cloudToken = cloud;
    this.cloudTokenExpiresAt = cloud
      ? Date.now() + Math.max(0, (cloud.durationInSeconds ?? 300) - 60) * 1_000
      : 0;
    this.cloudCatalog = undefined;
  }

  private async ensureTokens(): Promise<void> {
    if (!this.cloudToken || Date.now() >= this.cloudTokenExpiresAt)
      await this.refreshServiceTokens();
  }

  private requireSession(sessionPath: string): SessionContext {
    if (
      !this.currentSession ||
      this.currentSession.sessionPath !== sessionPath
    ) {
      throw new AfterglideError(
        "SESSION_MISSING",
        "The cloud session is no longer active.",
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
    // Catalog hydration uses POST for an immutable lookup; session POSTs must
    // remain single-attempt to avoid creating duplicate cloud sessions.
    const readOnly =
      method === "GET" ||
      (method === "POST" &&
        host === "https://catalog.gamepass.com" &&
        (path.startsWith("/v3/products?") || path.startsWith("/search/v2?")));
    const attempts = readOnly ? NETWORK_POLICY.maxReadRetries + 1 : 1;
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
    titleId: target.id,
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
      osName: process.platform === "darwin" ? "macos" : "windows",
    },
    serverId: "",
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

function catalogProducts(catalog: CatalogResponse): CatalogProduct[] {
  return Array.isArray(catalog.Products)
    ? catalog.Products
    : Object.entries(catalog.Products ?? {}).map(([productId, product]) => ({
        ...product,
        // Most live records omit the Store ID retained in their object key.
        StoreId: product.StoreId ?? productId,
      }));
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
        name:
          process.platform === "darwin"
            ? "macos"
            : process.platform === "win32"
              ? "windows"
              : "linux",
        ver: process.getSystemVersion?.() ?? release(),
        platform: "desktop",
      },
      displayInfo: {
        dimensions: {
          widthInPixels: 1920,
          heightInPixels: 1080,
        },
        pixelDensity: { dpiX: 2, dpiY: 2 },
      },
      browser: {
        browserName: "chrome",
        browserVersion: process.versions.chrome ?? "unknown",
      },
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

function correlationVector(): string {
  return `${randomBytes(16).toString("base64").replace(/=+$/, "")}.0`;
}
