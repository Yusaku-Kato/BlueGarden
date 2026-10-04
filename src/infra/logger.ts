/**
 * Leveled logger with secret redaction (docs/DESIGN.md §21).
 *
 * - Fields accept primitives only, so whole objects (sessions, responses, errors) cannot be logged.
 * - Keys that look secret and values that look like tokens / App Passwords are redacted.
 * - debug output exists only in development builds.
 */

export type LogValue = string | number | boolean;
export type LogFields = Readonly<Record<string, LogValue>>;
export type LogLevel = "debug" | "info" | "warn" | "error";

export const REDACTED = "[REDACTED]";

const SECRET_KEY_PATTERN = /password|jwt|token|authorization|secret|cookie|verifier|dpop|refresh/i;
/** OAuth callback parameters. Exact match: a looser "code" / "state" pattern would hide unrelated fields. */
const OAUTH_PARAM_KEY_PATTERN = /^(?:code|state)$/i;
/** URLs and query strings that carry an OAuth authorization code, state or token. */
const OAUTH_QUERY_VALUE_PATTERN = /[?&#](?:code|state|access_token|refresh_token|id_token)=/i;
const JWT_VALUE_PATTERN = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/;
const APP_PASSWORD_VALUE_PATTERN = /\b[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b/i;

export function redactFields(fields: LogFields | undefined): LogFields | undefined {
  if (fields === undefined) return undefined;
  const result: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = isSecret(key, value) ? REDACTED : value;
  }
  return result;
}

function isSecret(key: string, value: LogValue): boolean {
  if (SECRET_KEY_PATTERN.test(key) || OAUTH_PARAM_KEY_PATTERN.test(key)) return true;
  if (typeof value !== "string") return false;
  return (
    JWT_VALUE_PATTERN.test(value) ||
    APP_PASSWORD_VALUE_PATTERN.test(value) ||
    OAUTH_QUERY_VALUE_PATTERN.test(value)
  );
}

type Sink = (level: LogLevel, event: string, fields: LogFields | undefined) => void;

const consoleSink: Sink = (level, event, fields) => {
  const line = `[BlueGarden] ${event}`;
  const args = fields === undefined ? [line] : [line, fields];
  switch (level) {
    case "debug":
      console.debug(...args);
      break;
    case "info":
      console.info(...args);
      break;
    case "warn":
      console.warn(...args);
      break;
    case "error":
      console.error(...args);
      break;
  }
};

let sink: Sink = consoleSink;
const debugEnabled = import.meta.env.DEV;

function write(level: LogLevel, event: string, fields?: LogFields): void {
  if (level === "debug" && !debugEnabled) return;
  sink(level, event, redactFields(fields));
}

export const logger = {
  debug: (event: string, fields?: LogFields) => {
    write("debug", event, fields);
  },
  info: (event: string, fields?: LogFields) => {
    write("info", event, fields);
  },
  warn: (event: string, fields?: LogFields) => {
    write("warn", event, fields);
  },
  error: (event: string, fields?: LogFields) => {
    write("error", event, fields);
  },
};

/** Replace the output sink (tests only). Returns a function that restores the previous sink. */
export function setLogSinkForTesting(next: Sink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

/**
 * Safe description of an unknown thrown value: its constructor name only.
 * Error messages may contain request fragments or post text, so they are never logged.
 */
export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
