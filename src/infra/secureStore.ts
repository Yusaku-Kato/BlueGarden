import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * OS-backed secret storage through the Rust commands `secret_get` / `secret_set` / `secret_delete`
 * (docs/DESIGN.md §35.7). Only the session data needed to resume a login is stored here, never the
 * App Password itself. Values are not logged. Outside Tauri every operation fails with
 * `unavailable`; callers treat that as "continue without remembering".
 */
export type SecretKey = "session.appPassword" | "session.oauth";
export type SecureStoreErrorCode = "invalidKey" | "tooLarge" | "unavailable";

export class SecureStoreError extends Error {
  readonly code: SecureStoreErrorCode;

  constructor(code: SecureStoreErrorCode) {
    super(`Secure store: ${code}`);
    this.name = "SecureStoreError";
    this.code = code;
  }
}

export interface SecureStore {
  /** Resolves null when the key has no value. Rejects with SecureStoreError. */
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
  /** Deleting a missing key succeeds. */
  delete(key: SecretKey): Promise<void>;
}

function toStoreError(error: unknown): SecureStoreError {
  if (error instanceof SecureStoreError) return error;
  if (error === "invalidKey" || error === "tooLarge") return new SecureStoreError(error);
  return new SecureStoreError("unavailable");
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new SecureStoreError("unavailable");
  try {
    return await invoke<T>(command, args);
  } catch (error: unknown) {
    throw toStoreError(error);
  }
}

export const tauriSecureStore: SecureStore = {
  async get(key) {
    const value = await call<unknown>("secret_get", { key });
    return typeof value === "string" ? value : null;
  },
  async set(key, value) {
    await call<unknown>("secret_set", { key, value });
  },
  async delete(key) {
    await call<unknown>("secret_delete", { key });
  },
};

/** In-memory store, used by tests and as a fake. Nothing leaves the process. */
export function createMemorySecureStore(): SecureStore & { readonly size: number } {
  const values = new Map<SecretKey, string>();
  return {
    get size() {
      return values.size;
    },
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}
