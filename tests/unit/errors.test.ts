import { describe, expect, it } from "vitest";
import { redact, safeError } from "../../src/main/errors";

describe("safe errors", () => {
  it("redacts bearer, refresh, and JWT-shaped secrets", () => {
    const input =
      'Bearer abc.def+123 refresh_token="verylongsecretvalue" eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
    const output = redact(input);
    expect(output).not.toContain("abc.def+123");
    expect(output).not.toContain("verylongsecretvalue");
    expect(output).not.toContain("eyJhbGci");
  });

  it("turns network internals into an actionable public message", () => {
    const error = safeError(new Error("socket hang up with internal host"));
    expect(error.code).toBe("CONNECTION_FAILED");
    expect(error.message).toContain("remote play");
    expect(error.message).not.toContain("internal host");
  });
});
