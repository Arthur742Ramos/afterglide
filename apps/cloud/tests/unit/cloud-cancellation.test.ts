import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecureTokenStore } from "../../src/main/secure-token-store";
import type {
  PlatformService,
  SessionStart,
  StreamTarget,
} from "../../src/main/platform-service";
import { AppController } from "../../src/main/app-controller";
import { SettingsStore } from "../../src/main/settings-store";
import { NETWORK_POLICY } from "../../src/shared/network-policy";

const auth = vi.hoisted(() => ({
  getGssvToken: vi.fn(),
  getStreamToken: vi.fn(),
}));
vi.mock("xal-node", async (importOriginal) => {
  const original = await importOriginal<typeof import("xal-node")>();
  return {
    TokenStore: original.TokenStore,
    Msal: class {
      constructor(private readonly store: import("xal-node").TokenStore) {}
      getGssvToken = auth.getGssvToken;
      getStreamToken = auth.getStreamToken;
      async doDeviceCodeAuth() {
        return {
          user_code: "SYNTHETIC",
          device_code: "synthetic-B",
          verification_uri: "https://microsoft.com/link",
          expires_in: 900,
          interval: 1,
          message: "Synthetic",
        };
      }
      async doPollForDeviceCodeAuth() {
        this.store.removeAll();
        this.store.setUserToken({
          data: {
            access_token: "synthetic-B",
            refresh_token: "synthetic-refresh-B",
            expires_in: 3600,
          },
        } as never);
        this.store.save();
      }
    },
  };
});
import { LivePlatformService } from "../../src/main/live-platform-service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const title = (id: string) => ({
  id,
  productId: id,
  name: id,
  publisher: "Xbox",
  supportedInputTypes: ["Controller"],
  recentlyPlayed: false,
});
const session = (id: string): SessionStart => ({
  sessionId: id,
  sessionPath: `v5/sessions/cloud/${id}`,
});
function service() {
  return new LivePlatformService({
    load: vi.fn(),
    getUserToken: () => ({}),
    removeAll: vi.fn(),
    replaceFrom: vi.fn(),
  } as unknown as SecureTokenStore);
}
async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
let directory: string | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  auth.getGssvToken.mockResolvedValue({ data: { Token: "synthetic-gssv" } });
  auth.getStreamToken.mockResolvedValue({
    data: {
      gsToken: "synthetic-cloud",
      market: "US",
      durationInSeconds: 3600,
      offeringSettings: {
        regions: [{ baseUri: "https://test.xboxlive.com", isDefault: true }],
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("cloud operation cancellation and total budgets", () => {
  it("clears A's eligibility metadata when B signs in before B discovery completes", async () => {
    let account = "A";
    const discovery = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (url.includes("/search/v2?")) {
          const query = JSON.parse(String(options.body)).Query as string;
          return Response.json({
            Products: { [query]: { ProductTitle: query } },
          });
        }
        if (url.includes("/v3/products?"))
          return Response.json({
            Products: { [account]: { ProductTitle: account } },
          });
        if (url.includes("/mru?")) return Response.json({ results: [] });
        return account === "B"
          ? discovery.promise
          : Response.json({
              results: [{ titleId: "game-A", details: { productId: "A" } }],
            });
      }),
    );
    const platform = service();
    await platform.restore();
    await platform.listCloudTitles();
    expect(await platform.searchCloudTitles("A")).toHaveLength(1);
    await platform.beginDeviceCode();
    await platform.pollDeviceCode("synthetic-B", 1000);
    account = "B";
    const listing = platform.listCloudTitles();
    try {
      expect(await platform.searchCloudTitles("A")).toEqual([]);
    } finally {
      discovery.resolve(
        Response.json({
          results: [{ titleId: "game-B", details: { productId: "B" } }],
        }),
      );
      await listing;
    }
    expect(await platform.searchCloudTitles("B")).toEqual([
      expect.objectContaining({ id: "game-B" }),
    ]);
  });

  it("cleans a creation body that arrives after its deadline before the timer fires", async () => {
    vi.useFakeTimers();
    const body = deferred<string>();
    const deletes: string[] = [];
    let reading = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (options.method === "DELETE") {
          deletes.push(url);
          return new Response(null, { status: 204 });
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => {
            reading = true;
            return body.promise;
          },
        } as Response;
      }),
    );
    const platform = service();
    await platform.restore();
    const creating = platform
      .startSession({ source: "cloud", id: "A" }, 1080)
      .catch((error: unknown) => error);
    await flush();
    expect(reading).toBe(true);
    // Jump the clock without dispatching timeout callbacks, as can happen
    // when a suspended app receives a buffered response after waking.
    vi.setSystemTime(Date.now() + NETWORK_POLICY.requestTimeoutMs + 1);
    body.resolve(JSON.stringify(session("A")));
    expect(await creating).toMatchObject({ code: "XBOX_TIMEOUT" });
    await flush();
    expect(deletes).toEqual(["https://test.xboxlive.com/v5/sessions/cloud/A"]);
  });

  it("bounds retained search metadata to the authenticated cloud library across queries", async () => {
    let query = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/search/v2?")) {
          query++;
          return Response.json({
            Products: {
              known: { ProductTitle: "Known" },
              ...Object.fromEntries(
                Array.from({ length: 50 }, (_, index) => [
                  `foreign-${query}-${index}`,
                  { ProductTitle: "Foreign" },
                ]),
              ),
            },
          });
        }
        if (url.includes("/v3/products?"))
          return Response.json({
            Products: { known: { ProductTitle: "Known" } },
          });
        return Response.json({
          results: url.includes("/mru?")
            ? []
            : [{ titleId: "known-game", details: { productId: "known" } }],
        });
      }),
    );
    const platform = service();
    await platform.restore();
    await platform.listCloudTitles();
    for (let index = 0; index < 8; index++)
      expect(await platform.searchCloudTitles(`query-${index}`)).toHaveLength(
        1,
      );
    // Retained entries, rather than response allocations, determine whether
    // repeated unrelated public search results grow the session's cache.
    const retained = (
      platform as unknown as { searchedProducts: Map<string, unknown> }
    ).searchedProducts;
    expect(retained.size).toBeLessThanOrEqual(1);
  });

  it("aborts a catalog response body when sign-out cancels discovery", async () => {
    const body = deferred<string>();
    const signals: AbortSignal[] = [];
    let bodyStarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (url.includes("/mru?")) return Response.json({ results: [] });
        signals.push(options.signal!);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => {
            bodyStarted = true;
            return body.promise;
          },
        } as Response;
      }),
    );
    const platform = service();
    await platform.restore();
    const listing = platform.listCloudTitles().catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(bodyStarted).toBe(true));
      await platform.signOut();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      body.resolve(JSON.stringify({ results: [] }));
      await listing;
    }
  });

  it("does not issue another retry after cancellation during backoff", async () => {
    vi.useFakeTimers();
    const reads: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (url.includes("/mru?")) return Response.json({ results: [] });
        reads.push(options.signal!);
        return new Response(null, {
          status: 503,
          headers: { "retry-after": "1" },
        });
      }),
    );
    const platform = service();
    await platform.restore();
    const listing = platform.listCloudTitles().catch((error: unknown) => error);
    await flush();
    expect(reads).toHaveLength(1);
    await platform.signOut();
    try {
      await vi.advanceTimersByTimeAsync(1100);
      expect(reads).toHaveLength(1);
    } finally {
      await vi.runAllTimersAsync();
      await listing;
    }
  });

  it("aborts hydration slots without starting fallback batches after sign-out", async () => {
    const hydration = deferred<Response>();
    const requests: AbortSignal[] = [];
    const rows = Array.from({ length: 800 }, (_, index) => ({
      titleId: `game-${index}`,
      details: { productId: `product-${index}` },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (!url.includes("catalog.gamepass.com"))
          return Response.json({ results: url.includes("/mru?") ? [] : rows });
        requests.push(options.signal!);
        return hydration.promise;
      }),
    );
    const platform = service();
    await platform.restore();
    const progress = vi.fn();
    const listing = platform
      .listCloudTitles(progress)
      .catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(4));
      await platform.signOut();
      expect(requests.every((signal) => signal.aborted)).toBe(true);
    } finally {
      hydration.resolve(new Response(null, { status: 413 }));
      await listing;
    }
    expect(requests).toHaveLength(4);
    expect(progress).not.toHaveBeenCalled();
  });

  it("keeps exchange retries inside the total negotiation deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (url.endsWith("/play")) return Response.json(session("active"));
        if (options.method === "POST") return Response.json({});
        return new Promise<Response>((resolve) =>
          setTimeout(
            () => resolve(new Response(null, { status: 503 })),
            NETWORK_POLICY.requestTimeoutMs - 100,
          ),
        );
      }),
    );
    const platform = service();
    await platform.restore();
    await platform.startSession({ source: "cloud", id: "game" }, 1080);
    let settled = false;
    const exchange = platform
      .exchangeIce(session("active").sessionPath, [])
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    try {
      await vi.advanceTimersByTimeAsync(NETWORK_POLICY.exchangeTimeoutMs + 1);
      expect(settled).toBe(true);
    } finally {
      await vi.runAllTimersAsync();
      await exchange;
    }
  });

  it("applies the request deadline while a response body is stalled", async () => {
    vi.useFakeTimers();
    const body = deferred<string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            text: () => body.promise,
          }) as Response,
      ),
    );
    const platform = service();
    await platform.restore();
    let settled = false;
    const creation = platform
      .startSession({ source: "cloud", id: "A" }, 1080)
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    try {
      await vi.advanceTimersByTimeAsync(NETWORK_POLICY.requestTimeoutMs + 1);
      expect(settled).toBe(true);
      expect(await creation).toMatchObject({ code: "XBOX_TIMEOUT" });
    } finally {
      body.resolve(JSON.stringify(session("A")));
      await flush();
    }
  });

  it("aborts an in-flight exchange when the active session is stopped", async () => {
    const body = deferred<string>();
    let reading = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (url.endsWith("/play")) return Response.json(session("active"));
        if (options.method === "DELETE")
          return new Response(null, { status: 204 });
        if (options.method === "POST") return Response.json({});
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => {
            reading = true;
            return body.promise;
          },
        } as Response;
      }),
    );
    const platform = service();
    await platform.restore();
    await platform.startSession({ source: "cloud", id: "A" }, 1080);
    const exchange = platform
      .exchangeIce(session("active").sessionPath, [])
      .catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(reading).toBe(true));
      await platform.stopSession(session("active").sessionPath);
      expect(await exchange).toMatchObject({ code: "OPERATION_CANCELLED" });
    } finally {
      body.resolve("{}");
      await exchange;
    }
  });

  it("stops unique search pagination at a finite useful page bound", async () => {
    let pages = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        pages++;
        return Response.json({
          Products: {},
          ...(pages < 512 ? { ContinuationToken: `page-${pages}` } : {}),
        });
      }),
    );
    const platform = service();
    await platform.restore();
    const result = await platform
      .searchCloudTitles("game")
      .catch((error: unknown) => error);
    expect(pages).toBeLessThanOrEqual(50);
    expect(result).toMatchObject({ code: "CATALOG_SEARCH_LIMIT" });
  });

  it.each([false, true])(
    "cleans late creation without deleting newer reused paths (reused=%s)",
    async (reusedPath) => {
      const creation = deferred<Response>();
      const deletes: string[] = [];
      const older = session("A");
      const newer = {
        ...session("B"),
        ...(reusedPath ? { sessionPath: older.sessionPath } : {}),
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, options: RequestInit) => {
          if (options.method === "DELETE") {
            deletes.push(url);
            return new Response(null, { status: 204 });
          }
          if (url.endsWith("/play"))
            return JSON.parse(String(options.body)).titleId === "A"
              ? creation.promise
              : Response.json(newer);
          return Response.json({});
        }),
      );
      const platform = service();
      await platform.restore();
      const cancellation = new AbortController();
      const start = platform.startSession.bind(platform) as (
        target: StreamTarget,
        resolution: 720 | 1080,
        operation: { signal: AbortSignal; deadline: number },
      ) => Promise<SessionStart>;
      const obsolete = start({ source: "cloud", id: "A" }, 1080, {
        signal: cancellation.signal,
        deadline: Date.now() + 1000,
      }).catch((error: unknown) => error);
      await flush();
      cancellation.abort();
      await platform.startSession({ source: "cloud", id: "B" }, 1080);
      creation.resolve(Response.json(older));
      expect(await obsolete).toMatchObject({ code: "OPERATION_CANCELLED" });
      await flush();
      expect(deletes).toHaveLength(reusedPath ? 0 : 1);
      await platform.stopSession(older.sessionPath, older.sessionId);
      expect(deletes).toHaveLength(reusedPath ? 0 : 1);
      await expect(
        platform.keepalive(newer.sessionPath),
      ).resolves.toBeUndefined();
    },
  );
});

