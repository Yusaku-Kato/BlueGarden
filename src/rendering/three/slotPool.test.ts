import { describe, expect, it } from "vitest";
import { SlotPool } from "./slotPool";

describe("SlotPool", () => {
  it("hands out dense slots and refuses past capacity", () => {
    const pool = new SlotPool<string>(2);
    expect(pool.acquire("a")).toBe(0);
    expect(pool.acquire("b")).toBe(1);
    expect(pool.acquire("c")).toBe(-1);
    expect(pool.count).toBe(2);
  });

  it("releasing the last slot needs no move", () => {
    const pool = new SlotPool<string>(3);
    pool.acquire("a");
    pool.acquire("b");
    expect(pool.release(1)).toBeNull();
    expect(pool.count).toBe(1);
    expect(pool.ownerAt(1)).toBeUndefined();
  });

  it("swap-removes: the last owner moves into the freed slot", () => {
    const pool = new SlotPool<string>(4);
    for (const owner of ["a", "b", "c", "d"]) pool.acquire(owner);
    expect(pool.release(1)).toEqual({ from: 3, to: 1 });
    expect(pool.count).toBe(3);
    expect([0, 1, 2].map((slot) => pool.ownerAt(slot))).toEqual(["a", "d", "c"]);
  });

  it("frees capacity again and ignores invalid slots", () => {
    const pool = new SlotPool<number>(1);
    expect(pool.acquire(1)).toBe(0);
    expect(pool.acquire(2)).toBe(-1);
    expect(pool.release(5)).toBeNull();
    expect(pool.release(-1)).toBeNull();
    expect(pool.release(Number.NaN)).toBeNull();
    expect(pool.count).toBe(1);
    pool.release(0);
    expect(pool.acquire(3)).toBe(0);
  });

  it("clear empties the pool", () => {
    const pool = new SlotPool<number>(3);
    pool.acquire(1);
    pool.acquire(2);
    pool.clear();
    expect(pool.count).toBe(0);
    expect(pool.ownerAt(0)).toBeUndefined();
  });
});
