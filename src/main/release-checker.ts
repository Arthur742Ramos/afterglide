import type { UpdateSnapshot } from "../shared/contracts";

const RELEASES_URL =
  "https://api.github.com/repos/Arthur742Ramos/afterglide/releases?per_page=20";
const MAX_RESPONSE_BYTES = 512_000;

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

interface ParsedVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

export interface ReleaseCheckPort {
  check(currentVersion: string): Promise<UpdateSnapshot>;
}

export class GitHubReleaseChecker implements ReleaseCheckPort {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 5_000,
  ) {}

  async check(currentVersion: string): Promise<UpdateSnapshot> {
    const checkedAt = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.request(RELEASES_URL, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": `Afterglide/${currentVersion}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok)
        throw new Error(`GitHub returned HTTP ${response.status}.`);
      const body = await response.text();
      if (body.length > MAX_RESPONSE_BYTES)
        throw new Error("The release response was unexpectedly large.");
      const releases = JSON.parse(body) as unknown;
      const update = selectRelease(currentVersion, releases);
      return update
        ? { status: "available", checkedAt, ...update }
        : { status: "current", checkedAt };
    } catch (error) {
      return {
        status: "error",
        checkedAt,
        error:
          error instanceof Error && error.name === "AbortError"
            ? "The update check timed out. Try again when you’re online."
            : "Couldn’t check GitHub for updates. Try again when you’re online.",
      };
    }
  }
}

export function selectRelease(
  currentVersion: string,
  value: unknown,
): Pick<UpdateSnapshot, "version" | "releaseUrl" | "publishedAt"> | null {
  const current = parseVersion(currentVersion);
  if (!current || !Array.isArray(value)) return null;
  const includePrereleases = current.prerelease.length > 0;
  const candidates = value
    .filter((item): item is GitHubRelease =>
      Boolean(item && typeof item === "object"),
    )
    .filter(
      (release) =>
        release.draft !== true &&
        (includePrereleases || release.prerelease !== true) &&
        typeof release.tag_name === "string" &&
        typeof release.html_url === "string" &&
        isAfterglideReleaseUrl(release.html_url),
    )
    .map((release) => ({
      release,
      version: parseVersion(release.tag_name as string),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        release: GitHubRelease & { tag_name: string; html_url: string };
        version: ParsedVersion;
      } => Boolean(candidate.version),
    )
    .filter(
      (candidate) =>
        includePrereleases || candidate.version.prerelease.length === 0,
    )
    .sort((left, right) => compareVersions(right.version, left.version));
  const latest = candidates[0];
  if (!latest || compareVersions(latest.version, current) <= 0) return null;
  return {
    version: latest.version.raw,
    releaseUrl: latest.release.html_url,
    publishedAt:
      typeof latest.release.published_at === "string"
        ? latest.release.published_at
        : undefined,
  };
}

export function parseVersion(value: string): ParsedVersion | null {
  const match = value
    .trim()
    .match(
      /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
  if (!match) return null;
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4]
          .split(".")
          .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (right.prerelease.length === 0 && left.prerelease.length > 0) return -1;
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index += 1
  ) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "string")
      return -1;
    if (typeof leftPart === "string" && typeof rightPart === "number") return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function isAfterglideReleaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      /^\/Arthur742Ramos\/afterglide\/releases\/(?:tag\/[^/]+|latest)$/.test(
        url.pathname,
      ) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
