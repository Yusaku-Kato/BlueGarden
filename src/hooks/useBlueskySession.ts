import { useCallback, useEffect, useRef, useState } from "react";
import type { DisplayError } from "../app/displayErrors";
import { errorName, logger } from "../infra/logger";
import {
  login,
  loginWithOAuth,
  normalizeIdentifier,
  restoreSession,
  validateIdentifier,
  type BlueskySessionHandle,
  type GardenAccess,
  type SessionHooks,
} from "../services/bluesky/blueskySession";
import { GardenError, type GardenErrorKind } from "../services/bluesky/errors";
import { createGuestAccess } from "../services/bluesky/guestAccess";

/** Advisory App Password shape check for the login form (keeps components off the services layer). */
export { looksLikeAppPassword } from "../services/bluesky/blueskySession";

/** "restoring": reading a remembered login from the OS secret store on startup. */
export type SessionStatus = "restoring" | "signedOut" | "signingIn" | "authenticated" | "guest";

/** Which sign-in is in flight while status is "signingIn". */
export type PendingLogin = "appPassword" | "oauth";

/** Non-blocking information (not an error). */
export type SessionNotice = "secureStorageUnavailable";

export interface BlueskySessionState {
  readonly status: SessionStatus;
  /** Signed-in session or guest. Null when signed out. */
  readonly access: GardenAccess | null;
  /** The signed-in session; null for guests and when signed out. */
  readonly session: BlueskySessionHandle | null;
  readonly authError: DisplayError | null;
  readonly notice: SessionNotice | null;
  readonly pendingLogin: PendingLogin | null;
  /** React 19 form action. Reads identifier, appPassword and the "remember" checkbox from the form data. */
  loginAction: (formData: FormData) => Promise<void>;
  /** System-browser OAuth (docs/DESIGN.md section 36.4). Any identifier (handle, DID, email, blank) is accepted. */
  loginWithOAuthAction: (identifier: string, remember: boolean) => Promise<void>;
  /** Aborts a pending OAuth attempt without showing an error. */
  cancelOAuth: () => void;
  /** Global Garden without an account. */
  enterAsGuest: () => void;
  /** Works for guests too: clears the access and returns to the login screen. */
  logout: () => Promise<void>;
  dismissNotice: () => void;
  /** Transitions to signedOut with an error. Ignored when logging out or when no access is current. */
  reportSessionLost: (kind?: GardenErrorKind) => void;
}

function authError(kind: GardenErrorKind): DisplayError {
  return { source: "auth", kind };
}

function kindOf(caught: unknown, where: string): GardenErrorKind {
  if (caught instanceof GardenError) return caught.kind;
  logger.error("unexpected", { where, error: errorName(caught) });
  return "unknown";
}

/**
 * Owns the access lifecycle (docs/DESIGN.md sections 7.2, 35.5, 36.4): restore on startup, App
 * Password login, OAuth login, guest, logout. The App Password is read from FormData and passed
 * straight to login(); it is never stored in state, refs or logs. Every attempt gets an id; a
 * result that arrives for a superseded attempt is logged out instead of adopted.
 */
