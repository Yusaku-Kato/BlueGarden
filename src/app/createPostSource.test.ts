import { afterEach, describe, expect, it, vi } from "vitest";
import { JETSTREAM } from "../config/gardenConfig";
import { JetstreamSource } from "../services/bluesky/JetstreamSource";
import { SeenPostCache } from "../services/bluesky/SeenPostCache";
import { createPostSource } from "./createPostSource";

afterEach(() => {
  vi.useRealTimers();
});

function events() {
  return { onPosts: vi.fn(), onError: vi.fn(), onRecovered: vi.fn(), onFatal: vi.fn() };
}

describe("createPostSource", () => {
  it("builds a JetstreamSource for the global target without a session", () => {
    vi.useFakeTimers();
    const connect = vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }),
    }));
    const source = createPostSource({ seenPosts: new SeenPostCache() }, { kind: "global" }, events(), {
      jetstreamConnector: connect,
    });
    expect(source).toBeInstanceOf(JetstreamSource);
    source.start();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ host: JETSTREAM.HOSTS[0] }));
    source.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a target-fatal error when a guest asks for a feed that needs a session", () => {
    const sink = events();
    const source = createPostSource({ seenPosts: new SeenPostCache() }, { kind: "timeline" }, sink);
    source.start();
    source.start();
    expect(sink.onFatal).toHaveBeenCalledTimes(1);
    expect(sink.onFatal.mock.calls[0]?.[0]).toMatchObject({ kind: "notImplemented" });
  });
});
