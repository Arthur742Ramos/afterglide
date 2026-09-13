export class AfterglideError extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(
    code: string,
    message: string,
    recoverable = true,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AfterglideError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export function safeError(error: unknown): AfterglideError {
  if (error instanceof AfterglideError) return error;

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("timeout")) {
      return new AfterglideError(
        "TIMEOUT",
        "That took longer than expected. Check your connection and try again.",
        true,
        {
          cause: error,
        },
      );
    }
    if (
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("unauthor")
    ) {
      return new AfterglideError(
        "AUTH_EXPIRED",
        "Your Xbox sign-in needs to be refreshed.",
        true,
        { cause: error },
      );
    }
  }

  return new AfterglideError(
    "CONNECTION_FAILED",
    "Afterglide could not reach your Xbox. Make sure remote play is enabled and try again.",
    true,
    { cause: error },
  );
}

export function errorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redact(error.message),
      stack: redact(error.stack ?? ""),
    };
  }
  return { value: redact(String(error)) };
}

export function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(?:access|refresh|user|gs)[_-]?token["'=:\s]+[A-Za-z0-9._~+/=-]+/gi,
      "token=[REDACTED]",
    )
    .replace(
      /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      "[REDACTED_JWT]",
    );
}
