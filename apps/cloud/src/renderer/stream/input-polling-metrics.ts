import type { InputPollingTelemetry } from "../../shared/contracts";

/** One fixed histogram; no allocation, sorting or IPC on individual polls. */
export class InputPollingMetrics {
  private readonly bins = new Float64Array(256);
  private target?: 4 | 8;
  private previous?: number;
  private samples = 0;
  private elapsed = 0;
  private jitter = 0;
  private maximum = 0;
  private longGaps = 0;

  reset(target?: 4 | 8): void {
    this.target = target;
    this.previous = undefined;
    this.clearWindow();
  }

  restart(target?: 4 | 8): void {
    if (this.target !== target) this.reset(target);
    else this.previous = undefined;
  }

  observe(now: number): void {
    if (this.target === undefined || !Number.isFinite(now)) return;
    const previous = this.previous;
    this.previous = now;
    if (previous === undefined || now <= previous) return;
    const interval = now - previous;
    this.samples++;
    this.elapsed += interval;
    this.jitter += Math.abs(interval - this.target);
    this.maximum = Math.max(this.maximum, interval);
    if (interval > 32) this.longGaps++;
    this.bins[Math.min(255, Math.ceil(interval))]++;
  }

  snapshot(): InputPollingTelemetry | undefined {
    if (this.target === undefined || !this.samples) return undefined;
    const rank = Math.ceil(this.samples * 0.95);
    let count = 0;
    let upper = 0;
    for (; upper < 255; upper++) {
      count += this.bins[upper];
      if (count >= rank) break;
    }
    const result = {
      targetMs: this.target,
      samples: this.samples,
      windowMs: this.elapsed,
      meanIntervalMs: this.elapsed / this.samples,
      p95UpperMs: upper === 255 ? this.maximum : upper,
      maxIntervalMs: this.maximum,
      meanJitterMs: this.jitter / this.samples,
      longGaps: this.longGaps,
    };
    this.clearWindow();
    return result;
  }

  private clearWindow(): void {
    this.bins.fill(0);
    this.samples = 0;
    this.elapsed = 0;
    this.jitter = 0;
    this.maximum = 0;
    this.longGaps = 0;
  }
}
