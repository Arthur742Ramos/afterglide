import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
  throw new Error("Run this local package command with native Node on a Mac.");

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const packagePath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const builder = require.resolve("electron-builder/out/cli/cli.js");
const version = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
  encoding: "utf8",
});

async function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (code !== 0) throw new Error(`${command} exited with status ${code}.`);
}

const modernMac = Number.parseInt(version, 10) >= 27;
await run(process.execPath, [
  builder,
  "--mac",
  ...(modernMac ? ["--dir"] : ["dmg"]),
  `--${process.arch}`,
  "--publish",
  "never",
  // This command creates a local development artifact; it never submits to Apple.
  "--config.mac.notarize=false",
]);

if (modernMac) {
  const output = resolve(root, pkg.build.directories.output);
  const appName = `${pkg.build.productName}.app`;
  const appPath = join(
    output,
    `mac${process.arch === "arm64" ? "-arm64" : ""}`,
    appName,
  );
  const artifactName = pkg.build.artifactName
    .replaceAll("${version}", pkg.version)
    .replaceAll("${os}", "mac")
    .replaceAll("${arch}", process.arch)
    .replaceAll("${ext}", "dmg");
  const artifact = join(output, artifactName);
  const stage = mkdtempSync(join(tmpdir(), "afterglide-cloud-dmg-stage-"));
  try {
    await run("/usr/bin/ditto", [appPath, join(stage, appName)]);
    symlinkSync("/Applications", join(stage, "Applications"));
    if (existsSync(artifact)) rmSync(artifact);
    // The supported macOS 27 API creates the image without mounting a volume.
    await run("/usr/sbin/diskutil", [
      "image",
      "create",
      "from",
      "--format",
      "UDZO",
      "--volumeName",
      pkg.build.dmg.title,
      stage,
      artifact,
    ]);
    console.log(`Local development DMG: ${artifact}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
