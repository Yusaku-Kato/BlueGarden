import { l } from "@atproto/lex";
import type { SessionData } from "@atproto/lex-password-session";
import { type SecretKey, type SecureStore, SecureStoreError } from "../../infra/secureStore";
import { readString } from "./untrusted";

/**
 * Persistence of App Password sessions (docs/DESIGN.md §35.5). Only the refreshable session data
 * is stored, never the App Password. The stored JSON is untrusted input when read back.
 */
export const APP_PASSWORD_SECRET: SecretKey = "session.appPassword";
export const OAUTH_SECRET: SecretKey = "session.oauth";

const STORED_VERSION = 1;

/** Minimal subset of SessionData: tokens, identity and service. Email and didDoc are not kept. */
export function serializeSessionData(data: SessionData): string {
  return JSON.stringify({
    v: STORED_VERSION,
    accessJwt: data.accessJwt,
    refreshJwt: data.refreshJwt,
    handle: data.handle,
    did: data.did,
    service: data.service,
  });
}

/** Returns null for anything that is not a well-formed stored session. */
export function parseSessionData(raw: string): SessionData | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const accessJwt = readString(json, "accessJwt");
  const refreshJwt = readString(json, "refreshJwt");
  const handle = readString(json, "handle");
  const did = readString(json, "did");
  const service = readString(json, "service");
  if (accessJwt === undefined || refreshJwt === undefined || accessJwt === "" || refreshJwt === "") return null;
  if (handle === undefined || did === undefined || service === undefined) return null;
  if (!l.isHandleString(handle) || !l.isDidString(did)) return null;
  return { accessJwt, refreshJwt, handle, did, service };
}

export interface AppPasswordPersistence {
  /** Rejects with SecureStoreError. */
  save(data: SessionData): Promise<void>;
  /** Resolves the raw stored text, or null when nothing is stored. */
  load(): Promise<string | null>;
  /** Deleting a missing entry succeeds. */
  clear(): Promise<void>;
}

export function createAppPasswordPersistence(store: SecureStore): AppPasswordPersistence {
  return {
    save: (data) => store.set(APP_PASSWORD_SECRET, serializeSessionData(data)),
    load: () => store.get(APP_PASSWORD_SECRET),
    clear: () => store.delete(APP_PASSWORD_SECRET),
  };
}

/** Fixed code for logs: never the stored value. */
export function storeErrorCode(error: unknown): string {
  return error instanceof SecureStoreError ? error.code : "unknown";
}
