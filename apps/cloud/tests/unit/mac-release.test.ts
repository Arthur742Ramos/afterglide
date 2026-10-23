import { describe, expect, it } from "vitest";
// @ts-expect-error Node release script has no TypeScript declarations.
import { validateReleaseIdentity } from "../../scripts/verify-mac-release.mjs";

const identity = {
  version: "0.1.0-beta.1",
  tag: "cloud-v0.1.0-beta.1",
  commit: "b".repeat(40),
  actualVersion: "0.1.0-beta.1",
  actualIdentifier: "io.github.Arthur742Ramos.AfterglideCloud",
  arch: "arm64",
  metadata:
    "Identifier=io.github.Arthur742Ramos.AfterglideCloud\nAuthority=Developer ID Application: Arthur Freitas Ramos (72GY62F838)\nTeamIdentifier=72GY62F838\nCodeDirectory v=20500 flags=0x10000(runtime)\nTimestamp=Oct 23, 2026 at 1:00:00 AM\n",
  assessment: "app: accepted\nsource=Notarized Developer ID",
};
describe("official Mac release identity", () => {
  it("accepts only the reviewed beta identity and notarized publisher", () => {
    expect(() => validateReleaseIdentity(identity)).not.toThrow();
  });
  it.each([
    { tag: "v0.1.0-beta.1" },
    { version: "0.1.0" },
    { commit: "main" },
    { actualVersion: "0.1.0-alpha.1" },
    { arch: "x86_64" },
    { actualIdentifier: "io.github.Arthur742Ramos.Afterglide" },
    {
      metadata: identity.metadata.replace(
        "Developer ID Application",
        "Apple Development",
      ),
    },
    { metadata: identity.metadata.replaceAll("72GY62F838", "OTHERTEAM1") },
    { metadata: identity.metadata.replace("(runtime)", "(none)") },
    { metadata: identity.metadata.replace(/Timestamp=.*\n/, "") },
    { assessment: "app: accepted\nsource=Developer ID" },
    { metadata: identity.metadata + "Signature=adhoc\n" },
  ])("rejects mismatched or unqualified release evidence: %j", (change) => {
    expect(() => validateReleaseIdentity({ ...identity, ...change })).toThrow();
  });
});
