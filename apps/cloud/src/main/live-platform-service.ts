import { Msal, type TokenStore } from "xal-node";
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
import { authenticationTokenStore, ownedTokenStore } from "./auth-token-store";
import {
  CloudOperation,
  CLOUD_OPERATION_LIMITS,
  operationCancelled,
  type OperationContext,
} from "./operation-context";

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
  sessionId: string;
  host: string;
  token: string;
  sessionPath: string;
  resolution: 720 | 1080;
  signal?: AbortSignal;
  abort: () => void;
}

interface AuthenticationAttempt {
  generation: number;
  msal: Msal;
  store: TokenStore;
  deviceCode?: string;
  polling: boolean;
}

export class LivePlatformService implements PlatformService {
  readonly mock = false;
  private msal: Msal;
  private cloudToken?: StreamTokenData;
  private cloudTokenExpiresAt = 0;
  private currentSession?: SessionContext;
  private cloudCatalog?: { expiresAt: number; titles: CloudTitle[] };
  private authGeneration = 0;
  private authenticationAttempt?: AuthenticationAttempt;
  private authOperations = new AbortController();
  private sessionCreation = 0;
  private pendingSessionCreations = new Set<number>();
  private cloudRows: CloudTitleResult[] = [];
  private recentIds = new Set<string>();
  private searchedProducts = new Map<string, CatalogProduct>();

  constructor(private readonly tokenStore: SecureTokenStore) {
    tokenStore.load();
    this.msal = this.sessionAuthentication();
  }

  get hasStoredAuthentication(): boolean {
    return this.tokenStore.getUserToken() !== undefined;
  }

  get cloudAvailable(): boolean {
    return this.cloudToken !== undefined;
  }

  async restore(): Promise<boolean> {
    if (!this.hasStoredAuthentication) return false;
    const generation = this.authGeneration;
    try {
      await this.refreshServiceTokens();
      return generation === this.authGeneration && this.hasStoredAuthentication;
    } catch {
      return false;
    }
  }

  async beginDeviceCode(): Promise<DeviceCode> {
    this.cancelAuthentication();
    const generation = this.authGeneration;
    const store = authenticationTokenStore();
    const attempt: AuthenticationAttempt = {
      generation,
      store,
      msal: new Msal(
        ownedTokenStore(store, () => this.isCurrentAttempt(attempt)),
      ),
      polling: false,
    };
    this.authenticationAttempt = attempt;
    const code = await attempt.msal.doDeviceCodeAuth();
    this.requireCurrentAttempt(attempt);
    attempt.deviceCode = code.device_code;
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
    const attempt = this.authenticationAttempt;
    this.requireCurrentAttempt(attempt);
    if (attempt.deviceCode !== deviceCode || attempt.polling)
      throw authenticationCancelled();
    attempt.polling = true;
    try {
      await attempt.msal.doPollForDeviceCodeAuth(deviceCode, timeoutMs);
      this.requireCurrentAttempt(attempt);
      const cloud = await this.fetchServiceTokens(attempt.msal);
      this.requireCurrentAttempt(attempt);
      // No await between ownership validation and encrypted-store publication.
      this.tokenStore.replaceFrom(attempt.store);
      this.cloudRows = [];
      this.recentIds.clear();
      this.searchedProducts.clear();
      this.setCloudToken(cloud);
      this.authenticationAttempt = undefined;
      // A refresh of the previous account may have started while sign-in was
      // pending. Revoke that SDK client when the new account takes ownership.
      this.authOperations.abort();
      this.authOperations = new AbortController();
      this.authGeneration += 1;
      this.msal = this.sessionAuthentication();
    } catch (error) {
      this.requireCurrentAttempt(attempt);
      this.authenticationAttempt = undefined;
      throw error;
    }
  }

  cancelAuthentication(): void {
    this.authOperations.abort();
    this.authOperations = new AbortController();
    this.authGeneration += 1;
    this.authenticationAttempt = undefined;
    this.msal = this.sessionAuthentication();
  }