function controller(
  startSession: PlatformService["startSession"],
  search?: PlatformService["searchCloudTitles"],
  overrides?: Partial<PlatformService>,
) {
  directory = mkdtempSync(join(tmpdir(), "afterglide-cancellation-"));
  const platform: PlatformService = {
    mock: true,
    hasStoredAuthentication: true,
    cloudAvailable: true,
    restore: async () => true,
    beginDeviceCode: async () => ({
      code: "synthetic",
      verificationUrl: "https://microsoft.com/link",
      expiresAt: Date.now() + 1000,
      message: "Synthetic",
    }),
    pollDeviceCode: async () => {},
    cancelAuthentication: () => {},
    signOut: async () => {},
    listCloudTitles: async () => [title("A"), title("B"), title("C")],
    searchCloudTitles: search,
    startSession,
    getSessionState: async () => ({ state: "Provisioned" }),
    authorizeSession: async () => {},
    exchangeSdp: async () => "{}",
    exchangeIce: async () => "[]",
    keepalive: async () => {},
    stopSession: vi.fn(async () => {}),
    ...overrides,
  };
  return new AppController(
    platform,
    new SettingsStore(join(directory, "settings.json")),
    {
      acceleration: "enabled",
      videoDecode: "enabled",
      gpu: "synthetic",
      secureStorage: true,
      credentialStorage: { backend: "Test", detail: "Synthetic" },
    },
    "test",
  );
}

