/**
 * Dense slot allocator for one InstancedMesh. Slots 0..count-1 are always in use, so the mesh can
 * draw `count` instances. Removing a slot moves the last occupied slot into the hole (O(1) swap-remove);
 * the caller copies the instance data and updates the moved owner. Pure, unit-testable.
 */
export interface SlotMove {
  /** The previously last slot, now free. */
  readonly from: number;
  /** The slot that received the moved owner. */
  readonly to: number;
}

export class SlotPool<Owner> {
  private owners: Owner[] = [];

  constructor(readonly capacity: number) {}

  get count(): number {
    return this.owners.length;
  }

  /** Returns the new slot, or -1 when full. */
  acquire(owner: Owner): number {
    if (this.owners.length >= this.capacity) return -1;
    this.owners.push(owner);
    return this.owners.length - 1;
  }

  ownerAt(slot: number): Owner | undefined {
    return this.owners[slot];
  }

  /**
   * Frees `slot`. Returns the move the caller must mirror in its instance buffers, or null when the
   * last slot itself was freed (or the slot was not in use).
   */
  release(slot: number): SlotMove | null {
    const last = this.owners.length - 1;
    if (!Number.isInteger(slot) || slot < 0 || slot > last) return null;
    if (slot === last) {
      this.owners.pop();
      return null;
    }
    const moved = this.owners[last];
    if (moved === undefined) return null;
    this.owners[slot] = moved;
    this.owners.pop();
    return { from: last, to: slot };
  }

  clear(): void {
    this.owners = [];
  }
}