  async signOut(): Promise<void> {
    this.cancelAuthentication();
    this.cloudToken = undefined;
    this.currentSession?.abort();
    this.currentSession = undefined;
    this.cloudCatalog = undefined;
    this.cloudRows = [];
    this.recentIds.clear();
    this.searchedProducts.clear();
    this.tokenStore.removeAll();
  }

  private sessionAuthentication(): Msal {
    const generation = this.authGeneration;
    return new Msal(
      ownedTokenStore(
        this.tokenStore,
        () => generation === this.authGeneration,
      ),
    );
  }

  private isCurrentAttempt(attempt: AuthenticationAttempt): boolean {
    return (
      this.authenticationAttempt === attempt &&
      attempt.generation === this.authGeneration
    );
  }

  private requireCurrentAttempt(
    attempt: AuthenticationAttempt | undefined,
  ): asserts attempt is AuthenticationAttempt {
    if (!attempt || !this.isCurrentAttempt(attempt))
      throw authenticationCancelled();
  }

  async listCloudTitles(
    onProgress?: (titles: CloudTitle[]) => void,
    context?: OperationContext,
  ): Promise<CloudTitle[]> {
    const operation = new CloudOperation(
      context,
      CLOUD_OPERATION_LIMITS.catalogMs,
      this.authOperations.signal,
    );
    try {
      return await this.loadCloudTitles(onProgress, operation);
    } finally {
      operation.dispose();
    }
  }

