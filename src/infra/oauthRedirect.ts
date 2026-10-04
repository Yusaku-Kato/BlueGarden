import { cancel, onUrl, start } from "@fabianlars/tauri-plugin-oauth";
import { openUrl } from "@tauri-apps/plugin-opener";
import { OAUTH } from "../config/gardenConfig";
import { errorName, logger } from "./logger";

/**
 * Receives the OAuth redirect on a temporary 127.0.0.1 server (tauri-plugin-oauth) and opens the
 * authorization page in the system browser (docs/DESIGN.md §36.4). One attempt at a time; the
 * server and the URL listener are always released. The redirect URL (it carries code and state) is
 * never logged and is only handed to the caller as parsed parameters.
 */
export type OAuthRedirectErrorCode = "busy" | "cancelled" | "timeout" | "failed";

export class OAuthRedirectError extends Error {
  readonly code: OAuthRedirectErrorCode;

  constructor(code: OAuthRedirectErrorCode) {
    super(`OAuth redirect: ${code}`);
    this.name = "OAuthRedirectError";
    this.code = code;
  }
}

export interface OAuthRedirectDeps {
  start(config?: { response?: string }): Promise<number>;
  onUrl(callback: (url: string) => void): Promise<() => void>;
  cancel(port: number): Promise<void>;
  openUrl(url: string): Promise<void>;
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const defaultDeps: OAuthRedirectDeps = {
  start: (config) => start(config),
  onUrl: (callback) => onUrl(callback),
  cancel: (port) => cancel(port),
  openUrl: (url) => openUrl(url),
  setTimeout: (handler, timeout) => setTimeout(handler, timeout),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

/** Static page shown in the browser after the redirect. Contains no data from the request. */
const RESPONSE_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>BlueGarden</title></head>" +
  "<body style=\"font-family:sans-serif\"><p>Sign-in finished. You can close this tab and return to BlueGarden.</p></body></html>";

/** The shape @atproto/oauth-client accepts for loopback redirects. */
export type LoopbackRedirectUri = `http://127.0.0.1:${string}` | `http://127.0.0.1/${string}`;

export interface OAuthRedirectListener {
  /** `http://127.0.0.1:<port>/callback`. The port is only known after the server started. */
  readonly redirectUri: LoopbackRedirectUri;
  /**
   * Opens the authorization page in the system browser and resolves with the redirect's query
   * parameters. Rejects with OAuthRedirectError (cancelled / timeout / failed).
   */
  waitForRedirect(authorizationUrl: string): Promise<URLSearchParams>;
  /** Idempotent. Stops the server and the URL listener. */
  close(): Promise<void>;
}

let attemptActive = false;

function isCallbackUrl(url: string, port: number): URLSearchParams | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const matches =
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    parsed.port === String(port) &&
    parsed.pathname === OAUTH.CALLBACK_PATH &&
    parsed.searchParams.has("state");
  return matches ? parsed.searchParams : null;
}

/** Separate function: `signal.aborted` may have changed during the awaits above. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Starts the loopback server and subscribes to redirects. Only one listener may exist at a time
 * (`busy` otherwise). Aborting `signal` rejects a pending wait with `cancelled`.
 */
export async function listenForOAuthRedirect(
  signal: AbortSignal,
  deps: OAuthRedirectDeps = defaultDeps,
): Promise<OAuthRedirectListener> {
  if (attemptActive) throw new OAuthRedirectError("busy");
  if (signal.aborted) throw new OAuthRedirectError("cancelled");
  attemptActive = true;

  let port: number | null = null;
  let unlisten: (() => void) | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settle: (result: URLSearchParams | OAuthRedirectError) => void = () => undefined;
  const outcome = new Promise<URLSearchParams>((resolve, reject) => {
    settle = (result) => {
      if (result instanceof OAuthRedirectError) reject(result);
      else resolve(result);
    };
  });
  outcome.catch(() => undefined); // a rejection before waitForRedirect() is not an unhandled one

  const onAbort = (): void => {
    settle(new OAuthRedirectError("cancelled"));
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", onAbort);
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
    try {
      unlisten?.();
    } catch (error) {
      logger.warn("oauth.unlistenFailed", { error: errorName(error) });
    }
    unlisten = null;
    try {
      if (port !== null) await deps.cancel(port);
    } catch (error) {
      logger.warn("oauth.serverCloseFailed", { error: errorName(error) });
    }
    attemptActive = false;
  };

  try {
    port = await deps.start({ response: RESPONSE_HTML });
    const listeningPort = port;
    unlisten = await deps.onUrl((url) => {
      const params = isCallbackUrl(url, listeningPort);
      if (params !== null) settle(params);
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (isAborted(signal)) onAbort();
  } catch (error) {
    logger.warn("oauth.startFailed", { error: errorName(error) });
    await close();
    throw new OAuthRedirectError("failed");
  }

  return {
    redirectUri: `http://127.0.0.1:${String(port)}${OAUTH.CALLBACK_PATH}`,
    async waitForRedirect(authorizationUrl) {
      if (closed) throw new OAuthRedirectError("cancelled");
      if (!isHttpsUrl(authorizationUrl)) throw new OAuthRedirectError("failed");
      timer = deps.setTimeout(() => {
        settle(new OAuthRedirectError("timeout"));
      }, OAUTH.TIMEOUT_MS);
      try {
        await deps.openUrl(authorizationUrl);
      } catch (error) {
        logger.warn("oauth.openFailed", { error: errorName(error) });
        throw new OAuthRedirectError("failed");
      }
      return outcome;
    },
    close,
  };
}
