import type {
  AppSettings,
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
  settings: Pick<AppSettings, "resolution" | "inputPolling" | "videoFit">;
  device?: DeviceMetrics;
}

const sampleLimit = 3_600;

export class PerformanceReport {
  private samples: Sample[] = [];
  private next = 0;
  private totalSamples = 0;
  private startedAt = Date.now();
  private source?: StreamSource;
  private connectionNumber = 0;
  private recoveries: { startedAt: number; durationMs: number }[] = [];

  reset(source: StreamSource): void {
    this.samples = [];
    this.next = 0;
    this.totalSamples = 0;
    this.startedAt = Date.now();
    this.source = source;
    this.recoveries = [];
    this.connectionNumber = 0;
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
      application: { name: "Afterglide", version, environment },
      startedAt: this.startedAt,
      exportedAt: Date.now(),
      source: this.source,
      totalSamples: this.totalSamples,
      retainedSamples: samples.length,
      droppedSamples: this.totalSamples - samples.length,
      hardware: {
        acceleration: hardware.acceleration,
        videoDecode: hardware.videoDecode,
        gpu: hardware.gpu,
      },
      measurementNotes: [
        "Latest 3600 telemetry samples; older samples are evicted.",
        "Test-environment samples are simulated, not hardware evidence.",
        "Ping is RTT; presented-frame cadence is not button-to-photon latency.",
        "Decoder identity is reported by Chromium, not proof of hardware decoding.",
        "CPU is the sum of Electron process percentCPUUsage readings.",
        "Device measurements are sampled every 5 seconds; observedAt identifies repeated readings.",
        "Battery watts are whole-device discharge power, not application-only power.",
        "Thermal readings are device sensors, not proof of throttling.",
        "Freeze/drop counters are cumulative per media session and reset on reconnect.",
        "Summaries group retained samples by requested resolution and input polling; device timestamps are deduplicated within each group.",
        "Frame-interval summaries are distributions of rolling-window percentiles, not global frame percentiles.",
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
    const key = `${sample.settings.resolution}p/${sample.settings.inputPolling}`;
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
      framesPerSecond: distribution(
        group.map((sample) => sample.telemetry.framesPerSecond),
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