  private async loadCloudTitles(
    onProgress: ((titles: CloudTitle[]) => void) | undefined,
    operation: CloudOperation,
  ): Promise<CloudTitle[]> {
    const generation = this.authGeneration;
    await operation.wait(() => this.ensureTokens());
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
      this.requestJson<CloudTitlesResponse>(
        host,
        cloud.gsToken,
        "/v2/titles",
        {},
        false,
        operation,
      ),
      this.requestJson<CloudTitlesResponse>(
        host,
        cloud.gsToken,
        "/v2/titles/mru?mr=25",
        {},
        false,
        operation,
      ).catch(() => {
        operation.check();
        return { results: [] };
      }),
    ]);
    operation.check();
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
    const eligibleProducts = new Set(rows.map((row) => row.details?.productId));
    for (const productId of this.searchedProducts.keys())
      if (!eligibleProducts.has(productId))
        this.searchedProducts.delete(productId);
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
          false,
          operation,
        );
        return { catalog, complete: true };
      } catch (error) {
        operation.check();
        if (error instanceof AfterglideError && error.code === "XBOX_TIMEOUT")
          throw error;
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
      operation.check();
      await Promise.all(
        batches.slice(offset, offset + 4).map(async (batch) => {
          const result = await hydrate(batch);
          operation.check();
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

  async searchCloudTitles(
    query: string,
    context?: OperationContext,
  ): Promise<CloudTitle[]> {
    const operation = new CloudOperation(
      context,
      CLOUD_OPERATION_LIMITS.searchMs,
      this.authOperations.signal,
    );
    try {
      return await this.searchTitles(query, operation);
    } finally {
      operation.dispose();
    }
  }

  private async searchTitles(
    query: string,
    operation: CloudOperation,
  ): Promise<CloudTitle[]> {
    await operation.wait(() => this.ensureTokens());
    const generation = this.authGeneration;
    const cloud = this.cloudToken;
    if (!cloud || !query.trim()) return [];
    const products: CatalogProduct[] = [];
    let continuation: string | undefined;
    const seen = new Set<string>();
    let pages = 0;
    do {
      operation.check();
      if (++pages > CLOUD_OPERATION_LIMITS.searchPages)
        throw new AfterglideError(
          "CATALOG_SEARCH_LIMIT",
          "Cloud search returned too many pages. Try a more specific search.",
        );
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
        false,
        operation,
      );
      if (generation !== this.authGeneration) return [];
      products.push(...catalogProducts(response));
      if (products.length > CLOUD_OPERATION_LIMITS.searchProducts)
        throw new AfterglideError(
          "CATALOG_SEARCH_LIMIT",
          "Cloud search returned too many games. Try a more specific search.",
        );
      continuation = response.ContinuationToken || undefined;
      if (continuation && seen.has(continuation))
        throw new AfterglideError(
          "CATALOG_SEARCH",
          "Cloud search could not finish. Try again.",
        );
      if (continuation) seen.add(continuation);
    } while (continuation);
    const available = new Set(products.map((product) => product.StoreId));
    const eligibleProducts = new Set(
      this.cloudRows.map((row) => row.details?.productId),
    );
    for (const product of products)
      if (product.StoreId && eligibleProducts.has(product.StoreId))
        this.searchedProducts.set(product.StoreId, product);
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
    context?: OperationContext,
  ): Promise<SessionStart> {
    const operation = new CloudOperation(
      context,
      CLOUD_OPERATION_LIMITS.provisioningMs,
      this.authOperations.signal,
    );
    const creation = ++this.sessionCreation;
    this.pendingSessionCreations.add(creation);
    try {
      await operation.wait(() => this.ensureTokens());
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
      const sessionContext = (response: SessionStart): SessionContext => {
        const controller = new AbortController();
        const unlink: Array<() => void> = [];
        for (const signal of [context?.signal, this.authOperations.signal]) {
          if (!signal) continue;
          const abort = () => controller.abort(signal.reason);
          if (signal.aborted) abort();
          else {
            signal.addEventListener("abort", abort, { once: true });
            unlink.push(() => signal.removeEventListener("abort", abort));
          }
        }
        return {
          host,
          token: token.gsToken,
          sessionId: response.sessionId,
          sessionPath: response.sessionPath,
          resolution,
          signal: controller.signal,
          abort: () => {
            controller.abort();
            for (const remove of unlink) remove();
          },
        };
      };
      const response = await this.requestJson<SessionStart>(
        host,
        token.gsToken,
        `/v5/sessions/${target.source}/play`,
        {
          method: "POST",
          body: JSON.stringify(
            buildSessionPayload(
              target,
              resolution,
              token.offeringSettings.regions,
            ),
          ),
          headers: { "X-MS-Device-Info": deviceInfo(resolution) },
        },
        false,
        operation,
        (late) => {
          void this.cleanupLateSession(sessionContext(late), creation);
        },
      );
      if (creation !== this.sessionCreation || operation.signal.aborted) {
        await this.cleanupLateSession(sessionContext(response), creation);
        throw operationCancelled();
      }
      this.currentSession?.abort();
      this.currentSession = sessionContext(response);
      return response;
    } finally {
      this.pendingSessionCreations.delete(creation);
      operation.dispose();
    }
  }

  async getSessionState(
    sessionPath: string,
    context?: OperationContext,
  ): Promise<SessionStateResult> {
    const session = this.requireSession(sessionPath);
    return this.requestJson(
      session.host,
      session.token,
      `/${sessionPath}/state`,
      { signal: session.signal },
      false,
      context,
    );
  }

  async authorizeSession(
    sessionPath: string,
    context?: OperationContext,
  ): Promise<void> {
    const session = this.requireSession(sessionPath);
    const operation = new CloudOperation(
      context,
      NETWORK_POLICY.requestTimeoutMs,
      session.signal,
    );
    try {
      const transferToken = await operation.wait(() =>
        this.msal.getMsalToken(),
      );
      await this.requestJson(
        session.host,
        session.token,
        `/${sessionPath}/connect`,
        {
          method: "POST",
          body: JSON.stringify({ userToken: transferToken.data.lpt }),
        },
        false,
        operation,
      );
    } finally {
      operation.dispose();
    }
  }

  async exchangeSdp(
    sessionPath: string,
    offer: RTCSessionDescriptionInit,
  ): Promise<string> {
    const session = this.requireSession(sessionPath);
    const operation = new CloudOperation(
      undefined,
      NETWORK_POLICY.exchangeTimeoutMs,
      session.signal,
    );
    try {
      await this.requestJson(
        session.host,
        session.token,
        `/${sessionPath}/sdp`,
        {
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
        },
        false,
        operation,
      );
      const answer = await this.pollExchange(
        session,
        `/${sessionPath}/sdp`,
        operation,
      );
      if (!answer.exchangeResponse)
        throw new AfterglideError(
          "SDP_EMPTY",
          "The Xbox returned an empty video response.",
        );
      return answer.exchangeResponse;
    } finally {
      operation.dispose();
    }
  }

  async exchangeIce(
    sessionPath: string,
    candidates: string[],
  ): Promise<string> {
    const session = this.requireSession(sessionPath);
    const operation = new CloudOperation(
      undefined,
      NETWORK_POLICY.exchangeTimeoutMs,
      session.signal,
    );
    try {
      await this.requestJson(
        session.host,
        session.token,
        `/${sessionPath}/ice`,
        {
          method: "POST",
          body: JSON.stringify({ candidates }),
        },
        false,
        operation,
      );
      const response = await this.pollExchange(
        session,
        `/${sessionPath}/ice`,
        operation,
      );
      if (!response.exchangeResponse)
        throw new AfterglideError(
          "ICE_EMPTY",
          "The Xbox returned no network route.",
        );
      return response.exchangeResponse;
    } finally {
      operation.dispose();
    }
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
        signal: session.signal,
      },
    );
  }

  async stopSession(sessionPath: string, sessionId?: string): Promise<void> {
    const session = this.currentSession;
    if (
      !session ||
      session.sessionPath !== sessionPath ||
      (sessionId !== undefined && session.sessionId !== sessionId)
    )
      return;
    this.currentSession = undefined;
    session.abort();
    await this.requestJson(session.host, session.token, `/${sessionPath}`, {
      method: "DELETE",
    }).catch((error: unknown) => {
      console.warn(
        "Could not stop the remote Xbox session",
        errorForLog(error),
      );
    });
  }

  private async cleanupLateSession(
    session: SessionContext,
    creation: number,
  ): Promise<void> {
    session.abort();
    // Never delete a path reused by a newer active session, or guess which
    // server session a newer unresolved creation will return.
    if (
      this.currentSession?.sessionPath === session.sessionPath ||
      [...this.pendingSessionCreations].some((pending) => pending > creation)
    )
      return;
    if (
      typeof session.sessionPath !== "string" ||
      !/^v[0-9]+\/sessions\/cloud\/[A-Za-z0-9_-]+$/.test(session.sessionPath)
    )
      return;
    await this.requestJson(
      session.host,
      session.token,
      `/${session.sessionPath}`,
      { method: "DELETE" },
    ).catch(() => {});
  }

  private async refreshServiceTokens(): Promise<void> {
    // Use the library's supported cloud offering flow directly. Its combined
    // getStreamingTokens() requires xHome to succeed before requesting cloud.
    const generation = this.authGeneration;
    const msal = this.msal;
    const cloud = await this.fetchServiceTokens(msal);
    if (generation !== this.authGeneration) return;
    this.setCloudToken(cloud);
  }

  private async fetchServiceTokens(
    msal: Msal,
  ): Promise<StreamTokenData | undefined> {
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
    return cloud;
  }

  private setCloudToken(cloud: StreamTokenData | undefined): void {
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
    if (this.currentSession.signal?.aborted) throw operationCancelled();
    return this.currentSession;
  }

  private async pollExchange(
    session: SessionContext,
    path: string,
    operation: CloudOperation,
  ): Promise<{ exchangeResponse?: string | null }> {
    while (true) {
      operation.check();
      const response = await this.requestJson<
        | {
            exchangeResponse?: string | null;
            errorDetails?: { code?: string | null; message?: string | null };
          }
        | undefined
      >(session.host, session.token, path, {}, true, operation);
      if (response?.exchangeResponse) return response;
      if (response?.errorDetails?.message)
        throw new AfterglideError(
          response.errorDetails.code || "EXCHANGE_FAILED",
          "Xbox could not complete video negotiation. Try again.",
          true,
          { cause: new Error(response.errorDetails.message) },
        );
      await operation.delay(250);
    }
  }

  private async requestJson<T>(
    host: string,
    token: string,
    path: string,
    init: RequestInit = {},
    allowEmpty = false,
    context?: OperationContext,
    onLateResult?: (result: T) => void,
  ): Promise<T> {
    const operation = new CloudOperation(
      context,
      host.includes("catalog.gamepass.com")
        ? NETWORK_POLICY.catalogTimeoutMs
        : NETWORK_POLICY.requestTimeoutMs,
      init.signal ?? undefined,
    );
    const method = init.method?.toUpperCase() ?? "GET";
    // Catalog hydration uses POST for an immutable lookup; session POSTs must
    // remain single-attempt to avoid creating duplicate cloud sessions.
    const readOnly =
      method === "GET" ||
      (method === "POST" &&
        host === "https://catalog.gamepass.com" &&
        (path.startsWith("/v3/products?") || path.startsWith("/search/v2?")));
    const attempts = readOnly ? NETWORK_POLICY.maxReadRetries + 1 : 1;
    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        operation.check();
        let retryAfter: string | null = null;
        let transientStatus = false;
        let received = false;
        let completedResult: T | undefined;
        let lateHandled = false;
        const handleLateResult = (value: T) => {
          if (
            !lateHandled &&
            onLateResult &&
            (operation.signal.aborted || Date.now() >= operation.deadline)
          ) {
            lateHandled = true;
            onLateResult(value);
          }
        };
        try {
          const work = async (): Promise<T> => {
            const response = await fetch(`${host}${path}`, {
              ...init,
              signal: operation.signal,
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
              transientStatus = isTransientHttpStatus(response.status);
              retryAfter = response.headers.get("retry-after");
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
          };
          const result = work();
          if (onLateResult)
            void result.then(
              (value) => {
                received = true;
                completedResult = value;
                handleLateResult(value);
              },
              () => {},
            );
          return await operation.wait(() => result);
        } catch (error) {
          if (received) handleLateResult(completedResult as T);
          operation.check();
          if (
            attempt + 1 < attempts &&
            (transientStatus || isTransientRequestError(error))
          ) {
            await operation.delay(retryDelayMs(attempt, retryAfter));
            continue;
          }
          if (error instanceof DOMException && error.name === "AbortError")
            throw new AfterglideError(
              "XBOX_TIMEOUT",
              "Xbox services took too long to respond. Check your network and try again.",
            );
          throw error;
        }
      }
      throw new AfterglideError(
        "XBOX_NETWORK",
        "Xbox services did not respond.",
      );
    } finally {
      operation.dispose();
    }
  }
}

