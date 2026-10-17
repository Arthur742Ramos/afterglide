import { _electron as electron, expect } from "@playwright/test";
import { build } from "tsup";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { installInstrumentation } from "./profile-instrumentation.mjs";

const root = resolve(import.meta.dirname, "..");
const usage =
  "Use --mode=all|startup|ui|engine --duration=milliseconds>=1000 --repetitions=positive-integer --cycles=positive-integer --out=path";
if (process.argv.includes("--help")) {
  console.log(usage);
  process.exit(0);
}
const options = Object.fromEntries(
  process.argv.slice(2).map((value) => {
    const match = /^--(mode|duration|repetitions|cycles|out)=(.+)$/.exec(value);
    if (!match) throw new Error(usage);
    return [match[1], match[2]];
  }),
);
const output = resolve(options.out ?? join(root, "artifacts/perf/client.json"));
const duration = Number(options.duration ?? 6000);
const repetitions = Number(options.repetitions ?? 3);
const cycles = Number(options.cycles ?? 20);
const mode = options.mode ?? "all";
if (
  !["all", "startup", "ui", "engine"].includes(mode) ||
  !Number.isFinite(duration) ||
  duration < 1000 ||
  !Number.isInteger(repetitions) ||
  repetitions < 1 ||
  !Number.isInteger(cycles) ||
  cycles < 1
)
  throw new Error(usage);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function inventory(directory, prefix = "") {
  const files = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const name = prefix + entry.name;
    if (entry.isDirectory())
      Object.assign(
        files,
        await inventory(join(directory, entry.name), `${name}/`),
      );
    else files[name] = hash(await readFile(join(directory, entry.name)));
  }
  return files;
}
await mkdir(join(root, "artifacts/perf"), { recursive: true });
const directory = await mkdtemp(join(root, "artifacts/perf/profile-"));
const result = {
  schemaVersion: 2,
  startedAt: new Date().toISOString(),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  runtimeDiff: execFileSync("git", ["diff", "HEAD", "--", "src", "../../src"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  compiledMainSha256: hash(await readFile(join(root, "dist/main/main.cjs"))),
  compiledRuntimeSha256: await inventory(join(root, "dist")),
  runtimeSourceSha256: await inventory(join(root, "src")),
  harnessSha256: hash(
    Buffer.concat(
      await Promise.all(
        [
          "profile-client.mjs",
          "profile-engine.mjs",
          "profile-instrumentation.mjs",
        ].map((name) => readFile(join(root, "scripts", name))),
      ),
    ),
  ),
  host: {
    platform: platform(),
    release: release(),
    architecture: process.arch,
    availableParallelism: availableParallelism(),
    logicalCpus: cpus().length,
  },
  workload: {
    durationMs: duration,
    repetitions,
    cycles,
    viewport: "1280x800",
    catalogTitles: 80,
    sourceLaunch: true,
    simulatedAccounts: true,
  },
  notes: [
    "Serial source/mock UI workloads; no account, Xbox or remote-game rendering measurement.",
    "Summed RSS can double-count shared pages. Linux proportional/private memory is reported separately when available. GPU process RSS is not VRAM; GPU memory is unavailable.",
    "CPU is cumulative process CPU delta divided by wall time, as percent of one core, for matching endpoint processes. Endpoint churn and samples are recorded; processes shorter than the sample interval can be missed. Renderer rAF cadence and synthetic input sampling are not display photons or physical input latency.",
    "Playwright injects test launch flags including --no-sandbox; these source fixtures do not qualify sandboxed packaged-app performance. Production launch/security settings are unchanged.",
    "Forced GC is used only for separate retention observations, outside timed CPU/pacing windows. Resource instrumentation uses weak references.",
    "Listener counts observe explicit add/remove calls; native once/AbortSignal removals can overcount. DOM counters and ICE-specific explicit cleanup are separate evidence.",
    "Local engine fixture includes a separate synthetic encoder renderer; per-PID CPU identifies it. Aggregate engine CPU includes that fixture and is not pure client overhead.",
    "Startup samples are fresh-profile or repeat launches, not OS-cold launches; accept only pre/post host CPU <=10% with the app closed.",
  ],
  startup: [],
  ui: [],
  lifecycle: [],
};
await mkdir(dirname(output), { recursive: true });

async function hostCpu() {
  const sample = async () =>
    (await readFile("/proc/stat", "utf8"))
      .split("\n")[0]
      .trim()
      .split(/\s+/)
      // guest/guest_nice are already included in user/nice.
      .slice(1, 9)
      .map(Number);
  if (process.platform !== "linux") return undefined;
  const a = await sample();
  await sleep(500);
  const b = await sample();
  const total = b.reduce((sum, value, i) => sum + value - a[i], 0);
  return total ? 100 * (1 - (b[3] - a[3] + (b[4] - a[4])) / total) : undefined;
}
async function launch(profile, signedIn = true) {
  const app = await electron.launch({
    cwd: root,
    args: ["."],
    env: {
      ...process.env,
      AFTERGLIDE_CLOUD_E2E: "1",
      AFTERGLIDE_CLOUD_E2E_HEADED: "1",
      AFTERGLIDE_CLOUD_E2E_SIGNED_IN: signedIn ? "1" : "0",
      AFTERGLIDE_CLOUD_E2E_ONBOARDING: "skip",
      AFTERGLIDE_CLOUD_E2E_SCENARIO: "large-cloud-catalog",
      AFTERGLIDE_CLOUD_E2E_USER_DATA: profile,
    },
  });
  try {
    result.uiLaunch = await launchArguments(app);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(
      page
        .getByRole("button", { name: signedIn ? /Play again/ : /Sign in/ })
        .first(),
    ).toBeVisible();
    return { app, page };
  } catch (error) {
    await app.close();
    throw error;
  }
}
async function launchArguments(application) {
  return application.evaluate(({ app }) => ({
    argv: process.argv,
    noSandboxSwitch: app.commandLine.hasSwitch("no-sandbox"),
  }));
}
async function processes(app) {
  const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
  return Promise.all(
    metrics.map(async (entry) => {
      let proportionalKiB;
      let privateKiB;
      if (process.platform === "linux") {
        try {
          const text = await readFile(
            `/proc/${entry.pid}/smaps_rollup`,
            "utf8",
          );
          const pss = text.match(/^Pss:\s+(\d+)/m)?.[1];
          proportionalKiB = pss === undefined ? undefined : Number(pss);
          privateKiB = [
            ...text.matchAll(/^Private_(?:Clean|Dirty|Hugetlb):\s+(\d+)/gm),
          ].reduce((sum, match) => sum + Number(match[1]), 0);
        } catch {
          /* A short-lived process may have exited. */
        }
      }
      return {
        pid: entry.pid,
        creationTime: entry.creationTime,
        type: entry.type,
        name: entry.name,
        cpuSeconds: entry.cpu.cumulativeCPUUsage,
        rssKiB: entry.memory.workingSetSize,
        proportionalKiB,
        privateKiB,
      };
    }),
  );
}
async function heap(page, session, force = false) {
  if (force) await session.send("HeapProfiler.collectGarbage");
  const dom = await session.send("Memory.getDOMCounters");
  const { metrics } = await session.send("Performance.getMetrics");
  const values = Object.fromEntries(
    metrics.map((entry) => [entry.name, entry.value]),
  );
  return {
    ...dom,
    jsHeapUsedBytes: values.JSHeapUsedSize,
    jsHeapTotalBytes: values.JSHeapTotalSize,
    resources: await page.evaluate(() => window.__clientProfile?.snapshot()),
  };
}
async function measure(app, page, session, label) {
  await sleep(1500);
  const resourcesBefore = await page.evaluate(() =>
    window.__clientProfile.snapshot(),
  );
  const before = await processes(app);
  const start = performance.now();
  const frames = page.evaluate(
    (ms) => window.__clientProfile.frameWindow(ms),
    duration,
  );
  const samples = [];
  while (performance.now() - start < duration) {
    await sleep(
      Math.min(1000, Math.max(1, duration - (performance.now() - start))),
    );
    samples.push(await processes(app));
  }
  const after = samples.at(-1);
  const endpointProcessChurn = {
    exited: before.filter(
      (p) =>
        !after.some(
          (next) => next.pid === p.pid && next.creationTime === p.creationTime,
        ),
    ),
    created: after.filter(
      (p) =>
        !before.some(
          (previous) =>
            previous.pid === p.pid && previous.creationTime === p.creationTime,
        ),
    ),
  };
  const seconds = (performance.now() - start) / 1000;
  const cpu = after.flatMap((entry) => {
    const previous = before.find(
      (p) => p.pid === entry.pid && p.creationTime === entry.creationTime,
    );
    return previous &&
      entry.cpuSeconds !== undefined &&
      previous.cpuSeconds !== undefined
      ? [
          {
            pid: entry.pid,
            type: entry.type,
            percentOneCore:
              (100 * (entry.cpuSeconds - previous.cpuSeconds)) / seconds,
          },
        ]
      : [];
  });
  const summary = samples.map((entries) => ({
    rssMiB: entries.reduce((n, p) => n + p.rssKiB, 0) / 1024,
    proportionalMiB: entries.every((p) => p.proportionalKiB !== undefined)
      ? entries.reduce((n, p) => n + p.proportionalKiB, 0) / 1024
      : undefined,
    privateMiB: entries.every((p) => p.privateKiB !== undefined)
      ? entries.reduce((n, p) => n + p.privateKiB, 0) / 1024
      : undefined,
    gpuProcessRssMiB:
      entries
        .filter((p) => p.type === "GPU")
        .reduce((n, p) => n + p.rssKiB, 0) / 1024,
  }));
  const retention = await heap(page, session);
  const resourcesAfter = retention.resources;
  const callsPerSecond = Object.fromEntries(
    Object.keys(resourcesAfter.calls).map((key) => [
      key,
      (resourcesAfter.calls[key] - resourcesBefore.calls[key]) / seconds,
    ]),
  );
  const rendererRaf = await frames;
  return {
    label,
    seconds,
    cpu,
    matchedProcessCpuPercentOneCore: cpu.reduce(
      (n, p) => n + p.percentOneCore,
      0,
    ),
    endpointProcessChurn,
    processBefore: before,
    callsPerSecond,
    memorySamples: summary,
    rendererRaf,
    retention,
    retentionAfterGc: await heap(page, session, true),
    processSamples: samples,
  };
}

try {
  if (["all", "startup"].includes(mode)) {
    for (const kind of ["fresh-profile", "repeat-profile"]) {
      const repeatProfile = join(directory, "repeat");
      if (kind === "repeat-profile") {
        const { app } = await launch(repeatProfile, false);
        await app.close();
        await sleep(300);
      }
      for (let i = 0; i < 5; i++) {
        const beforeCpu = await hostCpu();
        const start = performance.now();
        const { app } = await launch(
          kind === "repeat-profile"
            ? repeatProfile
            : join(directory, `fresh-${i}`),
          false,
        );
        const elapsedMs = performance.now() - start;
        result.electron = await app.evaluate(() => process.versions);
        await app.close();
        await sleep(300);
        const afterCpu = await hostCpu();
        result.startup.push({
          kind,
          sample: i + 1,
          elapsedMs,
          hostCpuBefore: beforeCpu,
          hostCpuAfter: afterCpu,
          accepted:
            beforeCpu !== undefined &&
            afterCpu !== undefined &&
            beforeCpu <= 10 &&
            afterCpu <= 10,
        });
      }
    }
  }
  if (["all", "ui"].includes(mode)) {
    const { app, page } = await launch(join(directory, "ui"), false);
    try {
      result.electron = await app.evaluate(() => process.versions);
      result.gpuFeatureStatus = await app.evaluate(({ app }) =>
        app.getGPUFeatureStatus(),
      );
      await page.addInitScript(installInstrumentation);
      await page.reload();
      await expect(
        page.getByRole("button", { name: /Sign in/ }).first(),
      ).toBeVisible();
      const session = await page.context().newCDPSession(page);
      await session.send("Performance.enable");
      await sleep(2000);
      for (let i = 0; i < repetitions; i++)
        result.ui.push(
          await measure(app, page, session, `idle-signed-out-${i + 1}`),
        );
      await page
        .getByRole("button", { name: /Sign in/ })
        .first()
        .click();
      await expect(
        page.getByRole("button", { name: /Play again/ }).first(),
      ).toBeVisible();
      for (const connected of [false, true]) {
        await page.evaluate(
          (value) => window.__clientProfile.setPad(value),
          connected,
        );
        for (let i = 0; i < repetitions; i++)
          result.ui.push(
            await measure(
              app,
              page,
              session,
              `library-controller-${connected}-${i + 1}`,
            ),
          );
      }
      await page.evaluate(() => window.__clientProfile.setPad(false));
      const before = await heap(page, session, true);
      for (let i = 0; i < cycles; i++) {
        await page.evaluate(() =>
          window.__clientProfile.rememberElement("library", ".cloud-page"),
        );
        await page
          .getByRole("button", { name: /Play again/ })
          .first()
          .click();
        await expect(page.getByTestId("mock-stream")).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(
              async () =>
                (await window.afterglideCloud.getSnapshot()).session.phase,
            ),
          )
          .toBe("streaming");
        if (i === 0) {
          await page.keyboard.press("F10");
          await page.evaluate(() =>
            window.__clientProfile.rememberElement(
              "quickSettings",
              ".quick-settings",
            ),
          );
          await page.keyboard.press("F10");
          for (let j = 0; j < repetitions; j++)
            result.ui.push(
              await measure(
                app,
                page,
                session,
                `mock-stream-overlay-closed-${j + 1}`,
              ),
            );
          await page.keyboard.press("F10");
          for (let j = 0; j < repetitions; j++)
            result.ui.push(
              await measure(
                app,
                page,
                session,
                `mock-stream-overlay-open-${j + 1}`,
              ),
            );
        }
        if (
          (await page.locator(".stream-header").getAttribute("aria-hidden")) ===
          "true"
        )
          await page.keyboard.press("F10");
        await page.getByRole("button", { name: "Leave Xbox stream" }).click();
        await expect(
          page.getByRole("button", { name: /Play again/ }).first(),
        ).toBeVisible();
        if ((i + 1) % 5 === 0)
          result.lifecycle.push({
            kind: "mock-ui",
            cycle: i + 1,
            retention: await heap(page, session, true),
            processes: await processes(app),
          });
      }
      result.lifecycle.push({ kind: "mock-ui-baseline", retention: before });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.evaluate(() => window.__clientProfile.setPad(true));
      for (let i = 0; i < repetitions; i++)
        result.ui.push(
          await measure(app, page, session, `settings-controller-${i + 1}`),
        );
    } finally {
      await app.close();
    }
  }
  if (["all", "engine"].includes(mode)) {
    await build({
      entry: { engine: join(root, "scripts/profile-engine.mjs") },
      outDir: directory,
      outExtension: () => ({ js: ".js" }),
      format: ["iife"],
      globalName: "ClientEngineProfile",
      platform: "browser",
      target: "es2023",
      bundle: true,
      config: false,
      silent: true,
    });
    const main = join(directory, "engine-main.cjs");
    await writeFile(
      join(directory, "receiver.html"),
      "<!doctype html><title>Receiver profile</title><body>",
    );
    await writeFile(
      join(directory, "sender.html"),
      "<!doctype html><title>Local source fixture</title><body>",
    );
    await writeFile(
      main,
      `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(directory, "engine-profile"))});
app.whenReady().then(async()=>{
 const receiver=new BrowserWindow({width:1280,height:800,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'receiver-profile'}});
 await receiver.loadFile(${JSON.stringify(join(directory, "receiver.html"))});
 const sender=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'sender-profile',backgroundThrottling:false,offscreen:true}});
 await sender.loadFile(${JSON.stringify(join(directory, "sender.html"))});
 receiver.focus();
});`,
    );
    const app = await electron.launch({ args: [main] });
    try {
      result.engineLaunch = await launchArguments(app);
      await expect.poll(() => app.windows().length).toBe(2);
      const pages = app.windows();
      const receiver = pages[0];
      const sender = pages[1];
      await expect(receiver).toHaveTitle("Receiver profile");
      await expect(sender).toHaveTitle("Local source fixture");
      result.electron = await app.evaluate(() => process.versions);
      result.engineWindows = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          title: window.getTitle(),
          pid: window.webContents.getOSProcessId(),
          preferences: window.webContents.getLastWebPreferences(),
        })),
      );
      const code = await readFile(join(directory, "engine.js"), "utf8");
      result.bundledEngineProbeSha256 = hash(code);
      await receiver.evaluate(installInstrumentation);
      await receiver.addScriptTag({ content: code });
      await sender.addScriptTag({ content: code });
      await receiver.exposeFunction("__profileAnswer", (offer) =>
        sender.evaluate(
          (value) => ClientEngineProfile.answerOffer(value),
          offer,
        ),
      );
      await receiver.exposeFunction("__profileIce", (candidates) =>
        sender.evaluate(
          (value) => ClientEngineProfile.exchangeIce(value),
          candidates,
        ),
      );
      await receiver.evaluate(() => ClientEngineProfile.initializeReceiver());
      const session = await receiver.context().newCDPSession(receiver);
      await session.send("Performance.enable");
      result.lifecycle.push({
        kind: "native-engine-baseline",
        retention: await heap(receiver, session, true),
        processes: await processes(app),
      });
      for (let i = 0; i < cycles; i++) {
        await receiver.evaluate(() => ClientEngineProfile.startReceiver());
        await expect
          .poll(
            () => receiver.evaluate(() => window.__receiverProfile.connected),
            { timeout: 10000 },
          )
          .toBe(i + 1);
        if (i === 0) {
          await receiver.evaluate(() => window.__clientProfile.setPad(true));
          for (let j = 0; j < repetitions; j++)
            result.ui.push(
              await measure(
                app,
                receiver,
                session,
                `local-engine-includes-source-${j + 1}`,
              ),
            );
          const input = [];
          for (let tap = 0; tap < 10; tap++) {
            const at = await receiver.evaluate(() => {
              window.__clientProfile.state.pad.buttons[0] = {
                pressed: true,
                value: 1,
              };
              return performance.now();
            });
            await expect
              .poll(() =>
                sender.evaluate(
                  () => window.__senderProfile.packets.at(-1)?.mask & 16,
                ),
              )
              .toBe(16);
            const packet = await sender.evaluate(
              (at) =>
                window.__senderProfile.packets.find(
                  (packet) => packet.sentAt >= at && packet.mask & 16,
                ),
              at,
            );
            input.push(packet.sentAt - at);
            await receiver.evaluate(() => {
              window.__clientProfile.state.pad.buttons[0] = {
                pressed: false,
                value: 0,
              };
            });
            await expect
              .poll(() =>
                sender.evaluate(
                  () => window.__senderProfile.packets.at(-1)?.mask & 16,
                ),
              )
              .toBe(0);
          }
          result.syntheticInputSamplingDelayMs = input;
          result.localStreamTelemetry = await receiver.evaluate(
            () => window.__receiverProfile.telemetry,
          );
          await receiver.evaluate(() => window.__clientProfile.setPad(false));
        } else await sleep(150);
        await receiver.evaluate(() => ClientEngineProfile.stopReceiver());
        const cleanup = await sender.evaluate(() =>
          ClientEngineProfile.stopSender(),
        );
        if ((i + 1) % 5 === 0)
          result.lifecycle.push({
            kind: "native-engine",
            cycle: i + 1,
            retention: await heap(receiver, session, true),
            senderCleanup: cleanup,
            processes: await processes(app),
          });
      }
      await receiver.evaluate(() => {
        window.__receiverProfile.connected = 0;
        window.__receiverProfile.telemetry = [];
      });
      result.lifecycle.push({
        kind: "pending-ice-baseline",
        retention: await heap(receiver, session, true),
      });
      for (let i = 0; i < cycles; i++) {
        const settledBefore = await receiver.evaluate(
          () => window.__receiverProfile.settled,
        );
        await receiver.evaluate(() => ClientEngineProfile.startReceiver(true));
        await expect
          .poll(
            () =>
              receiver.evaluate(
                () => window.__clientProfile.snapshot().latestPeerIceListeners,
              ),
            { intervals: [1, 5, 10], timeout: 5000 },
          )
          .toBeGreaterThan(0);
        await receiver.evaluate(() => ClientEngineProfile.stopReceiver());
        await sender.evaluate(() => ClientEngineProfile.stopSender());
        if ((i + 1) % 5 === 0)
          result.lifecycle.push({
            kind: "pending-ice-immediate",
            cycle: i + 1,
            settledBefore,
            pending: await receiver.evaluate(
              () => window.__receiverProfile.pending,
            ),
            retention: await heap(receiver, session, true),
            processes: await processes(app),
          });
      }
      await sleep(4200);
      result.lifecycle.push({
        kind: "pending-ice-expired",
        pending: await receiver.evaluate(
          () => window.__receiverProfile.pending,
        ),
        retention: await heap(receiver, session, true),
        processes: await processes(app),
      });
      result.engineErrors = await receiver.evaluate(
        () => window.__receiverProfile.errors,
      );
    } catch (error) {
      result.engineFailure = {
        message: error.message,
        windows: await Promise.all(
          app.windows().map((page) =>
            page.evaluate(() => ({
              title: document.title,
              receiver: window.__receiverProfile
                ? {
                    pending: window.__receiverProfile.pending,
                    connected: window.__receiverProfile.connected,
                    errors: window.__receiverProfile.errors,
                    iceRequests: window.__receiverProfile.iceRequests,
                    peer: window.__receiverProfile.engine?.peer.connectionState,
                    handshake:
                      window.__receiverProfile.engine?.handshakeAcknowledged,
                    inputActive: window.__receiverProfile.engine?.inputActive,
                    videoPlaying: window.__receiverProfile.engine?.videoPlaying,
                    channels: Object.fromEntries(
                      Object.entries(
                        window.__receiverProfile.engine?.channels ?? {},
                      ).map(([key, value]) => [key, value.readyState]),
                    ),
                    media: [...document.querySelectorAll("video,audio")].map(
                      (element) => ({
                        kind: element.tagName,
                        readyState: element.readyState,
                        paused: element.paused,
                        tracks: element.srcObject?.getTracks().map((track) => ({
                          kind: track.kind,
                          readyState: track.readyState,
                        })),
                      }),
                    ),
                  }
                : undefined,
              source: window.__senderProfile
                ? {
                    peer: window.__senderProfile.peer.connectionState,
                    channels: window.__senderProfile.channels.map((channel) => [
                      channel.label,
                      channel.readyState,
                    ]),
                    packets: window.__senderProfile.packets.length,
                    messageKinds: window.__senderProfile.messageKinds,
                  }
                : undefined,
            })),
          ),
        ),
      };
      throw error;
    } finally {
      await app.close();
    }
  }
} finally {
  result.completedAt = new Date().toISOString();
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  await rm(directory, { recursive: true, force: true });
}
console.log(`Client profile saved to ${output}`);
