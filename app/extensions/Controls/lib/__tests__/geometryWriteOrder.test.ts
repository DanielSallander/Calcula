//! FILENAME: app/extensions/Controls/lib/__tests__/geometryWriteOrder.test.ts
// PURPOSE: The rule that orders a control's geometry WRITES before the
//          renderers' property READS (BUG-0268), on its own: a read is current
//          only when nothing about the control's geometry changed while it was
//          on its way, and a new read can wait for every write in flight.
// CONTEXT: The end-to-end sequence (Core's resize events through the real
//          activate(), a read served before the write) is pinned in
//          __tests__/resizeKeepsRegion.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import {
  beginControlGeometryRead,
  controlGeometryWritesInFlight,
  noteControlGeometryChanged,
  resetControlGeometryWriteOrder,
  trackControlGeometryWrite,
} from "../geometryWriteOrder";

const A = { sheetIndex: 0, row: 2, col: 1 };
const B = { sheetIndex: 0, row: 5, col: 1 };

/** A write the test lands (or refuses) by hand. */
function heldWrite(): { promise: Promise<number>; land: () => void; refuse: () => void } {
  let land = () => {};
  let refuse = () => {};
  const promise = new Promise<number>((resolve, reject) => {
    land = () => resolve(1);
    refuse = () => reject(new Error("refused"));
  });
  return { promise, land, refuse };
}

const tick = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

beforeEach(() => resetControlGeometryWriteOrder());

describe("a size read is current only when nothing changed the control's geometry meanwhile", () => {
  it("nothing happened: current", () => {
    const current = beginControlGeometryRead(A);
    expect(current()).toBe(true);
  });

  it("a frontend size change while the read was on its way: NOT current", () => {
    const current = beginControlGeometryRead(A);
    noteControlGeometryChanged(A);
    expect(current()).toBe(false);
  });

  it("another control's change does not touch this read", () => {
    const current = beginControlGeometryRead(A);
    noteControlGeometryChanged(B);
    const write = heldWrite();
    trackControlGeometryWrite([B], write.promise);
    expect(current()).toBe(true);
  });

  it("a write STARTED while the read was on its way: NOT current, even after it lands", async () => {
    const current = beginControlGeometryRead(A);
    const write = heldWrite();
    trackControlGeometryWrite([A], write.promise);
    expect(current()).toBe(false);
    write.land();
    await tick();
    expect(current(), "a read that overlapped a write is stale for good").toBe(false);
  });

  it("a write in flight when the read STARTED: NOT current until the read starts after it", async () => {
    const write = heldWrite();
    trackControlGeometryWrite([A], write.promise);
    const early = beginControlGeometryRead(A);
    expect(early(), "delivered while the write is still in flight").toBe(false);
    write.land();
    await tick();
    expect(early(), "the write landed while the read was on its way").toBe(false);
    const late = beginControlGeometryRead(A);
    expect(late(), "a read started after the write landed").toBe(true);
  });

  it("a REFUSED write counts the same (the store is put back; the read is re-done)", async () => {
    const write = heldWrite();
    trackControlGeometryWrite([A], write.promise).catch(() => {});
    const current = beginControlGeometryRead(A);
    write.refuse();
    await tick();
    expect(current()).toBe(false);
    expect(controlGeometryWritesInFlight(A)).toBeNull();
  });
});

describe("a new read can wait for every geometry write in flight", () => {
  it("none in flight: null (the read starts at once)", () => {
    expect(controlGeometryWritesInFlight(A)).toBeNull();
  });

  it("two writes, landed out of order: the wait settles only after BOTH, and then nothing is in flight", async () => {
    const w1 = heldWrite();
    const w2 = heldWrite();
    trackControlGeometryWrite([A, B], w1.promise);
    trackControlGeometryWrite([A], w2.promise);
    let settled = false;
    void controlGeometryWritesInFlight(A)!.then(() => {
      settled = true;
    });
    w2.land();
    await tick();
    expect(settled, "settled before the first write landed").toBe(false);
    expect(controlGeometryWritesInFlight(A), "a write is still in flight").not.toBeNull();
    w1.land();
    await tick();
    expect(settled).toBe(true);
    expect(controlGeometryWritesInFlight(A)).toBeNull();
    expect(controlGeometryWritesInFlight(B)).toBeNull();
    expect(beginControlGeometryRead(A)(), "after both landed a new read is current").toBe(true);
  });

  it("the tracked promise is the write itself (its result and its refusal reach the caller)", async () => {
    await expect(trackControlGeometryWrite([A], Promise.resolve(3))).resolves.toBe(3);
    await expect(trackControlGeometryWrite([A], Promise.reject(new Error("no")))).rejects.toThrow("no");
  });
});
