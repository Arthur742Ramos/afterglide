interface StreamingTokenPort<T> {
  getGssvToken(): Promise<{ data: { Token: string } } | undefined>;
  getStreamToken(token: string, offering: string): Promise<T>;
}

// Preserve console access when both cloud offerings are unavailable. Stable
// xal-node omits the unused npm dependency but its combined helper rejects
// that case; the original app treated cloud eligibility as optional.
export async function getStreamingTokens<T>(
  msal: StreamingTokenPort<T>,
): Promise<{
  xHomeToken: T;
  xCloudToken?: T;
}> {
  const token = await msal.getGssvToken();
  if (!token) throw new Error("Sign in before requesting streaming access.");
  const xHomeToken = await msal.getStreamToken(token.data.Token, "xhome");
  let xCloudToken: T | undefined;
  try {
    xCloudToken = await msal.getStreamToken(token.data.Token, "xgpuweb");
  } catch {
    try {
      xCloudToken = await msal.getStreamToken(token.data.Token, "xgpuwebf2p");
    } catch {
      // Cloud eligibility must not prevent console remote play.
    }
  }
  return { xHomeToken, xCloudToken };
}
