import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Node build script has no TypeScript declarations.
import { prepareCandidate } from "../../scripts/candidate-artifacts.mjs";

const directories: string[] = [];
const version = "0.1.0-alpha.1";
const commit = "a".repeat(40);
async function fixture(platform = "win", arch = "x64") {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "cloud-candidate-"));
  directories.push(sourceDirectory);
  return {
    sourceDirectory,
    outputDirectory: join(sourceDirectory, "bundle"),
    version,
    commit,
    platform,
    arch,
  };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => rm(dir, { recursive: true })),
  );
});

describe("unsigned candidate payload", () => {
  it("ties exact installer bytes to source and excludes unrelated build files", async () => {
    const options = await fixture();
    const filename = `Afterglide-Cloud-${version}-win-x64.exe`;
    await writeFile(
      join(options.sourceDirectory, filename),
      "synthetic installer",
    );
    await writeFile(join(options.sourceDirectory, "unrelated.exe"), "stale");
    const manifest = await prepareCandidate(options);
    expect(manifest.source.commit).toBe(commit);
    expect(manifest.distribution.publicRelease).toBe(false);
    expect(manifest.distribution.signing).toBe("not qualified");
    expect(manifest.artifacts).toEqual([
      {
        filename,
        bytes: 19,
        sha256: createHash("sha256")
          .update("synthetic installer")
          .digest("hex"),
      },
    ]);
    expect(
      JSON.parse(
        await readFile(join(options.outputDirectory, "candidate.json"), "utf8"),
      ),
    ).toEqual(manifest);
    expect(
      await readFile(join(options.outputDirectory, "SHA256SUMS"), "utf8"),
    ).toBe(`${manifest.artifacts[0].sha256}  ${filename}\n`);
    await expect(prepareCandidate(options)).rejects.toThrow("empty");
  });

  it("requires both Mac payloads and refuses empty or linked artifacts", async () => {
    const options = await fixture("mac", "arm64");
    const dmg = join(
      options.sourceDirectory,
      `Afterglide-Cloud-${version}-mac-arm64.dmg`,
    );
    const zip = join(
      options.sourceDirectory,
      `Afterglide-Cloud-${version}-mac-arm64.zip`,
    );
    await writeFile(dmg, "image");
    await expect(prepareCandidate(options)).rejects.toThrow();
    await writeFile(zip, "");
    await expect(prepareCandidate(options)).rejects.toThrow("nonempty regular");
    await rm(zip);
    // Directory links need no Windows developer-mode privilege.
    await symlink(
      options.sourceDirectory,
      zip,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(prepareCandidate(options)).rejects.toThrow("nonempty regular");
    await rm(zip);
    await writeFile(zip, "archive");
    expect((await prepareCandidate(options)).artifacts).toHaveLength(2);
  });

  it("rejects missing source identity, path-like versions and unqualified targets", async () => {
    const options = await fixture();
    await expect(
      prepareCandidate({ ...options, commit: "main" }),
    ).rejects.toThrow("exact source");
    await expect(
      prepareCandidate({ ...options, version: "../release" }),
    ).rejects.toThrow("version");
    await expect(
      prepareCandidate({ ...options, platform: "mac", arch: "x64" }),
    ).rejects.toThrow("Unqualified");
    await expect(
      prepareCandidate({
        ...options,
        outputDirectory: options.sourceDirectory,
      }),
    ).rejects.toThrow("separate");
  });
});
