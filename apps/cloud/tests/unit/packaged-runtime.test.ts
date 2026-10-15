import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error Node packaging script has no TypeScript declarations.
import { packagedRuntimeProbe } from "../../scripts/check-packaged-runtime.mjs";

it("rejects source dependency fallback and accepts a complete packaged graph", async () => {
  const source = await mkdtemp(join(tmpdir(), "cloud-packaged-graph-"));
  const archive = join(source, "release/resources/app.asar");
  const moduleFile = async (
    root: string,
    name: string,
    body = "module.exports={}",
  ) => {
    const directory = join(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name, main: "index.cjs" }),
    );
    await writeFile(join(directory, "index.cjs"), body);
  };
  try {
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "package.json"), "{}");
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
      await writeFile(join(source, name), "fixture attribution");
      await writeFile(join(archive, name), "fixture attribution");
    }
    for (const name of [
      "react",
      "react-dom",
      "scheduler",
      "commander",
      "uuid-1345",
    ])
      await moduleFile(archive, name);
    await moduleFile(archive, "xal-node", "module.exports=require('jose')");
    // The missing packaged dependency is still available to normal upward lookup.
    await moduleFile(source, "jose");
    const run = (archivePath = archive) =>
      spawnSync(
        process.execPath,
        ["-e", packagedRuntimeProbe, archivePath, source],
        { encoding: "utf8" },
      );
    const missing = run();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain(
      "Dependency escaped packaged archive: jose",
    );
    await moduleFile(archive, "jose");
    const complete = run();
    expect(complete.status).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({
      libraries: "loadable",
      attribution: "byte-identical",
    });
    const alias = join(source, "alias.asar");
    await symlink(
      archive,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(run(alias).status).toBe(0);
    await writeFile(join(archive, "LICENSE"), "different attribution");
    expect(run().status).not.toBe(0);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
