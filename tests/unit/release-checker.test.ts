import { describe, expect, it, vi } from "vitest";
import {
  GitHubReleaseChecker,
  isAfterglideReleaseUrl,
  parseVersion,
  selectRelease,
} from "../../src/main/release-checker";

const release = (
  tag: string,
  options: { draft?: boolean; prerelease?: boolean; url?: string } = {},
) => ({
  tag_name: tag,
  html_url:
    options.url ??
    `https://github.com/Arthur742Ramos/afterglide/releases/tag/${tag}`,
  published_at: "2026-09-13T12:00:00Z",
  draft: options.draft ?? false,
  prerelease: options.prerelease ?? tag.includes("-"),
});

describe("release checker", () => {
  it("parses SemVer and selects the newest release for a prerelease build", () => {
    expect(parseVersion("v0.3.0-alpha.10")?.prerelease).toEqual(["alpha", 10]);
    expect(
      selectRelease("0.3.0-alpha.1", [
        release("v0.2.0"),
        release("v0.3.0-alpha.2"),
        release("v0.3.0-alpha.10"),
      ]),
    ).toMatchObject({
      version: "0.3.0-alpha.10",
      releaseUrl:
        "https://github.com/Arthur742Ramos/afterglide/releases/tag/v0.3.0-alpha.10",
    });
  });

  it("keeps stable builds on stable releases and ignores drafts", () => {
    expect(
      selectRelease("0.3.0", [
        release("v0.4.0-alpha.1"),
        release("v0.5.0-alpha.1", { prerelease: false }),
        release("v0.3.1", { draft: true }),
        release("v0.3.0"),
      ]),
    ).toBeNull();
    expect(selectRelease("0.3.0", [release("v0.3.1")])?.version).toBe("0.3.1");
  });

  it("accepts only the project’s canonical GitHub release paths", () => {
    expect(
      isAfterglideReleaseUrl(
        "https://github.com/Arthur742Ramos/afterglide/releases/tag/v0.3.0",
      ),
    ).toBe(true);
    expect(
      isAfterglideReleaseUrl(
        "https://github.com/Arthur742Ramos/afterglide/issues/1",
      ),
    ).toBe(false);
    expect(
      isAfterglideReleaseUrl(
        "https://github.com.evil.test/Arthur742Ramos/afterglide/releases/latest",
      ),
    ).toBe(false);
  });

  it("returns bounded, user-safe network states", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify([release("v0.3.0-alpha.2")]), {
          status: 200,
        }),
    );
    const checker = new GitHubReleaseChecker(request as typeof fetch);
    await expect(checker.check("0.3.0-alpha.1")).resolves.toMatchObject({
      status: "available",
      version: "0.3.0-alpha.2",
    });

    const failed = new GitHubReleaseChecker(
      vi.fn(async () => new Response("nope", { status: 503 })) as typeof fetch,
    );
    await expect(failed.check("0.3.0-alpha.1")).resolves.toMatchObject({
      status: "error",
      error: "Couldn’t check GitHub for updates. Try again when you’re online.",
    });
  });
});
