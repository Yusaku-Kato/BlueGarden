import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriState = { available: true };
const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => tauriState.available,
  invoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
}));

const { SecureStoreError, createMemorySecureStore, tauriSecureStore } = await import("./secureStore");

beforeEach(() => {
  tauriState.available = true;
  invokeMock.mockReset();
});

describe("tauriSecureStore", () => {
  it("calls the secret_* commands with key and value", async () => {
    invokeMock.mockResolvedValueOnce("stored-value");
    expect(await tauriSecureStore.get("session.oauth")).toBe("stored-value");
    expect(invokeMock).toHaveBeenLastCalledWith("secret_get", { key: "session.oauth" });

    invokeMock.mockResolvedValueOnce(undefined);
    await tauriSecureStore.set("session.appPassword", "value");
    expect(invokeMock).toHaveBeenLastCalledWith("secret_set", { key: "session.appPassword", value: "value" });

    invokeMock.mockResolvedValueOnce(undefined);
    await tauriSecureStore.delete("session.oauth");
    expect(invokeMock).toHaveBeenLastCalledWith("secret_delete", { key: "session.oauth" });
  });

  it("maps a missing value to null", async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await tauriSecureStore.get("session.oauth")).toBeNull();
    invokeMock.mockResolvedValueOnce(undefined);
    expect(await tauriSecureStore.get("session.oauth")).toBeNull();
  });

  it("maps the fixed Rust error strings and hides anything else as unavailable", async () => {
    invokeMock.mockRejectedValueOnce("tooLarge");
    await expect(tauriSecureStore.set("session.oauth", "x")).rejects.toMatchObject({ code: "tooLarge" });
    invokeMock.mockRejectedValueOnce("invalidKey");
    await expect(tauriSecureStore.get("session.oauth")).rejects.toMatchObject({ code: "invalidKey" });
    invokeMock.mockRejectedValueOnce(new Error("secret-bearing message"));
    const error: unknown = await tauriSecureStore.get("session.oauth").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecureStoreError);
    expect(error).toMatchObject({ code: "unavailable" });
    expect(error instanceof Error ? error.message : "").not.toContain("secret-bearing");
  });

  it("is unavailable outside Tauri without calling invoke", async () => {
    tauriState.available = false;
    await expect(tauriSecureStore.get("session.oauth")).rejects.toMatchObject({ code: "unavailable" });
    await expect(tauriSecureStore.set("session.oauth", "x")).rejects.toMatchObject({ code: "unavailable" });
    await expect(tauriSecureStore.delete("session.oauth")).rejects.toMatchObject({ code: "unavailable" });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("createMemorySecureStore", () => {
  it("stores, reads and deletes", async () => {
    const store = createMemorySecureStore();
    await store.set("session.oauth", "v");
    expect(await store.get("session.oauth")).toBe("v");
    expect(store.size).toBe(1);
    await store.delete("session.oauth");
    expect(await store.get("session.oauth")).toBeNull();
  });
});
