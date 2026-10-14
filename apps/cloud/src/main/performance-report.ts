import type {
  AppSettings,
  RegionSelection,
  HardwareInfo,
  StreamSource,
  StreamTelemetry,
} from "../shared/contracts";

export interface DeviceMetrics {
  observedAt: number;
  processCpuPercent?: number;
  batteryWatts?: number;
  batteryPercent?: number;
  batteryState?: string;
  temperatureCelsius?: number;
  unavailable: string[];
}

interface Sample {
  connectionNumber: number;
  telemetry: StreamTelemetry;
  settings: Pick<
    AppSettings,
    "resolution" | "inputPolling" | "videoFit" | "playbackMode"
  >;
  device?: DeviceMetrics;
}

const sampleLimit = 3_600;

export class PerformanceReport {
  private samples: Sample[] = [];
  private next = 0;
  private totalSamples = 0;
  private startedAt = Date.now();
  private source?: StreamSource;
  private regionSelections: RegionSelection[] = [];
  private connectionNumber = 0;
  private recoveries: { startedAt: number; durationMs: number }[] = [];

  reset(source: StreamSource): void {
    this.samples = [];
    this.next = 0;
    this.totalSamples = 0;
    this.startedAt = Date.now();
    this.source = source;
    this.regionSelections = [];
    this.recoveries = [];
    this.connectionNumber = 0;
  }

  recordRegionSelection(selection: RegionSelection): void {
    this.regionSelections.push(structuredClone(selection));
    if (this.regionSelections.length > 100) this.regionSelections.shift();
  }

  connected(): void {
    this.connectionNumber += 1;
  }

  add(
    telemetry: StreamTelemetry,
    settings: AppSettings,
    device?: DeviceMetrics,
  ): void {
    const sample: Sample = structuredClone({
      connectionNumber: this.connectionNumber,
      telemetry,
      settings: {
        resolution: settings.resolution,
        inputPolling: settings.inputPolling,
        videoFit: settings.videoFit,
        playbackMode: settings.playbackMode,
      },
      device,
    });
    if (this.samples.length < sampleLimit) this.samples.push(sample);
    else this.samples[this.next] = sample;
    this.next = (this.next + 1) % sampleLimit;
    this.totalSamples += 1;
  }

  recovered(startedAt: number, durationMs: number): void {
    this.recoveries.push({ startedAt, durationMs });
    if (this.recoveries.length > 100) this.recoveries.shift();
  }

  export(
    version: string,
    environment: "test" | "live",
    hardware: HardwareInfo,
  ) {
    const samples =
      this.samples.length < sampleLimit
        ? this.samples
        : [
            ...this.samples.slice(this.next),
            ...this.samples.slice(0, this.next),
          ];
    return structuredClone({
      schemaVersion: 1,
      application: { name: "Afterglide Cloud", version, environment },
      startedAt: this.startedAt,
      exportedAt: Date.now(),
      source: this.source,
      regionSelections: this.regionSelections,
      totalSamples: this.totalSamples,
      retainedSamples: samples.length,
      droppedSamples: this.totalSamples - samples.length,
      hardware: {
        acceleration: hardware.acceleration,
        videoDecode: hardware.videoDecode,
        gpu: hardware.gpu,
      },
      measurementNotes: [
        "Region selection retains Xbox default (or first offered region). Three fresh unauthenticated HTTPS probes per service are diagnostic only: DNS/TLS/HTTP timing has not established media-path latency and never overrides the default. medianProbeMs belongs to the requested default, not the fastest probe. Partial scans are marked scanComplete false. Xbox can still assign a fallback hosting region. Actual stream RTT is recorded separately. Selection history retains at most 100 entries.",
        "Latest 3600 telemetry samples; older samples are evicted.",
        "Missing measurements remain unreported and are excluded from summaries; measured zero values are retained.",
        "Configuration labels are requested settings; resolution, codec and decoder samples are received/reported values.",
        "Test-environment samples are simulated, not hardware evidence.",
        "Ping is RTT; presented-frame cadence is not button-to-photon latency.",
        "Incoming and decoded FPS use advancing receiver counters and stats timestamps. Displayed FPS uses framesRendered or compositor submission counters, not physical display photons.",
        "presentationCallbacksSkipped counts missed observations, not dropped display frames. Cadence excludes gaps spanning skipped callbacks. Hidden playback has no displayed FPS; visibility and focus are retained.",
        "Retransmission, NACK, PLI, FIR and receiver-drop counts are cumulative for the current receiver and can reset. Missing is unknown; retransmitted packets are a subset of received packets, not additional packet loss.",
        "playoutTargetMs is the requested hint; playoutTargetAccepted confirms API readback only. jitterBufferMs is measured delay, jitterBufferTargetMs the receiver target, and jitterBufferMinimumMs its network minimum. Smooth requests 16-100 ms and adds latency.",
        "jitterMs measures RTP packet jitter; jitterBufferMs measures interval receiver buffering. playoutMode is the application's request, not achieved delay.",
        "Decoder identity is reported by Chromium, not proof of hardware decoding.",
        "CPU is the sum of Electron process percentCPUUsage readings.",
        "Device measurements are sampled every 5 seconds; observedAt identifies repeated readings.",
        "Battery watts are whole-device discharge power, not application-only power.",
        "Thermal readings are device sensors, not proof of throttling.",
        "Freeze/drop counters are cumulative per media session and reset on reconnect.",
        "Summaries group retained samples by requested resolution and input polling; device timestamps are deduplicated within each group.",
        "Frame-interval summaries are distributions of rolling-window percentiles, not global frame percentiles.",
        "Input polling measures timer-driven JavaScript polls, not hardware updates or input-to-photon latency. Paused/discovery/event-driven callbacks are excluded; modes and timer baselines reset separately.",
        "Input windows contain intervals since the last successful telemetry collection. p95UpperMs is a 1ms histogram upper bound; overflow uses the exact window maximum. meanJitterMs is mean absolute interval deviation from targetMs; longGaps counts intervals >32ms.",
        "Power context is local OS state with observation timestamps. Missing speed-limit notification means unknown, not 100%; thermal severity is not Celsius or watts. Power-efficient decoder is optional browser-reported evidence, not GPU utilization.",
      ],
      recoveries: this.recoveries,
      summaries: summarizeSamples(samples),
      samples,
    });
  }
}

