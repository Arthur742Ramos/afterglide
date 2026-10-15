import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Copies only the expected installers; never publishes or discovers credentials. */
export async function prepareCandidate({
  sourceDirectory,
  outputDirectory,
  version,
  commit,
  platform,
  arch,
}) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))
    throw new Error("Invalid candidate version.");
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("An exact source commit is required.");
  const extensions =
    platform === "win" && arch === "x64"
      ? ["exe"]
      : platform === "mac" && arch === "arm64"
        ? ["dmg", "zip"]
        : undefined;
  if (!extensions) throw new Error("Unqualified candidate target.");
  if (resolve(sourceDirectory) === resolve(outputDirectory))
    throw new Error("Candidate output must be separate from build output.");
  const filenames = extensions.map(
    (ext) => `Afterglide-Cloud-${version}-${platform}-${arch}.${ext}`,
  );
  for (const filename of filenames) {
    const info = await lstat(join(sourceDirectory, filename));
    if (!info.isFile() || info.size === 0)
      throw new Error(`Expected a nonempty regular artifact: ${filename}`);
  }
  await mkdir(outputDirectory, { recursive: true });
  if ((await readdir(outputDirectory)).length)
    throw new Error("Candidate output must be empty to avoid stale artifacts.");
  const artifacts = [];
  for (const filename of filenames) {
    const destination = join(outputDirectory, filename);
    await copyFile(
      join(sourceDirectory, filename),
      destination,
      constants.COPYFILE_EXCL,
    );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    artifacts.push({
      filename,
      bytes: (await lstat(destination)).size,
      sha256: hash.digest("hex"),
    });
  }
  const manifest = {
    schemaVersion: 1,
    application: { name: "Afterglide Cloud", version },
    source: { repository: "Arthur742Ramos/afterglide", commit },
    target: { platform, arch },
    distribution: {
      kind: "unsigned-test-candidate",
      signing: "not qualified",
      notarization: "not qualified",
      cleanInstallation: "not qualified",
      publicRelease: false,
    },
    artifacts,
  };
  await writeFile(
    join(outputDirectory, "candidate.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(
    join(outputDirectory, "SHA256SUMS"),
    artifacts
      .map(({ filename, sha256 }) => `${sha256}  ${filename}\n`)
      .join(""),
    { flag: "wx" },
  );
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve(import.meta.dirname, "..");
  const { version } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const manifest = await prepareCandidate({
    sourceDirectory: join(root, "release"),
    outputDirectory: join(root, "artifacts/candidate"),
    version,
    commit: process.env.GITHUB_SHA ?? "",
    platform: process.argv[2],
    arch: process.argv[3],
  });
  console.log(
    `Unsigned candidate: ${manifest.source.commit} (${manifest.target.platform}/${manifest.target.arch}). Not a public release.`,
  );
}
