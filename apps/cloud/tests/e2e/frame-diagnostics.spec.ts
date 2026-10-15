import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "tsup";
import type { FrameTiming } from "../../src/shared/contracts";

test("native WebRTC video produces distinct arrival, decode and presentation measurements", async () => {
  const directory = mkdtempSync(join(tmpdir(), "afterglide-frame-probe-"));
  try {
    await build({
      entry: { probe: join(import.meta.dirname, "frame-probe.ts") },
      outDir: directory,
      outExtension: () => ({ js: ".js" }),
      format: ["iife"],
      globalName: "Diagnostics",
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
        const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
        await win.loadURL('about:blank');
      });
    `,
    );
    const app = await electron.launch({ args: [main] });
    try {
      await app.firstWindow();
      const probe = `(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const context = canvas.getContext('2d');
        const stream = canvas.captureStream(30);
        let frame = 0;
        const draw = setInterval(() => {
          context.fillStyle = frame++ % 2 ? '#2050b0' : '#f8c050';
          context.fillRect(0, 0, 640, 360);
        }, 33);
        const sender = new RTCPeerConnection(), receiver = new RTCPeerConnection();
        const video = document.createElement('video'); video.muted = true; video.autoplay = true;
        document.body.append(video);
        const tracker = new Diagnostics.FrameMetricsTracker(video); tracker.start(true);
        const local = [], remote = [];
        sender.onicecandidate = event => { if (event.candidate) local.push(event.candidate); };
        receiver.onicecandidate = event => { if (event.candidate) remote.push(event.candidate); };
        receiver.ontrack = event => { video.srcObject = event.streams[0]; };
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const gathered = async peer => {
          for (let i = 0; i < 50 && peer.iceGatheringState !== 'complete'; i++) await wait(20);
        };
        try {
          sender.addTrack(stream.getVideoTracks()[0], stream);
          await sender.setLocalDescription(await sender.createOffer());
          await receiver.setRemoteDescription(sender.localDescription);
          await receiver.setLocalDescription(await receiver.createAnswer());
          await sender.setRemoteDescription(receiver.localDescription);
          await Promise.all([gathered(sender), gathered(receiver)]);
          for (const candidate of local) await receiver.addIceCandidate(candidate);
          for (const candidate of remote) await sender.addIceCandidate(candidate);
          let previous;
          const samples = [];
          for (let i = 0; i < 5; i++) {
            await wait(1000);
            const records = new Map(); (await receiver.getStats()).forEach(value => records.set(value.id, value));
            const { telemetry, sample } = Diagnostics.extractStreamStats(records, previous, performance.now());
            samples.push({ ...telemetry, ...tracker.snapshot(sample.video, sample.observedAt) });
            previous = sample;
          }
          return samples;
        } finally {
          tracker.stop(); clearInterval(draw); sender.close(); receiver.close();
          stream.getTracks().forEach(track => track.stop()); video.remove();
        }
      })()`;
      const samples = (await app.evaluate(
        ({ BrowserWindow }, source) =>
          BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
            source,
          ),
        readFileSync(join(directory, "probe.js"), "utf8") + "\n" + probe,
      )) as Array<{
        incomingFramesPerSecond?: number;
        decodedFramesPerSecond?: number;
        displayedFramesPerSecond?: number;
        displayedFpsSource?: string;
        frameTiming?: FrameTiming;
      }>;
      const measurements = samples.filter(
        (sample) =>
          sample.incomingFramesPerSecond !== undefined &&
          sample.decodedFramesPerSecond !== undefined &&
          sample.displayedFramesPerSecond !== undefined,
      );
      const evidence = join(import.meta.dirname, "../../artifacts/e2e");
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, "native-frame-measurements.json"),
        JSON.stringify(samples, null, 2),
      );
      expect(measurements.length).toBeGreaterThanOrEqual(2);
      for (const sample of measurements) {
        expect(sample.frameTiming?.observedFrames).toBeGreaterThan(5);
        expect(sample.frameTiming?.decodeP95Ms).toBeGreaterThanOrEqual(0);
        expect(sample.frameTiming?.receiveIntervalP95Ms).toBeGreaterThan(0);
        expect(
          sample.frameTiming?.receiveToPresentationP95Ms,
        ).toBeGreaterThanOrEqual(0);
        expect(sample.incomingFramesPerSecond).toBeGreaterThan(5);
        expect(sample.decodedFramesPerSecond).toBeGreaterThan(5);
        expect(sample.displayedFramesPerSecond).toBeGreaterThan(5);
        expect(["webrtc", "video-callback"]).toContain(
          sample.displayedFpsSource,
        );
      }
      await test.info().attach("local-webrtc-frame-measurements", {
        body: JSON.stringify(samples, null, 2),
        contentType: "application/json",
      });
    } finally {
      await app.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
