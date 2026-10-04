import { afterEach, describe, expect, it } from "vitest";
import {
  errorName,
  logger,
  REDACTED,
  redactFields,
  setLogSinkForTesting,
  type LogFields,
  type LogLevel,
} from "./logger";

interface Entry {
  level: LogLevel;
  event: string;
  fields: LogFields | undefined;
}

let restore: (() => void) | null = null;

function capture(): Entry[] {
  const entries: Entry[] = [];
  restore = setLogSinkForTesting((level, event, fields) => {
    entries.push({ level, event, fields });
  });
  return entries;
}

afterEach(() => {
  restore?.();
  restore = null;
});

describe("redactFields", () => {
  it("redacts secret-looking keys", () => {
    const result = redactFields({
      password: "x",
      accessJwt: "y",
      refreshToken: "z",
      Authorization: "a",
      clientSecret: "b",
      cookie: "c",
      kind: "network",
    });
    expect(result).toEqual({
      password: REDACTED,
      accessJwt: REDACTED,
      refreshToken: REDACTED,
      Authorization: REDACTED,
      clientSecret: REDACTED,
      cookie: REDACTED,
      kind: "network",
    });
  });

  it("redacts JWT-shaped and App Password-shaped values", () => {
    const result = redactFields({
      a: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0",
      b: "abcd-efgh-ijkl-mnop",
      c: "prefix abcd-1234-ijkl-mnop suffix",
      d: "harmless",
      e: 5,
    });
    expect(result).toEqual({ a: REDACTED, b: REDACTED, c: REDACTED, d: "harmless", e: 5 });
  });

  it("redacts OAuth keys (code, state, verifier, dpop, refresh)", () => {
    const result = redactFields({
      code: "c",
      State: "s",
      verifier: "v",
      dpopJwk: "d",
      refresh: "r",
      refresh_token: "r2",
      reason: "unavailable",
      stateful: "kept",
      codec: "kept",
    });
    expect(result).toEqual({
      code: REDACTED,
      State: REDACTED,
      verifier: REDACTED,
      dpopJwk: REDACTED,
      refresh: REDACTED,
      refresh_token: REDACTED,
      reason: "unavailable",
      stateful: "kept",
      codec: "kept",
    });
  });

  it("redacts values that are URLs or query strings carrying an OAuth code, state or token", () => {
    const result = redactFields({
      a: "http://127.0.0.1:5000/callback?state=abc&iss=x",
      b: "http://127.0.0.1:5000/callback?iss=x&code=abc",
      c: "?access_token=zzz",
      d: "http://127.0.0.1:5000/callback",
      e: "decode=1 and statement=2",
    });
    expect(result).toEqual({
      a: REDACTED,
      b: REDACTED,
      c: REDACTED,
      d: "http://127.0.0.1:5000/callback",
      e: "decode=1 and statement=2",
    });
  });

  it("passes undefined through", () => {
    expect(redactFields(undefined)).toBeUndefined();
  });
});

describe("logger", () => {
  it("routes redacted fields to the sink", () => {
    const entries = capture();
    logger.warn("api.error", { kind: "network", token: "secret" });
    expect(entries).toEqual([
      { level: "warn", event: "api.error", fields: { kind: "network", token: REDACTED } },
    ]);
  });
});

describe("errorName", () => {
  it("never exposes the message, even if it contains post text", () => {
    const error = new SyntaxError("Unexpected token in synthetic post body text");
    const entries = capture();
    logger.error("unexpected", { error: errorName(error) });
    expect(JSON.stringify(entries)).not.toContain("synthetic post body");
    expect(errorName(error)).toBe("SyntaxError");
  });

  it("describes non-Error values by type", () => {
    expect(errorName("boom")).toBe("string");
    expect(errorName(undefined)).toBe("undefined");
  });
});