describe("launch ownership after cancellation", () => {
  it("cleans an adapter creation returned after the deadline before timers fire", async () => {
    vi.useFakeTimers();
    const created = deferred<SessionStart>();
    const stop = vi.fn(async () => {});
    const app = controller(async () => created.promise, undefined, {
      stopSession: stop,
    });
    await app.initialize();
    const starting = app.startCloudStream("A").catch((error: unknown) => error);
    await flush();
    vi.setSystemTime(Date.now() + 180_001);
    created.resolve(session("A"));
    expect(await starting).toMatchObject({ code: "XBOX_TIMEOUT" });
    await flush();
    expect(stop).toHaveBeenCalledWith(session("A").sessionPath, "A");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot().session.phase).toBe("error");
  });

  it("does not let A's pending logout revoke B's newer successful sign-in", async () => {
    const deletion = deferred<void>();
    let signedIn = true;
    const revoke = vi.fn(async () => {
      signedIn = false;
    });
    const app = controller(async () => session("A"), undefined, {
      stopSession: async () => deletion.promise,
      signOut: revoke,
      beginDeviceCode: async () => ({
        code: "synthetic",
        verificationUrl: "https://microsoft.com/link",
        expiresAt: Date.now() + 1000,
        message: "Synthetic",
        internalDeviceCode: "synthetic-B",
      }),
      pollDeviceCode: async () => {
        signedIn = true;
      },
    });
    await app.initialize();
    await app.startCloudStream("A");
    const logout = app.signOut();
    await app.beginSignIn();
    await vi.waitFor(() =>
      expect(app.getSnapshot().auth.status).toBe("signed-in"),
    );
    deletion.resolve();
    await logout;
    expect(signedIn).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot().auth.status).toBe("signed-in");
  });

  it("revokes local authentication even if remote session cleanup fails", async () => {
    const revoke = vi.fn(async () => {});
    const app = controller(async () => session("A"), undefined, {
      signOut: revoke,
      stopSession: async () => {
        throw new Error("Synthetic deletion failure");
      },
    });
    await app.initialize();
    await app.startCloudStream("A");
    await app.signOut().catch(() => {});
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(app.getSnapshot().auth.status).toBe("signed-out");
    expect(app.getSnapshot().session.phase).toBe("idle");
  });

  it("cancels a cleared search even when the platform ignores its abort signal", async () => {
    const results = deferred<ReturnType<typeof title>[]>();
    let signal: AbortSignal | undefined;
    const app = controller(
      async () => session("active"),
      async (_query, operation) => {
        signal = operation?.signal;
        return results.promise;
      },
    );
    await app.initialize();
    const searching = app.searchCloudTitles("old");
    app.cancelCloudSearch();
    expect(signal?.aborted).toBe(true);
    results.resolve([title("obsolete-match")]);
    expect(await searching).toEqual([]);
    expect(
      app
        .getSnapshot()
        .cloud.titles.some((game) => game.id === "obsolete-match"),
    ).toBe(false);
  });

  it("includes a stalled session creation in the complete provisioning budget", async () => {
    vi.useFakeTimers();
    const created = deferred<SessionStart>();
    const app = controller(async () => created.promise);
    await app.initialize();
    const starting = app.startCloudStream("A").catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(180_001);
      expect(app.getSnapshot().session.phase).toBe("error");
      expect(await starting).toMatchObject({ code: "XBOX_TIMEOUT" });
    } finally {
      created.resolve(session("A"));
      await starting;
    }
  });

  it("supersedes obsolete search results without merging them into the library", async () => {
    const older = deferred<ReturnType<typeof title>[]>();
    const app = controller(
      async () => session("active"),
      async (query) => (query === "old" ? older.promise : [title("new-match")]),
    );
    await app.initialize();
    const obsolete = app.searchCloudTitles("old");
    await app.searchCloudTitles("new");
    older.resolve([title("obsolete-match")]);
    expect(await obsolete).toEqual([]);
    expect(
      app
        .getSnapshot()
        .cloud.titles.some((game) => game.id === "obsolete-match"),
    ).toBe(false);
  });

  it("allows B to launch immediately while cancelled A creation is still pending", async () => {
    const firstCreation = deferred<SessionStart>();
    const app = controller(async (target) =>
      target.id === "A" ? firstCreation.promise : session(target.id),
    );
    await app.initialize();
    const first = app.startCloudStream("A").catch((error: unknown) => error);
    await app.stopStream();
    try {
      const second = await app
        .startCloudStream("B")
        .catch((error: unknown) => error);
      expect(second).toMatchObject({ sessionId: "B", targetId: "B" });
      expect(app.getSnapshot().session.sessionId).toBe("B");
    } finally {
      firstCreation.resolve(session("A"));
      await first;
    }
    expect(app.getSnapshot().session.sessionId).toBe("B");
  });

  it("does not let A's late finally release B's launch lock", async () => {
    const firstCreation = deferred<SessionStart>();
    const secondCreation = deferred<SessionStart>();
    const app = controller(async (target) =>
      target.id === "A"
        ? firstCreation.promise
        : target.id === "B"
          ? secondCreation.promise
          : session("C"),
    );
    await app.initialize();
    const first = app.startCloudStream("A").catch((error: unknown) => error);
    await app.stopStream();
    const second = app.startCloudStream("B").catch((error: unknown) => error);
    try {
      firstCreation.resolve(session("A"));
      await first;
      await expect(app.startCloudStream("C")).rejects.toThrow(
        /current stream|connection.*finishing/i,
      );
    } finally {
      secondCreation.resolve(session("B"));
      await second;
    }
    expect(app.getSnapshot().session.sessionId).toBe("B");
  });
});
