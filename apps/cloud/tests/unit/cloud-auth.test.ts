import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudTitle } from "../../src/shared/contracts";
import type { SecureTokenStore } from "../../src/main/secure-token-store";

const auth = vi.hoisted(() => ({
  getGssvToken: vi.fn(),
  getStreamToken: vi.fn(),
  getStreamingTokens: vi.fn(),
  getWebToken: vi.fn(),
}));
vi.mock("xal-node", () => ({
  Msal: class {
    getGssvToken = auth.getGssvToken;
    getStreamToken = auth.getStreamToken;
    getStreamingTokens = auth.getStreamingTokens;
    getWebToken = auth.getWebToken;
  },
}));
import { LivePlatformService } from "../../src/main/live-platform-service";

const token = {
  gsToken: "test-cloud-token",
  market: "US",
  durationInSeconds: 3600,
  offeringSettings: {
    regions: [{ baseUri: "https://test.xboxlive.com", isDefault: true }],
  },
};
function service() {
  return new LivePlatformService({
    load: vi.fn(),
    getUserToken: () => ({}),
    removeAll: vi.fn(),
  } as unknown as SecureTokenStore);
}
beforeEach(() => {
  vi.resetAllMocks();
  auth.getGssvToken.mockResolvedValue({ data: { Token: "test-gssv" } });
  auth.getStreamToken.mockResolvedValue({ data: token });
});
describe("cloud-only service authentication", () => {
  it("searches an unloaded game, follows search pages and excludes non-cloud products", async () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      titleId: `title-${index}`,
      details: { productId: `product-${index}` },
    }));
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pages: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.includes("/search/v2?")) {
          pages.push(init);
          expect(url).toContain("hydration=RemoteLowJade0");
          expect(new Headers(init.headers).get("ms-cv")).toMatch(
            /^[A-Za-z0-9+/]{22}\.0$/,
          );
          expect(JSON.parse(String(init.body))).toMatchObject({
            Query: "late",
            DeviceFamilies: ["Windows.Xbox"],
            ProductFamilies: ["games"],
          });
          return pages.length === 1
            ? Response.json({
                Products: { foreign: { ProductTitle: "Late foreign" } },
                ContinuationToken: "next",
              })
            : Response.json({
                Products: {
                  "product-199": {
                    ProductTitle: "Late cloud game",
                    Image_Tile: {
                      URL: "https://store-images.s-microsoft.com/image/late",
                    },
                  },
                },
              });
        }
        if (!url.startsWith("https://catalog.gamepass.com/"))
          return Response.json({ results: url.includes("/mru?") ? [] : rows });
        const ids = JSON.parse(String(init.body)).Products as string[];
        if (!ids.includes("product-0")) await delayed;
        return Response.json({
          Products: Object.fromEntries(
            ids.map((id) => [id, { ProductTitle: `Game ${id}` }]),
          ),
        });
      }),
    );
    try {
      const platform = service();
      await platform.restore();
      const progress = vi.fn();
      const listing = platform.listCloudTitles(progress);
      await vi.waitFor(() => expect(progress).toHaveBeenCalled());
      expect(progress.mock.calls[0][0]).toHaveLength(25);
      const matches = await platform.searchCloudTitles("late");
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        id: "title-199",
        name: "Late cloud game",
      });
      expect(new Headers(pages[1].headers).get("x-ms-ct")).toBe("next");
      finish();
      expect(
        (await listing).find((title) => title.id === "title-199")?.name,
      ).toBe("Late cloud game");
    } finally {
      finish();
      vi.unstubAllGlobals();
    }
  });

  it("shows hydrated games while a later catalog batch is still pending", async () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      titleId: `title-${index}`,
      details: { productId: `product-${index}` },
    }));
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (!url.startsWith("https://catalog.gamepass.com/"))
          return Response.json({ results: url.includes("/mru?") ? [] : rows });
        const ids = JSON.parse(String(init.body)).Products as string[];
        if (!ids.includes("product-0")) await delayed;
        return Response.json({
          Products: Object.fromEntries(
            ids.map((id) => [
              id,
              {
                ProductTitle: `Game ${id}`,
                Image_Tile: {
                  URL: `https://store-images.s-microsoft.com/image/${id}`,
                },
              },
            ]),
          ),
        });
      }),
    );
    try {
      const platform = service();
      await platform.restore();
      const updates: CloudTitle[][] = [];
      let completed = false;
      const result = platform
        .listCloudTitles((titles) => updates.push(titles))
        .then((titles) => {
          completed = true;
          return titles;
        });
      await vi.waitFor(() => expect(updates[0]).toHaveLength(25));
      expect(completed).toBe(false);
      expect(
        updates[0].every(
          (title) => title.imageUrl && title.name.startsWith("Game "),
        ),
      ).toBe(true);
      finish();
      expect(await result).toHaveLength(200);
      expect(updates.at(-1)).toHaveLength(200);
    } finally {
      finish();
      vi.unstubAllGlobals();
    }
  });

  it("recovers names and artwork when the catalog rejects a bulk response", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      titleId: `title-${index}`,
      details: { productId: `store-${index}` },
    }));
    const request = vi
      .fn()
      .mockImplementation(async (url: string, init: RequestInit) => {
        if (!url.startsWith("https://catalog.gamepass.com/"))
          return Response.json({ results: url.includes("/mru?") ? [] : rows });
        const ids = JSON.parse(String(init.body)).Products as string[];
        if (ids.length > 25) return new Response(null, { status: 413 });
        return Response.json({
          Products: Object.fromEntries(
            ids.map((id) => [
              id,
              {
                ProductTitle: `Game ${id}`,
                Image_Tile: {
                  URL: `https://store-images.s-microsoft.com/image/${id}`,
                },
              },
            ]),
          ),
        });
      });
    vi.stubGlobal("fetch", request);
    try {
      const platform = service();
      await platform.restore();
      const titles = await platform.listCloudTitles();
      expect(titles.filter((title) => title.imageUrl)).toHaveLength(100);
      expect(
        titles.filter((title) => title.name.startsWith("Xbox Cloud Game ")),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not retry cloud session creation when the service is transiently unavailable", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", request);
    try {
      const platform = service();
      await platform.restore();
      await expect(
        platform.startSession({ source: "cloud", id: "game" }, 1080),
      ).rejects.toMatchObject({ code: "XBOX_HTTP_503" });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hydrates a large catalog without losing artwork to a burst limit", async () => {
    const rows = Array.from({ length: 800 }, (_, index) => ({
      titleId: `title-${index}`,
      details: { productId: `product-${index}` },
    }));
    let active = 0;
    const request = vi
      .fn()
      .mockImplementation(async (url: string, init: RequestInit) => {
        if (!url.startsWith("https://catalog.gamepass.com/"))
          return Response.json({ results: url.includes("/mru?") ? [] : rows });
        if (active >= 4)
          return new Response(null, {
            status: 429,
            headers: { "retry-after": "0" },
          });
        active += 1;
        try {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const ids = JSON.parse(String(init.body)).Products as string[];
          return Response.json({
            Products: Object.fromEntries(
              ids.map((id) => [
                id,
                {
                  ProductTitle: `Game ${id}`,
                  Image_Tile: {
                    URL: `https://store-images.s-microsoft.com/image/${id}`,
                  },
                },
              ]),
            ),
          });
        } finally {
          active -= 1;
        }
      });
    vi.stubGlobal("fetch", request);
    try {
      const platform = service();
      await platform.restore();
      const titles = await platform.listCloudTitles();
      expect(titles).toHaveLength(800);
      expect(titles.filter((title) => title.imageUrl)).toHaveLength(800);
      expect(
        titles.filter((title) => title.name.startsWith("Xbox Cloud Game ")),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries a transient read-only catalog POST without losing its artwork", async () => {
    let catalogCalls = 0;
    const request = vi.fn().mockImplementation(async (url: string) => {
      if (!url.startsWith("https://catalog.gamepass.com/"))
        return Response.json({
          results: [{ titleId: "game", details: { productId: "store" } }],
        });
      if (catalogCalls++ === 0)
        return new Response(null, {
          status: 429,
          headers: { "retry-after": "0" },
        });
      return Response.json({
        Products: {
          store: {
            ProductTitle: "Recovered game",
            Image_Tile: {
              URL: "https://store-images.s-microsoft.com/image/game",
            },
          },
        },
      });
    });
    vi.stubGlobal("fetch", request);
    try {
      const platform = service();
      await platform.restore();
      expect(await platform.listCloudTitles()).toEqual([
        expect.objectContaining({
          name: "Recovered game",
          imageUrl: "https://store-images.s-microsoft.com/image/game",
        }),
      ]);
      expect(catalogCalls).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retains keyed catalog Store IDs so live title names and artwork are joined", async () => {
    const request = vi.fn().mockImplementation(async (url: string) =>
      Response.json(
        url.startsWith("https://catalog.gamepass.com/")
          ? {
              Products: {
                BT5P2X999VH2: {
                  ProductTitle: "Fortnite",
                  PublisherName: "Epic Games Inc.",
                  XCloudTitleId: null,
                  Image_Tile: {
                    URL: "//store-images.s-microsoft.com/image/fortnite",
                  },
                },
              },
            }
          : {
              results: [
                {
                  titleId: "FORTNITE",
                  details: { productId: "BT5P2X999VH2" },
                },
              ],
            },
      ),
    );
    vi.stubGlobal("fetch", request);
    try {
      const platform = service();
      await platform.restore();
      const titles = await platform.listCloudTitles();
      expect(titles).toEqual([
        expect.objectContaining({
          id: "FORTNITE",
          name: "Fortnite",
          publisher: "Epic Games Inc.",
          imageUrl: "https://store-images.s-microsoft.com/image/fortnite",
        }),
      ]);
      expect(
        request.mock.calls.find(([url]) => url.includes("catalog"))?.[1],
      ).toMatchObject({ body: JSON.stringify({ Products: ["BT5P2X999VH2"] }) });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends the host OS and bundled Chromium versions to the cloud library", async () => {
    const systemVersion = Object.getOwnPropertyDescriptor(
      process,
      "getSystemVersion",
    );
    const chromeVersion = Object.getOwnPropertyDescriptor(
      process.versions,
      "chrome",
    );
    Object.defineProperty(process, "getSystemVersion", {
      configurable: true,
      value: () => "27.2",
    });
    Object.defineProperty(process.versions, "chrome", {
      configurable: true,
      value: "150.0.7800.0",
    });
    const request = vi
      .fn()
      .mockImplementation(async () => Response.json({ results: [] }));
    vi.stubGlobal("fetch", request);
    try {
      const platform = service();
      await platform.restore();
      await platform.listCloudTitles();
      expect(request).toHaveBeenCalledTimes(2);
      for (const [, options] of request.mock.calls) {
        const metadata = JSON.parse(options.headers["X-MS-Device-Info"]);
        expect(metadata.dev.os).toMatchObject({
          name:
            process.platform === "darwin"
              ? "macos"
              : process.platform === "win32"
                ? "windows"
                : "linux",
          ver: "27.2",
        });
        expect(metadata.dev.browser.browserVersion).toBe("150.0.7800.0");
      }
    } finally {
      vi.unstubAllGlobals();
      if (systemVersion)
        Object.defineProperty(process, "getSystemVersion", systemVersion);
      else Reflect.deleteProperty(process, "getSystemVersion");
      if (chromeVersion)
        Object.defineProperty(process.versions, "chrome", chromeVersion);
      else Reflect.deleteProperty(process.versions, "chrome");
    }
  });

  it("restores without requesting xHome or Smartglass web credentials", async () => {
    const platform = service();
    expect(await platform.restore()).toBe(true);
    expect(platform.cloudAvailable).toBe(true);
    expect(auth.getStreamToken).toHaveBeenCalledWith("test-gssv", "xgpuweb");
    expect(auth.getStreamingTokens).not.toHaveBeenCalled();
    expect(auth.getWebToken).not.toHaveBeenCalled();
  });
  it("uses the library's free-to-play fallback when the standard offering is unavailable", async () => {
    auth.getStreamToken.mockRejectedValueOnce(new Error("Unavailable"));
    const platform = service();
    expect(await platform.restore()).toBe(true);
    expect(platform.cloudAvailable).toBe(true);
    expect(auth.getStreamToken.mock.calls.map((call) => call[1])).toEqual([
      "xgpuweb",
      "xgpuwebf2p",
    ]);
  });
  it("keeps signed-in account state when cloud eligibility is unavailable", async () => {
    auth.getStreamToken.mockRejectedValue(new Error("Unavailable"));
    const platform = service();
    expect(await platform.restore()).toBe(true);
    expect(platform.cloudAvailable).toBe(false);
    expect(auth.getWebToken).not.toHaveBeenCalled();
  });
  it("does not restore a cloud token after sign-out interrupts a refresh", async () => {
    let finish!: (value: { data: typeof token }) => void;
    auth.getStreamToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const platform = service();
    const restoring = platform.restore();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await platform.signOut();
    finish({ data: token });
    await restoring;
    expect(platform.cloudAvailable).toBe(false);
  });
});
