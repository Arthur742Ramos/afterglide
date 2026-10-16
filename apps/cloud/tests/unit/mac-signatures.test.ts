import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Node build script has no TypeScript declarations.
import { verifyMacBundle } from "../../scripts/check-mac-signatures.mjs";

// Real codesign fixtures, independent of Electron and the packaging implementation.
// No certificates, trust changes, app launch or account access.
describe.skipIf(process.platform !== "darwin")(
  "native Mac bundle seals",
  () => {
    let directory: string;
    let app: string;
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "cloud-signature-test-"));
      app = join(directory, "Fixture.app");
      await mkdir(join(app, "Contents/MacOS"), { recursive: true });
      await mkdir(join(app, "Contents/Resources"));
      await copyFile("/usr/bin/true", join(app, "Contents/MacOS/fixture"));
      await chmod(join(app, "Contents/MacOS/fixture"), 0o755);
      await writeFile(
        join(app, "Contents/Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.afterglide.signature-fixture</string>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
      );
      await writeFile(
        join(app, "Contents/Resources/probe.txt"),
        "sealed resource",
      );
      execFileSync("/usr/bin/codesign", [
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        "--options",
        "runtime",
        app,
      ]);
    });
    afterEach(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("accepts a complete native ad-hoc bundle without claiming publisher trust", async () => {
      expect(await verifyMacBundle(app)).toMatchObject({
        signature: "ad-hoc",
        hardenedRuntime: true,
        verification: "--verify --deep --strict passed",
      });
    });

    it("rejects the missing resource seal reported by the installation task", async () => {
      await rm(join(app, "Contents/_CodeSignature"), { recursive: true });
      await expect(verifyMacBundle(app)).rejects.toThrow(/resource/i);
    });

    it("rejects changes to a sealed resource", async () => {
      await writeFile(
        join(app, "Contents/Resources/probe.txt"),
        "changed after signing",
      );
      await expect(verifyMacBundle(app)).rejects.toThrow();
    });
  },
);