function distribution(values: (number | undefined)[]) {
  const sorted = values
    .filter(
      (value): value is number => value !== undefined && Number.isFinite(value),
    )
    .sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
  return {
    count: sorted.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}

function summarizeSamples(samples: Sample[]) {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = `${sample.settings.resolution}p/${sample.settings.inputPolling}/${sample.settings.playbackMode}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups].map(([configuration, group]) => {
    const devices = new Map<number, DeviceMetrics>();
    for (const sample of group)
      if (sample.device) devices.set(sample.device.observedAt, sample.device);
    const deviceSamples = [...devices.values()];
    return {
      configuration,
      samples: group.length,
      roundTripMs: distribution(
        group.map((sample) => sample.telemetry.roundTripMs),
      ),
      decodeMs: distribution(group.map((sample) => sample.telemetry.decodeMs)),
      jitterBufferMs: distribution(
        group.map((sample) => sample.telemetry.jitterBufferMs),
      ),
      jitterMs: distribution(group.map((sample) => sample.telemetry.jitterMs)),
      framesPerSecond: distribution(
        group.map((sample) => sample.telemetry.framesPerSecond),
      ),
      incomingFramesPerSecond: distribution(
        group.map((sample) => sample.telemetry.incomingFramesPerSecond),
      ),
      decodedFramesPerSecond: distribution(
        group.map((sample) => sample.telemetry.decodedFramesPerSecond),
      ),
      displayedFramesPerSecond: distribution(
        group.map((sample) => sample.telemetry.displayedFramesPerSecond),
      ),
      rollingFrameIntervalP95Ms: distribution(
        group.map((sample) => sample.telemetry.frameIntervalP95Ms),
      ),
      rollingFrameIntervalP99Ms: distribution(
        group.map((sample) => sample.telemetry.frameIntervalP99Ms),
      ),
      packetLossPercent: distribution(
        group.map((sample) => sample.telemetry.packetLossPercent),
      ),
      bitrateMbps: distribution(
        group.map((sample) => sample.telemetry.bitrateMbps),
      ),
      inputPollMeanIntervalMs: distribution(
        group.map((sample) => sample.telemetry.inputPolling?.meanIntervalMs),
      ),
      inputPollMeanJitterMs: distribution(
        group.map((sample) => sample.telemetry.inputPolling?.meanJitterMs),
      ),
      inputPollWindowMaxIntervalMs: distribution(
        group.map((sample) => sample.telemetry.inputPolling?.maxIntervalMs),
      ),
      processCpuPercent: distribution(
        deviceSamples.map((sample) => sample.processCpuPercent),
      ),
      batteryWatts: distribution(
        deviceSamples.map((sample) => sample.batteryWatts),
      ),
      temperatureCelsius: distribution(
        deviceSamples.map((sample) => sample.temperatureCelsius),
      ),
    };
  });
}
