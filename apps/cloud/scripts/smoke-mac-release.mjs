import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

// A hosted, disposable Mac only. Never launch against a developer's live profile.
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const executablePath = join(
  root,
  "release/mac-arm64/Afterglide Cloud.app/Contents/MacOS/Afterglide Cloud",
);
const launches = [];
for (let count = 0; count < 2; count++) {
  let app;
  try {
    app = await electron.launch({ executablePath, timeout: 30_000 });
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page
      .getByRole("button", { name: "Sign in with Microsoft" })
      .waitFor({ state: "visible", timeout: 30_000 });
    const identity = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      version: app.getVersion(),
    }));
    assert.deepEqual(identity, { packaged: true, version: pkg.version });
    const status = await page.evaluate(
      async () => (await window.afterglideCloud.getSnapshot()).auth.status,
    );
    assert.equal(status, "signed-out");
    assert.deepEqual(errors, []);
    launches.push({
      ...identity,
      auth: status,
      observedAfterWindowErrors: errors.length,
    });
  } finally {
    if (app) await app.close();
  }
}
await writeFile(
  join(root, "release/mac-smoke.json"),
  `${JSON.stringify({ commit: process.env.GITHUB_SHA, launches, accountAccess: "none", liveGameplay: "not tested" }, null, 2)}\n`,
);
