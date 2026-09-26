//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frFetchLedger.test.ts
// PURPOSE: The landing rules of the lazy caches (cells, content extent):
//          - an answer OLDER than the one shown is dropped (out-of-order IPC);
//          - an answer begun BEFORE the last invalidation may be shown but
//            leaves the id stale, so the post-edit read still happens;
//          - a steady stream of invalidations cannot starve the cache: any
//            answer newer than the shown one is applied;
//          - a forgotten id (object deleted) or a reset (new document) drops
//            every answer already in flight.

import { describe, it, expect } from "vitest";
import { FrFetchLedger } from "../frFetchLedger";

describe("FrFetchLedger", () => {
  it("drops an answer older than the one already shown", () => {
    const l = new FrFetchLedger();
    const a = l.begin("x");
    const b = l.begin("x");
    expect(l.mayApply("x", b)).toBe(true);
    l.applied("x", b);
    expect(l.mayApply("x", a)).toBe(false);
  });

  it("shows a pre-invalidation answer but keeps the id STALE", () => {
    const l = new FrFetchLedger();
    const a = l.begin("x");
    l.invalidate("x"); // a cell was edited while `a` was in flight
    expect(l.isPending("x")).toBe(false); // the next paint may start the re-read
    expect(l.mayApply("x", a)).toBe(true);
    l.applied("x", a);
    expect(l.isStale("x")).toBe(true);

    const b = l.begin("x");
    l.applied("x", b);
    expect(l.isStale("x")).toBe(false);
  });

  it("cannot be starved by invalidations arriving faster than reads land", () => {
    const l = new FrFetchLedger();
    let shownAny = false;
    let inFlight = l.begin("x");
    for (let i = 0; i < 10; i++) {
      l.invalidate("x");
      const next = l.begin("x");
      if (l.mayApply("x", inFlight)) {
        l.applied("x", inFlight);
        shownAny = true;
      }
      l.end("x", inFlight);
      inFlight = next;
    }
    expect(shownAny).toBe(true);
  });

  it("only the latest read's end clears pending", () => {
    const l = new FrFetchLedger();
    const a = l.begin("x");
    l.invalidate("x");
    const b = l.begin("x");
    l.end("x", a);
    expect(l.isPending("x")).toBe(true);
    l.end("x", b);
    expect(l.isPending("x")).toBe(false);
  });

  it("forget drops an answer already in flight", () => {
    const l = new FrFetchLedger();
    const a = l.begin("x");
    l.forget("x");
    expect(l.mayApply("x", a)).toBe(false);
    const b = l.begin("x");
    expect(l.mayApply("x", b)).toBe(true);
  });

  it("reset drops every answer already in flight", () => {
    const l = new FrFetchLedger();
    const a = l.begin("x");
    const b = l.begin("y");
    l.reset();
    expect(l.mayApply("x", a)).toBe(false);
    expect(l.mayApply("y", b)).toBe(false);
    expect(l.mayApply("x", l.begin("x"))).toBe(true);
  });

  it("invalidateAll reaches ids with a read in flight but no answer yet", () => {
    const l = new FrFetchLedger();
    l.begin("fresh");
    l.invalidateAll();
    expect(l.isStale("fresh")).toBe(true);
    expect(l.isPending("fresh")).toBe(false);
  });
});
