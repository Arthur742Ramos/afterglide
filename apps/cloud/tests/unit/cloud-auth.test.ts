import { beforeEach, describe, expect, it, vi } from "vitest";
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
