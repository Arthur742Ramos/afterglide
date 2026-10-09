import { describe, expect, it, vi } from "vitest";
import { getStreamingTokens } from "../../src/main/streaming-tokens";

function port() {
  return {
    getGssvToken: vi
      .fn()
      .mockResolvedValue({ data: { Token: "synthetic-gssv" } }),
    getStreamToken: vi.fn().mockImplementation(async (_token, offering) => ({
      offering,
    })),
  };
}

describe("original app streaming eligibility", () => {
  it("retains home and standard cloud access", async () => {
    const msal = port();
    expect(await getStreamingTokens(msal)).toEqual({
      xHomeToken: { offering: "xhome" },
      xCloudToken: { offering: "xgpuweb" },
    });
    expect(msal.getStreamToken.mock.calls.map((call) => call[1])).toEqual([
      "xhome",
      "xgpuweb",
    ]);
  });

  it("retains the free-to-play fallback", async () => {
    const msal = port();
    msal.getStreamToken
      .mockResolvedValueOnce({ offering: "xhome" })
      .mockRejectedValueOnce(new Error("Standard cloud unavailable"));
    expect(await getStreamingTokens(msal)).toMatchObject({
      xCloudToken: { offering: "xgpuwebf2p" },
    });
  });

  it("retains console access when neither cloud offering is available", async () => {
    const msal = port();
    msal.getStreamToken
      .mockResolvedValueOnce({ offering: "xhome" })
      .mockRejectedValueOnce(new Error("Standard cloud unavailable"))
      .mockRejectedValueOnce(new Error("Free-to-play cloud unavailable"));
    expect(await getStreamingTokens(msal)).toEqual({
      xHomeToken: { offering: "xhome" },
      xCloudToken: undefined,
    });
  });

  it("preserves a failed home request and stops further requests", async () => {
    const msal = port();
    msal.getStreamToken.mockRejectedValueOnce(new Error("Home unavailable"));
    await expect(getStreamingTokens(msal)).rejects.toThrow("Home unavailable");
    expect(msal.getStreamToken).toHaveBeenCalledTimes(1);
  });

  it("does not request offerings without a GSSV token", async () => {
    const msal = port();
    msal.getGssvToken.mockResolvedValue(undefined);
    await expect(getStreamingTokens(msal)).rejects.toThrow("Sign in");
    expect(msal.getStreamToken).not.toHaveBeenCalled();
  });
});
