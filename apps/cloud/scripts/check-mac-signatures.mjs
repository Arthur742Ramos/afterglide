import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Native integrity validation only; never signs, launches, or changes trust. */
export async function verifyMacBundle(appPath) {
  if (process.platform !== "darwin")
    throw new Error("Native macOS codesign is required.");
  run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);
  await access(join(appPath, "Contents/_CodeSignature/CodeResources"));
  // codesign displays metadata on stderr even when it succeeds.
  const display = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", appPath],
    { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (display.error || display.status !== 0)
    throw new Error("Cannot inspect Mac signature.");
  const metadata = display.stderr;
  if (
    !/^Signature=adhoc$/m.test(metadata) ||
    !/^CodeDirectory .*flags=.*\bruntime\b/m.test(metadata)
  )
    throw new Error("Expected an ad-hoc signature with hardened runtime.");
  return {
    verification: "--verify --deep --strict passed",
    signature: "ad-hoc",
    hardenedRuntime: true,
    metadata,
  };
}

async function sha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function checkArtifactCopies(root, pkg, appPath) {
  const sourceAsar = await sha256(join(appPath, "Contents/Resources/app.asar"));
  const output = join(root, pkg.build.directories.output);
  const appName = `${pkg.build.productName}.app`;
  const stage = await mkdtemp(join(tmpdir(), "afterglide-mac-verify-"));
  const artifacts = [];
  try {
    for (const extension of ["zip", "dmg"]) {
      const filename = `Afterglide-Cloud-${pkg.version}-mac-arm64.${extension}`;
      const path = join(output, filename);
      const destination = join(stage, extension);
      let attached = false;
      try {
        let extracted;
        if (extension === "zip") {
          run("/usr/bin/ditto", ["-x", "-k", path, destination]);
          extracted = join(destination, appName);
        } else {
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
          extracted = join(destination, appName);
        }
        const signature = await verifyMacBundle(extracted);
        const appAsarSha256 = await sha256(
          join(extracted, "Contents/Resources/app.asar"),
        );
        if (appAsarSha256 !== sourceAsar)
          throw new Error(
            `${filename}: packaged source differs from the built app.`,
          );
        artifacts.push({
          filename,
          sha256: await sha256(path),
          appAsarSha256,
          codesign: signature,
        });
      } finally {
        if (attached) run("/usr/bin/hdiutil", ["detach", destination]);
      }
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return artifacts;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve(import.meta.dirname, "..");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Run on a native Apple Silicon macOS host.");
  const appPath = join(
    root,
    pkg.build.directories.output,
    "mac-arm64",
    `${pkg.build.productName}.app`,
  );
  const bundle = await verifyMacBundle(appPath);
  const evidence = {
    commit: process.env.GITHUB_SHA ?? run("git", ["rev-parse", "HEAD"]).trim(),
    host: {
      os: run("/usr/bin/sw_vers", ["-productVersion"]).trim(),
      arch: process.arch,
    },
    bundle,
    publisherIdentity: "not qualified",
    notarization: "not performed",
    artifacts: process.argv.includes("--artifacts")
      ? await checkArtifactCopies(root, pkg, appPath)
      : [],
  };
  await writeFile(
    join(root, pkg.build.directories.output, "mac-signatures.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence, null, 2));
}
