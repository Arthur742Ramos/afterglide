import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Msal } from "xal-node";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));
import { LivePlatformService } from "../../src/main/live-platform-service";
import { SecureTokenStore } from "../../src/main/secure-token-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const cloudToken = {
  gsToken: "synthetic-cloud",
  market: "US",
  durationInSeconds: 3600,
  offeringSettings: {
    regions: [{ baseUri: "https://test.xboxlive.com", isDefault: true }],
  },
};
function userToken(name: string) {
  return {
    access_token: `synthetic-${name}`,
    refresh_token: `synthetic-refresh-${name}`,
    expires_in: 3600,
  };
}

describe("authentication attempt ownership", () => {
  let directory: string;
  let path: string;
  let store: SecureTokenStore;
  let platform: LivePlatformService;
  let nextCode: number;
  let polls: Map<
    string,
    ReturnType<typeof deferred<ReturnType<typeof userToken>>>
  >;
  const sdkPoll = Msal.prototype.doPollForDeviceCodeAuth;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "afterglide-auth-ownership-"));
    path = join(directory, "credentials.enc");
    store = new SecureTokenStore(path);
    nextCode = 0;
    polls = new Map();
    vi.spyOn(Msal.prototype, "doDeviceCodeAuth").mockImplementation(
      async () => {
        const deviceCode = `code-${++nextCode}`;
        polls.set(deviceCode, deferred());
        return {
          device_code: deviceCode,
          user_code: "SYNTHETIC",
          verification_uri: "https://microsoft.com/link",
          expires_in: 900,
          interval: 1,
          message: "Synthetic sign-in",
        };
      },
    );
    // Keep the actual SDK polling implementation, including its synchronous
    // removeAll -> setUserToken -> save sequence. Only replace HTTP transport.
    vi.spyOn(Msal.prototype, "doPollForDeviceCodeAuth").mockImplementation(
      function (this: Msal, code, timeout) {
        const client = this as unknown as {
          _httpClient: { postRequest: () => Promise<{ body: () => unknown }> };
        };
        client._httpClient.postRequest = async () => {
          const value = await polls.get(code)!.promise;
          return { body: () => value };
        };
        return sdkPoll.call(this, code, timeout);
      },
    );
    vi.spyOn(Msal.prototype, "getGssvToken").mockResolvedValue({
      data: { Token: "synthetic-gssv" },
    } as never);
    vi.spyOn(Msal.prototype, "getStreamToken").mockResolvedValue({
      data: cloudToken,
    } as never);
    platform = new LivePlatformService(store);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  async function begin() {
    const code = (await platform.beginDeviceCode()) as unknown as {
      internalDeviceCode: string;
    };
    return code.internalDeviceCode;
  }
  function persistedUser() {
    const restored = new SecureTokenStore(path);
    restored.load();
    return restored.getUserToken()?.data.access_token;
  }

  it("keeps newer B credentials when cancelled A completes its SDK writes late", async () => {
    const a = await begin();
    const first = platform
      .pollDeviceCode(a, 1000)
      .catch((error: unknown) => error);
    platform.cancelAuthentication();
    const b = await begin();
    const second = platform.pollDeviceCode(b, 1000);
    polls.get(b)!.resolve(userToken("B"));
    await second;
    polls.get(a)!.resolve(userToken("A"));
    expect(await first).toMatchObject({ code: "AUTH_CANCELLED" });
    expect(store.getUserToken()?.data.access_token).toBe("synthetic-B");
    expect(persistedUser()).toBe("synthetic-B");
    expect(platform.cloudAvailable).toBe(true);
  });

  it("does not persist a login cancelled while cloud eligibility is pending", async () => {
    const offering = deferred<{ data: typeof cloudToken }>();
    vi.mocked(Msal.prototype.getStreamToken).mockReturnValue(
      offering.promise as never,
    );
    const a = await begin();
    const polling = platform
      .pollDeviceCode(a, 1000)
      .catch((error: unknown) => error);
    polls.get(a)!.resolve(userToken("A"));
    await vi.waitFor(() =>
      expect(Msal.prototype.getStreamToken).toHaveBeenCalled(),
    );
    platform.cancelAuthentication();
    offering.resolve({ data: cloudToken });
    expect(await polling).toMatchObject({ code: "AUTH_CANCELLED" });
    expect(store.getUserToken()).toBeUndefined();
    expect(persistedUser()).toBeUndefined();
    expect(platform.cloudAvailable).toBe(false);
  });

  it("does not repopulate credentials after sign-out interrupts an SDK poll", async () => {
    const a = await begin();
    const polling = platform
      .pollDeviceCode(a, 1000)
      .catch((error: unknown) => error);
    await platform.signOut();
    polls.get(a)!.resolve(userToken("A"));
    expect(await polling).toMatchObject({ code: "AUTH_CANCELLED" });
    expect(store.getUserToken()).toBeUndefined();
    expect(persistedUser()).toBeUndefined();
  });

  it("rejects an obsolete device code before giving it the new attempt's owner", async () => {
    const a = await begin();
    const b = await begin();
    const stale = platform
      .pollDeviceCode(a, 1000)
      .catch((error: unknown) => error);
    polls.get(a)!.resolve(userToken("A"));
    expect(await stale).toMatchObject({ code: "AUTH_CANCELLED" });
    const current = platform.pollDeviceCode(b, 1000);
    polls.get(b)!.resolve(userToken("B"));
    await current;
    expect(persistedUser()).toBe("synthetic-B");
  });

  it("ignores the actual SDK refresh writes after sign-out", async () => {
    const refresh = deferred<ReturnType<typeof userToken>>();
    store.loadJson(JSON.stringify({ userToken: userToken("stored") }));
    store.save();
    vi.mocked(Msal.prototype.getGssvToken).mockImplementation(async function (
      this: Msal,
    ) {
      const client = this as unknown as {
        _httpClient: { postRequest: () => Promise<{ body: () => unknown }> };
      };
      client._httpClient.postRequest = async () => {
        const value = await refresh.promise;
        return { body: () => value };
      };
      await this.refreshUserToken();
      return { data: { Token: "synthetic-gssv" } } as never;
    });
    const restoring = platform.restore();
    await platform.signOut();
    refresh.resolve(userToken("refreshed"));
    expect(await restoring).toBe(false);
    expect(store.getUserToken()).toBeUndefined();
    expect(persistedUser()).toBeUndefined();
    expect(platform.cloudAvailable).toBe(false);
  });

  it("restores the current encrypted session and its legitimate SDK refresh", async () => {
    store.loadJson(JSON.stringify({ userToken: userToken("stored") }));
    store.save();
    vi.mocked(Msal.prototype.getGssvToken).mockImplementation(async function (
      this: Msal,
    ) {
      const client = this as unknown as {
        _httpClient: { postRequest: () => Promise<{ body: () => unknown }> };
      };
      client._httpClient.postRequest = async () => ({
        body: () => userToken("refreshed"),
      });
      await this.refreshUserToken();
      return { data: { Token: "synthetic-gssv" } } as never;
    });
    expect(await platform.restore()).toBe(true);
    expect(persistedUser()).toBe("synthetic-refreshed");
    expect(platform.cloudAvailable).toBe(true);
  });

  it("preserves the previous stored account when publishing a new login fails", async () => {
    store.loadJson(JSON.stringify({ userToken: userToken("stored") }));
    store.save();
    vi.spyOn(store, "save").mockImplementation(() => {
      throw new Error("Synthetic storage failure");
    });
    const a = await begin();
    const polling = platform.pollDeviceCode(a, 1000);
    polls.get(a)!.resolve(userToken("A"));
    await expect(polling).rejects.toThrow("Synthetic storage failure");
    expect(store.getUserToken()?.data.access_token).toBe("synthetic-stored");
    expect(persistedUser()).toBe("synthetic-stored");
  });

  it("revokes a previous-account refresh that started while the new login was pending", async () => {
    const refresh = deferred<ReturnType<typeof userToken>>();
    store.loadJson(JSON.stringify({ userToken: userToken("stored") }));
    store.save();
    const b = await begin();
    vi.mocked(Msal.prototype.getGssvToken).mockImplementationOnce(
      async function (this: Msal) {
        const client = this as unknown as {
          _httpClient: { postRequest: () => Promise<{ body: () => unknown }> };
        };
        client._httpClient.postRequest = async () => {
          const value = await refresh.promise;
          return { body: () => value };
        };
        await this.refreshUserToken();
        return { data: { Token: "synthetic-gssv" } } as never;
      },
    );
    const restoring = platform.restore();
    const polling = platform.pollDeviceCode(b, 1000);
    polls.get(b)!.resolve(userToken("B"));
    await polling;
    refresh.resolve(userToken("old-account-refreshed"));
    expect(await restoring).toBe(false);
    expect(store.getUserToken()?.data.access_token).toBe("synthetic-B");
    expect(persistedUser()).toBe("synthetic-B");
    expect(platform.cloudAvailable).toBe(true);
  });
});
