export type RecoveryStatus =
  | "idle"
  | "waiting"
  | "offline"
  | "retrying"
  | "exhausted";
export interface RecoveryState {
  status: RecoveryStatus;
  attempts: number;
}

export const RECOVERY_DELAYS_MS = [700, 1_400, 2_800] as const;

/** A budget spans replacement sessions: provisioning is not proof of healthy video. */
export class StreamRecovery<T> {
  private generation = 0;
  private active = false;
  private online = true;
  private attempts = 0;
  private pending = false;
  private inFlight = false;
  private interrupted = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: {
      retry: () => Promise<T>;
      onAttempt: () => void;
      onRecovered: (value: T) => void;
      onState: (state: RecoveryState) => void;
    },
  ) {}

  begin(): void {
    this.cancel();
    this.active = true;
    this.attempts = 0;
    this.interrupted.clear();
  }

  cancel(): void {
    this.generation++;
    this.active = false;
    this.pending = false;
    this.inFlight = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.emit("idle");
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (!this.active || !this.pending || this.inFlight) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule();
  }

  interrupt(sessionId: string): void {
    if (!this.active || this.interrupted.has(sessionId)) return;
    this.interrupted.add(sessionId);
    this.pending = true;
    if (!this.inFlight && this.timer === undefined) this.schedule();
  }

  private emit(status: RecoveryStatus): void {
    this.options.onState({ status, attempts: this.attempts });
  }

  private schedule(): void {
    if (!this.active || !this.pending) return;
    if (this.attempts >= RECOVERY_DELAYS_MS.length) {
      this.emit("exhausted");
      return;
    }
    if (!this.online) {
      this.emit("offline");
      return;
    }
    this.emit("waiting");
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (generation !== this.generation || !this.active) return;
      if (!this.online) {
        this.emit("offline");
        return;
      }
      void this.attempt(generation);
    }, RECOVERY_DELAYS_MS[this.attempts]);
  }

  private async attempt(generation: number): Promise<void> {
    this.inFlight = true;
    this.attempts++;
    this.emit("retrying");
    this.options.onAttempt();
    try {
      const value = await this.options.retry();
      if (generation !== this.generation || !this.active) return;
      this.inFlight = false;
      this.pending = false;
      this.emit("idle");
      this.options.onRecovered(value);
    } catch {
      if (generation !== this.generation || !this.active) return;
      this.inFlight = false;
      this.schedule();
    }
  }
}
