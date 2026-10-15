import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Loads libraries and attribution only. No UI, token store or network operations.
export const packagedRuntimeProbe = `
const Module=require('node:module');
const {createRequire,isBuiltin}=Module;
const {readFileSync}=require('node:fs');
const {join,relative,isAbsolute}=require('node:path');
const {strict:assert}=require('node:assert');
const archive=process.argv[1];
const source=process.argv[2];
// Reject upward/global fallback, including dependencies loaded inside the SDK.
const originalResolve=Module._resolveFilename;
Module._resolveFilename=function(request,...args) {
  const resolved=originalResolve.call(this,request,...args);
  if(!isBuiltin(request)&&!isBuiltin(resolved)) {
    const local=relative(archive,resolved);
    if(local==='..'||local.startsWith('../')||local.startsWith('..\\\\')||isAbsolute(local))
      throw new Error('Dependency escaped packaged archive: '+request);
  }
  return resolved;
};
const packagedRequire=createRequire(join(archive,'package.json'));
for(const name of ['react','react-dom','xal-node']) packagedRequire(name);
const reactRequire=createRequire(packagedRequire.resolve('react-dom/package.json'));
reactRequire.resolve('scheduler');
const sdkRequire=createRequire(packagedRequire.resolve('xal-node'));
for(const name of ['commander','jose','uuid-1345']) sdkRequire.resolve(name);
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])
  assert.deepEqual(readFileSync(join(archive,name)),readFileSync(join(source,name)));
console.log(JSON.stringify({electron:process.versions.electron,libraries:'loadable',attribution:'byte-identical'}));
`;
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve(import.meta.dirname, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const mac = process.platform === "darwin" && process.arch === "arm64";
  const win = process.platform === "win32" && process.arch === "x64";
  if (!win && !mac)
    throw new Error("Run on Windows x64 or a native Apple Silicon Mac.");
  const resources = mac
    ? join(
        root,
        "release/mac-arm64",
        `${pkg.build.productName}.app/Contents/Resources`,
      )
    : join(root, "release/win-unpacked/resources");
  const executable = mac
    ? join(resources, "../MacOS", pkg.build.productName)
    : join(resources, "..", `${pkg.build.productName}.exe`);
  const result = spawnSync(
    executable,
    ["-e", packagedRuntimeProbe, join(resources, "app.asar"), root],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Packaged runtime check failed: ${result.error?.message ?? result.stderr}`,
    );
  const evidence = JSON.parse(result.stdout.trim());
  if (
    !evidence.electron ||
    evidence.libraries !== "loadable" ||
    evidence.attribution !== "byte-identical"
  )
    throw new Error("Incomplete packaged runtime evidence.");
  console.log(JSON.stringify(evidence));
}
