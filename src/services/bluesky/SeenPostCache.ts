import { DEDUP } from "../../config/gardenConfig";

/** Bounded set of seen post URIs. Evicts the oldest entry first (docs/DESIGN.md §10). */
export class SeenPostCache {
  private readonly uris = new Set<string>();
  private readonly limit: number;

  constructor(limit: number = DEDUP.SEEN_POST_LIMIT) {
    this.limit = limit;
  }

  /** Returns true (and remembers the URI) when it has not been seen before. */
  markIfNew(uri: string): boolean {
    if (this.uris.has(uri)) return false;
    this.uris.add(uri);
    if (this.uris.size > this.limit) this.evictOldest();
    return true;
  }

  has(uri: string): boolean {
    return this.uris.has(uri);
  }

  clear(): void {
    this.uris.clear();
  }

  get size(): number {
    return this.uris.size;
  }

  private evictOldest(): void {
    const oldest = this.uris.values().next();
    if (oldest.done !== true) this.uris.delete(oldest.value);
  }
}
