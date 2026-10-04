import type { LiveTransport } from "@bsky/jetstream";
import { describe, expect, it } from "vitest";
import { createJetstreamConnector } from "./JetstreamSource";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";

function frame(timeUs: number): string {
  return JSON.stringify({
    did: DID,
    time_us: timeUs,
    kind: "commit",
    commit: {
      rev: "3kabcdefghij2",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3kabcdefghij2",
      record: { text: "synthetic", createdAt: "2026-01-02T03:04:05.000Z" },
      cid: "bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    },
  });
}

describe("createJetstreamConnector (real @bsky/jetstream decode, fake transport)", () => {
  it("builds a v1 subscribe URL with the collection filter and cursor, and yields raw events", async () => {
    const urls: string[] = [];
    const transport: LiveTransport = {
      stream(getUrl) {
        urls.push(getUrl());
        return (async function* () {
          await Promise.resolve();
          yield "not json";
          yield frame(1_700_000_000_500_000);
          yield frame(1_700_000_000_000_000); // at or below the cursor: dropped by the library
        })();
      },
    };
    const connect = createJetstreamConnector(transport);
    const received: unknown[] = [];
    const skipped: unknown[] = [];
    const controller = new AbortController();
    for await (const event of connect({
      host: "jetstream1.example.test",
      cursorUs: 1_700_000_000_000_000,
      signal: controller.signal,
      onError: (error) => skipped.push(error),
    })) {
      received.push(event);
    }
    const url = new URL(urls[0] ?? "");
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/subscribe");
    expect(url.searchParams.get("wantedCollections")).toBe("app.bsky.feed.post");
    expect(url.searchParams.get("cursor")).toBe("1700000000000000");
    expect(received).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: "commit", timeUs: 1_700_000_000_500_000 });
  });
});
