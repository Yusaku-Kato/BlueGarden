import { describe, expect, it } from "vitest";
import { createMemorySecureStore } from "../../infra/secureStore";
import { createAppPasswordPersistence, parseSessionData, serializeSessionData } from "./sessionPersistence";

const DATA = {
  accessJwt: "synthetic-access",
  refreshJwt: "synthetic-refresh",
  handle: "alice.test",
  did: "did:plc:abcdefghijklmnopqrstuvwx",
  service: "https://bsky.social",
  email: "alice@example.test",
  emailConfirmed: true,
  didDoc: { id: "did:plc:abcdefghijklmnopqrstuvwx" },
} as const;

describe("session data serialization", () => {
  it("round-trips the session fields and drops email and didDoc", () => {
    const text = serializeSessionData(DATA);
    expect(text).not.toContain("alice@example.test");
    expect(text).not.toContain("didDoc");
    expect(parseSessionData(text)).toEqual({
      accessJwt: "synthetic-access",
      refreshJwt: "synthetic-refresh",
      handle: "alice.test",
      did: "did:plc:abcdefghijklmnopqrstuvwx",
      service: "https://bsky.social",
    });
  });

  it.each([
    ["not json", "{"],
    ["array", "[]"],
    ["null", "null"],
    ["missing refresh", JSON.stringify({ accessJwt: "a", handle: "alice.test", did: "did:plc:x", service: "s" })],
    ["empty tokens", JSON.stringify({ accessJwt: "", refreshJwt: "", handle: "alice.test", did: "did:plc:x", service: "s" })],
    ["bad handle", JSON.stringify({ accessJwt: "a", refreshJwt: "r", handle: "no spaces allowed", did: "did:plc:x", service: "s" })],
    ["bad did", JSON.stringify({ accessJwt: "a", refreshJwt: "r", handle: "alice.test", did: "nope", service: "s" })],
    ["numeric token", JSON.stringify({ accessJwt: 1, refreshJwt: "r", handle: "alice.test", did: "did:plc:x", service: "s" })],
  ])("rejects malformed stored data (%s)", (_name, text) => {
    expect(parseSessionData(text)).toBeNull();
  });
});

describe("createAppPasswordPersistence", () => {
  it("stores under session.appPassword only", async () => {
    const store = createMemorySecureStore();
    const persistence = createAppPasswordPersistence(store);
    await persistence.save(DATA);
    expect(await store.get("session.oauth")).toBeNull();
    const raw = await persistence.load();
    expect(raw).not.toBeNull();
    expect(parseSessionData(raw ?? "")?.refreshJwt).toBe("synthetic-refresh");
    await persistence.clear();
    expect(await persistence.load()).toBeNull();
  });
});
