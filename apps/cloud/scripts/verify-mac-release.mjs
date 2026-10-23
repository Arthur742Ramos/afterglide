import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const team = "72GY62F838";
const identifier = "io.github.Arthur742Ramos.AfterglideCloud";
function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function display(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} validation failed: ${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`.trim();
}
export function validateReleaseIdentity({
  version,
  tag,
  commit,
  metadata,
  assessment,
  actualVersion,
  actualIdentifier,
  arch,
}) {
  if (!/^0\.1\.0-beta\.1$/.test(version) || tag !== `cloud-v${version}`)
    throw new Error(
      "Expected the reviewed Cloud beta version and separate cloud-v tag.",
    );
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("An exact source commit is required.");
  if (
    actualVersion !== version ||
    actualIdentifier !== identifier ||
    arch !== "arm64"
  )
    throw new Error(
      "Packaged version, bundle identifier or architecture mismatch.",
    );
  if (
    !/^Authority=Developer ID Application: .+ \(72GY62F838\)$/m.test(
      metadata,
    ) ||
    !/^TeamIdentifier=72GY62F838$/m.test(metadata) ||
    !/^Identifier=io\.github\.Arthur742Ramos\.AfterglideCloud$/m.test(
      metadata,
    ) ||
    !/^CodeDirectory .*flags=.*\bruntime\b/m.test(metadata) ||
    !/^Timestamp=.+$/m.test(metadata) ||
    /^Signature=adhoc$/m.test(metadata)
  )
    throw new Error(
      "Expected the owner's timestamped Developer ID signature and hardened runtime.",
    );
  if (!/^source=Notarized Developer ID$/m.test(assessment))
    throw new Error("Gatekeeper did not confirm Notarized Developer ID.");
}
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest("hex");
}
async function verifyApp(app, expected) {
  run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    app,
  ]);
  const metadata = display("/usr/bin/codesign", [
    "--display",
    "--verbose=4",
    app,
  ]);
  run("/usr/bin/xcrun", ["stapler", "validate", app]);
  const assessment = display("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    app,
  ]);
  const plist = join(app, "Contents/Info.plist");
  const actualVersion = run("/usr/bin/plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    plist,
  ]);
  const actualIdentifier = run("/usr/bin/plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    plist,
  ]);
  const arch = run("/usr/bin/lipo", [
    "-archs",
    join(app, "Contents/MacOS/Afterglide Cloud"),
  ]);
  validateReleaseIdentity({
    ...expected,
    metadata,
    assessment,
    actualVersion,
    actualIdentifier,
    arch,
  });
  const cdhash = metadata.match(/^CDHash=([a-f0-9]+)$/m)?.[1];
  if (!cdhash) throw new Error("Missing code directory identity.");
  return {
    metadata,
    cdhash,
    assessment,
    stapler: "passed",
    appAsarSha256: await sha256(join(app, "Contents/Resources/app.asar")),
  };
}
export async function verifyRelease(root, commit, tag) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Native Apple Silicon macOS is required.");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const expected = { commit, tag, version: pkg.version };
  const output = join(root, "release");
  const appName = "Afterglide Cloud.app";
  const bundle = await verifyApp(join(output, "mac-arm64", appName), expected);
  const stage = await mkdtemp(join(tmpdir(), "afterglide-release-verify-"));
  const artifacts = [];
  try {
    for (const ext of ["zip", "dmg"]) {
      const filename = `Afterglide-Cloud-${pkg.version}-mac-arm64.${ext}`;
      const path = join(output, filename);
      const destination = join(stage, ext);
      let attached = false;
      try {
        if (ext === "zip")
          run("/usr/bin/ditto", ["-x", "-k", path, destination]);
        else {
          run("/usr/bin/xcrun", ["stapler", "validate", path]);
          display("/usr/sbin/spctl", [
            "--assess",
            "--type",
            "open",
            "--context",
            "context:primary-signature",
            "--verbose=4",
            path,
          ]);
          await mkdir(destination);
          run("/usr/bin/hdiutil", [
            "attach",
            "-readonly",
            "-nobrowse",
            "-mountpoint",
            destination,
            path,
          ]);
          attached = true;
        }
        const evidence = await verifyApp(join(destination, appName), expected);
        if (
          evidence.appAsarSha256 !== bundle.appAsarSha256 ||
          evidence.cdhash !== bundle.cdhash
        )
          throw new Error(
            `${filename}: app content or signing identity differs from the built app.`,
          );
        artifacts.push({
          filename,
          bytes: (await stat(path)).size,
          sha256: await sha256(path),
          ...evidence,
        });
      } finally {
        if (attached) run("/usr/bin/hdiutil", ["detach", destination]);
      }
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  const manifest = {
    schemaVersion: 1,
    application: { name: "Afterglide Cloud", version: pkg.version },
    source: { repository: "Arthur742Ramos/afterglide", commit, tag },
    target: { platform: "mac", arch: "arm64" },
    distribution: {
      kind: "signed-beta-draft",
      team,
      notarization: "validated",
      cleanInstallation: "pending owner qualification",
      publicRelease: false,
    },
    bundle,
    artifacts,
  };
  await writeFile(
    join(output, "mac-release.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    join(output, "SHA256SUMS"),
    artifacts.map((a) => `${a.sha256}  ${a.filename}\n`).join(""),
  );
  return manifest;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const manifest = await verifyRelease(
    resolve(import.meta.dirname, ".."),
    process.env.GITHUB_SHA ?? "",
    process.env.RELEASE_TAG ?? "",
  );
  console.log(
    `Verified ${manifest.source.tag} at ${manifest.source.commit}; draft qualification remains pending.`,
  );
}
