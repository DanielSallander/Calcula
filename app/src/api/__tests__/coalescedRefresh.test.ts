//! FILENAME: app/src/api/__tests__/coalescedRefresh.test.ts
// PURPOSE: Pin the three behaviours the refresh-announcement work depends on —
//          request() coalescing, join()'s attach-to-running rule, and
//          invalidate() abandoning a pass whose sheet changed under it.
// CONTEXT: The announcement is emitted by the IPC wrapper BEFORE its promise
//          resolves, so by the time the caller that performed the mutation gets
//          to re-read, the listener's pass has usually already started. That one
//          microtask is the whole reason request() and join() are different
//          functions, and it is not a thing anyone will re-derive correctly in
//          four extensions.

import { describe, it, expect } from "vitest";
import { createCoalescedRefresh } from "../coalescedRefresh";

/** A read whose completion the test controls. */
function controllableRead() {
  const releases: Array<() => void> = [];
  let starts = 0;
  const applied: number[] = [];
  const read = (stillCurrent: () => boolean) => {
    const n = ++starts;
    return new Promise<void>((resolve) => {
      releases.push(() => {
        if (stillCurrent()) applied.push(n);
        resolve();
      });
    });
  };
  return {
    read,
    releaseAll: () => { while (releases.length) releases.shift()!(); },
    releaseNext: () => releases.shift()!(),
    get starts() { return starts; },
    applied,
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("request()", () => {
  it("folds requests made before the pass starts into one", async () => {
    let starts = 0;
    const refresh = createCoalescedRefresh(async () => { starts++; });
    const a = refresh.request();
    const b = refresh.request();
    expect(b).toBe(a);
    await a;
    expect(starts).toBe(1);
  });

  // A request made while a pass is running was caused by a LATER change, and
  // the running read may have started before that change was committed.
  it("gives a request made mid-pass its own pass, chained after", async () => {
    const r = controllableRead();
    const refresh = createCoalescedRefresh(r.read);

    const first = refresh.request();
    await tick();
    expect(r.starts).toBe(1);

    const second = refresh.request();
    expect(second).not.toBe(first);
    expect(r.starts).toBe(1);            // chained, not concurrent

    r.releaseNext();
    await first;
    await tick();
    expect(r.starts).toBe(2);
    r.releaseNext();
    await second;
  });
});

describe("join()", () => {
  it("attaches to a pass that has already started", async () => {
    const r = controllableRead();
    const refresh = createCoalescedRefresh(r.read);

    const announced = refresh.request();
    await tick();                         // the listener's pass is now running
    expect(refresh.isRunning()).toBe(true);

    const joined = refresh.join();        // the mutating caller catches up
    expect(joined).toBe(announced);

    r.releaseAll();
    await joined;
    expect(r.starts).toBe(1);
  });

  it("attaches to a pass that is scheduled but not started", async () => {
    let starts = 0;
    const refresh = createCoalescedRefresh(async () => { starts++; });
    const announced = refresh.request();
    expect(refresh.isRunning()).toBe(false);
    expect(refresh.join()).toBe(announced);
    await announced;
    expect(starts).toBe(1);
  });

  it("requests a pass when nothing is answering", async () => {
    let starts = 0;
    const refresh = createCoalescedRefresh(async () => { starts++; });
    await refresh.join();
    expect(starts).toBe(1);
  });
});

describe("invalidate()", () => {
  it("makes a pass in flight abandon its writes", async () => {
    const r = controllableRead();
    const refresh = createCoalescedRefresh(r.read);

    const doomed = refresh.request();
    await tick();
    refresh.invalidate();                 // e.g. the active sheet changed
    r.releaseNext();
    await doomed;
    expect(r.applied).toEqual([]);        // read ran, result was not applied
  });

  it("leaves passes started after it alone", async () => {
    const r = controllableRead();
    const refresh = createCoalescedRefresh(r.read);

    refresh.invalidate();
    const fresh = refresh.request();
    await tick();
    r.releaseNext();
    await fresh;
    expect(r.applied).toEqual([1]);
  });
});
