import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "tsup";

test("the real Cloud engine offers browser-supported video repair codecs in Chromium", async () => {
  const directory = mkdtempSync(join(tmpdir(), "afterglide-video-offer-"));
  try {
    // Bundle the production engine itself. No Xbox account, mock SDP or
    // production user-data directory is involved in this negotiation check.
    await build({
      entry: {
        probe: join(
          import.meta.dirname,
          "../../src/renderer/stream/stream-engine.ts",
        ),
      },
      outDir: directory,
      outExtension: () => ({ js: ".js" }),
      format: ["iife"],
      globalName: "CloudStream",
      platform: "browser",
      target: "es2023",
      bundle: true,
      config: false,
      silent: true,
    });
    const main = join(directory, "main.cjs");
    writeFileSync(
      main,
      `
      const { app, BrowserWindow } = require('electron');
      app.setPath('userData', ${JSON.stringify(join(directory, "profile"))});
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        await win.loadURL('about:blank');
      });
    `,
    );
    const app = await electron.launch({ args: [main] });
    try {
      await app.firstWindow();
      const probe = `
        (async () => {
          let resolveOffer;
          const offered = new Promise(resolve => { resolveOffer = resolve; });
          window.afterglideCloud = { sendSdp: async (_session, offer) => {
            resolveOffer(offer.sdp);
            return new Promise(() => {});
          }};
          const capabilities = RTCRtpReceiver.getCapabilities('video').codecs.map(codec => codec.mimeType.toLowerCase());
          const engine = new CloudStream.XboxStreamEngine({
            sessionId: 'isolated-offer-check', container: document.body,
            keyboardControls: false, reserveControlChord: true,
            controllerSettings: { preferredControllerId: '', controllerDefaults: {}, controllerProfiles: [] },
            onConnected() {}, onInterrupted() {}, onError(message) { throw new Error(message); },
            onTelemetry() {}, onControllerStatus() {}, onControlsShortcut() {}
          });
          try {
            void engine.connect();
            const sdp = await Promise.race([offered, new Promise((_, reject) => setTimeout(() => reject(new Error('No native video offer')), 5000))]);
            return { capabilities, sdp };
          } finally { engine.destroy(); }
        })()
      `;
      const result = (await app.evaluate(
        ({ BrowserWindow }, source) =>
          BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
            source,
          ),
        readFileSync(join(directory, "probe.js"), "utf8") + "\n" + probe,
      )) as { capabilities: string[]; sdp: string };
      for (const repair of ["rtx", "red", "ulpfec", "flexfec-03"]) {
        if (result.capabilities.includes(`video/${repair}`))
          expect(result.sdp).toMatch(
            new RegExp(`a=rtpmap:\\d+ ${repair}/90000`, "i"),
          );
      }
      expect(result.capabilities).toContain("video/rtx");
      expect(result.sdp).toMatch(/a=fmtp:\d+ apt=\d+/);
      const video = result.sdp.split("m=video ")[1]?.split("\r\nm=")[0];
      const firstPayload = video?.split("\r\n")[0].trim().split(/\s+/)[2];
      if (result.capabilities.includes("video/h264"))
        expect(video).toMatch(
          new RegExp(`a=rtpmap:${firstPayload} H264/90000`, "i"),
        );
      await test.info().attach("native-video-offer", {
        body: result.sdp
          .split(/\r?\n/)
          .filter((line) => /^(m=video |a=(rtpmap|fmtp|rtcp-fb):)/.test(line))
          .join("\n"),
        contentType: "text/plain",
      });
    } finally {
      await app.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
