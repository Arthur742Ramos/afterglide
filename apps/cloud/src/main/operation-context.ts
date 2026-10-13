import { AfterglideError } from "./errors";

export interface OperationContext {
  signal?: AbortSignal;
  deadline?: number;
}

export const CLOUD_OPERATION_LIMITS = {
  catalogMs: 90_000,
  searchMs: 30_000,
  provisioningMs: 180_000,
  searchPages: 32,
  searchProducts: 10_000,
} as const;

/** One clock and cancellation scope across requests, bodies and backoff. */
export class CloudOperation implements OperationContext {
  readonly signal: AbortSignal;
  readonly deadline: number;
  private readonly controller = new AbortController();
  private readonly unlink: Array<() => void> = [];
  private readonly timeout: ReturnType<typeof setTimeout>;

  constructor(
    context: OperationContext | undefined,
    timeoutMs: number,
    ...parents: Array<AbortSignal | undefined>
  ) {
    this.signal = this.controller.signal;
    this.deadline = Math.min(
      context?.deadline ?? Infinity,
      Date.now() + timeoutMs,
    );
    for (const parent of [context?.signal, ...parents]) {
      if (!parent) continue;
      const abort = () =>
        this.controller.abort(
          parent.reason instanceof AfterglideError
            ? parent.reason
            : operationCancelled(),
        );
      if (parent.aborted) abort();
      else {
        parent.addEventListener("abort", abort, { once: true });
        this.unlink.push(() => parent.removeEventListener("abort", abort));
      }
    }
    this.timeout = setTimeout(
      () => this.controller.abort(operationTimeout()),
      Math.max(0, this.deadline - Date.now()),
    );
  }

  check(): void {
    if (this.signal.aborted) throw this.signal.reason;
    if (Date.now() >= this.deadline) {
      this.controller.abort(operationTimeout());
      throw this.signal.reason;
    }
  }

  async wait<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    let onAbort!: () => void;
    const cancellation = new Promise<never>((_, reject) => {
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([work(), cancellation]);
      this.check();
      return result;
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  async delay(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.wait(
        () =>
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ms);
          }),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  dispose(): void {
    this.controller.abort(operationCancelled());
    clearTimeout(this.timeout);
    for (const unlink of this.unlink) unlink();
  }
}

export function operationCancelled(): AfterglideError {
  return new AfterglideError(
    "OPERATION_CANCELLED",
    "The operation was cancelled.",
    false,
  );
}

function operationTimeout(): AfterglideError {
  return new AfterglideError(
    "XBOX_TIMEOUT",
    "Xbox services took too long to respond. Check your network and try again.",
  );
}