export function useBlueskySession(): BlueskySessionState {
  const [status, setStatus] = useState<SessionStatus>("restoring");
  const [access, setAccess] = useState<GardenAccess | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [notice, setNotice] = useState<SessionNotice | null>(null);
  const [pendingLogin, setPendingLogin] = useState<PendingLogin | null>(null);

  const signingInRef = useRef(false);
  const loggingOutRef = useRef(false);
  const attemptCounterRef = useRef(0);
  /** Attempt id of the current access, or null. */
  const activeAttemptRef = useRef<number | null>(null);
  const activeAccessRef = useRef<GardenAccess | null>(null);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const restoreStartedRef = useRef(false);
  const disposedRef = useRef(false);

  const lostForAttempt = useCallback((attemptId: number, kind: GardenErrorKind): void => {
    if (loggingOutRef.current) return;
    if (activeAttemptRef.current !== attemptId) return;
    const handle = activeAccessRef.current;
    activeAttemptRef.current = null;
    activeAccessRef.current = null;
    setAccess(null);
    setStatus("signedOut");
    setError(authError(kind));
    if (handle !== null) void handle.logout(); // idempotent, never rejects
  }, []);

  const hooksFor = useCallback(
    (attemptId: number): SessionHooks => ({
      onSessionLost: () => {
        lostForAttempt(attemptId, "sessionExpired");
      },
      onNotice: (notified) => {
        if (attemptCounterRef.current !== attemptId || disposedRef.current) return;
        if (notified.kind === "secureStorageUnavailable") setNotice("secureStorageUnavailable");
      },
    }),
    [lostForAttempt],
  );

  const adopt = useCallback((handle: GardenAccess, attemptId: number): void => {
    activeAttemptRef.current = attemptId;
    activeAccessRef.current = handle;
    setAccess(handle);
    setStatus(handle.authMethod === "guest" ? "guest" : "authenticated");
  }, []);

  // Startup restore: once, even under StrictMode (refs survive the simulated remount).
  useEffect(() => {
    disposedRef.current = false;
    if (!restoreStartedRef.current) {
      restoreStartedRef.current = true;
      attemptCounterRef.current += 1;
      const attemptId = attemptCounterRef.current;
      restoreSession(hooksFor(attemptId)).then(
        (handle) => {
          if (disposedRef.current) return; // closing: keep the remembered login in the store
          if (attemptCounterRef.current !== attemptId) {
            if (handle !== null) void handle.logout(); // superseded by a manual sign-in
            return;
          }
          if (handle === null) setStatus("signedOut");
          else adopt(handle, attemptId);
        },
        (caught: unknown) => {
          logger.warn("session.restoreFailed", { error: errorName(caught) });
          if (disposedRef.current || attemptCounterRef.current !== attemptId) return;
          setStatus("signedOut");
          setError(authError("sessionExpired"));
        },
      );
    }
    return () => {
      disposedRef.current = true;
      oauthAbortRef.current?.abort();
    };
  }, [adopt, hooksFor]);

  const reportSessionLost = useCallback(
    (kind: GardenErrorKind = "sessionExpired"): void => {
      const attemptId = activeAttemptRef.current;
      if (attemptId === null) return;
      lostForAttempt(attemptId, kind);
    },
    [lostForAttempt],
  );

  /** Shared by both sign-in methods. `start` receives the attempt id and returns the new handle. */
  const runSignIn = useCallback(
    async (
      method: PendingLogin,
      start: (attemptId: number) => Promise<BlueskySessionHandle>,
    ): Promise<void> => {
      signingInRef.current = true;
      attemptCounterRef.current += 1;
      const attemptId = attemptCounterRef.current;
      setError(null);
      setNotice(null);
      setPendingLogin(method);
      setStatus("signingIn");
      try {
        const handle = await start(attemptId);
        if (disposedRef.current || attemptCounterRef.current !== attemptId) {
          void handle.logout(); // superseded: never keep a session nobody owns
          return;
        }
        adopt(handle, attemptId);
      } catch (caught) {
        const kind = kindOf(caught, method === "oauth" ? "loginWithOAuth" : "login");
        if (!disposedRef.current && attemptCounterRef.current === attemptId) {
          setStatus("signedOut");
          setError(authError(kind));
        }
      } finally {
        // A cancelled or superseded attempt was already cleaned up by whoever superseded it.
        if (attemptCounterRef.current === attemptId) {
          signingInRef.current = false;
          oauthAbortRef.current = null;
          if (!disposedRef.current) setPendingLogin(null);
        }
      }
    },
    [adopt],
  );

  const loginAction = useCallback(
    async (formData: FormData): Promise<void> => {
      if (signingInRef.current || activeAccessRef.current !== null) return;

      const rawIdentifier = formData.get("identifier");
      const identifier = normalizeIdentifier(typeof rawIdentifier === "string" ? rawIdentifier : "");
      const invalid = validateIdentifier(identifier);
      if (invalid !== null) {
        setError(authError(invalid.kind));
        return;
      }
      const password = formData.get("appPassword");
      if (typeof password !== "string" || password.length === 0) {
        setError(authError("invalidCredentials"));
        return;
      }
      const remember = formData.get("remember") !== null;

      await runSignIn("appPassword", (attemptId) =>
        login(identifier, password, hooksFor(attemptId), { remember }),
      );
    },
    [runSignIn, hooksFor],
  );

  const loginWithOAuthAction = useCallback(
    async (rawIdentifier: string, remember: boolean): Promise<void> => {
      if (signingInRef.current || activeAccessRef.current !== null) return;
      // Email, blank and free text are valid here: the services layer authorizes against
      // bsky.social and the user signs in in the browser. Handles and DIDs are used directly.
      const identifier = normalizeIdentifier(rawIdentifier);
      const controller = new AbortController();
      oauthAbortRef.current = controller;
      await runSignIn("oauth", (attemptId) =>
        loginWithOAuth(identifier, hooksFor(attemptId), { remember, signal: controller.signal }),
      );
    },
    [runSignIn, hooksFor],
  );

  const cancelOAuth = useCallback((): void => {
    const controller = oauthAbortRef.current;
    if (controller === null) return;
    // Bumping the counter makes a late result (e.g. a redirect that finishes after the cancel)
    // a superseded attempt: it is logged out instead of adopted.
    attemptCounterRef.current += 1;
    oauthAbortRef.current = null;
    signingInRef.current = false;
    setPendingLogin(null);
    setStatus("signedOut");
    setError(null);
    controller.abort();
  }, []);

  const enterAsGuest = useCallback((): void => {
    if (signingInRef.current || activeAccessRef.current !== null) return;
    attemptCounterRef.current += 1; // supersedes a pending restore
    setError(null);
    setNotice(null);
    adopt(createGuestAccess(), attemptCounterRef.current);
  }, [adopt]);

  const logout = useCallback(async (): Promise<void> => {
    const handle = activeAccessRef.current;
    if (handle === null) return;
    loggingOutRef.current = true;
    activeAttemptRef.current = null;
    activeAccessRef.current = null;
    setAccess(null);
    setStatus("signedOut");
    setError(null);
    setNotice(null);
    try {
      await handle.logout();
    } finally {
      loggingOutRef.current = false;
    }
  }, []);

  const dismissNotice = useCallback((): void => {
    setNotice(null);
  }, []);

  const session = access !== null && access.authMethod !== "guest" ? access : null;

  return {
    status,
    access,
    session,
    authError: error,
    notice,
    pendingLogin,
    loginAction,
    loginWithOAuthAction,
    cancelOAuth,
    enterAsGuest,
    logout,
    dismissNotice,
    reportSessionLost,
  };
}