function authenticationCancelled(): AfterglideError {
  return new AfterglideError("AUTH_CANCELLED", "Sign-in was cancelled.", false);
}

function chooseRegion(token: StreamTokenData) {
  return (
    token.offeringSettings.regions.find((candidate) => candidate.isDefault) ??
    token.offeringSettings.regions[0]
  );
}

function fallbackRegions(
  regions: StreamTokenData["offeringSettings"]["regions"],
): string[] {
  const primary =
    regions.find((candidate) => candidate.isDefault) ?? regions[0];
  const seen = new Set<string>();
  const primaryName = primary?.name?.trim();
  if (primaryName) seen.add(primaryName);
  const names: string[] = [];
  for (const region of regions) {
    if (region === primary || region.baseUri === primary?.baseUri) continue;
    const name = region.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function buildSessionPayload(
  target: StreamTarget,
  resolution: 720 | 1080,
  regions: StreamTokenData["offeringSettings"]["regions"] = [],
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
    fallbackRegionNames: fallbackRegions(regions),
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

export function parseIceExchange(exchange: string): IceCandidatePayload[] {
  const parsed = JSON.parse(exchange) as IceCandidatePayload[];
  return parsed;
}

function correlationVector(): string {
  return `${randomBytes(16).toString("base64").replace(/=+$/, "")}.0`;
}
