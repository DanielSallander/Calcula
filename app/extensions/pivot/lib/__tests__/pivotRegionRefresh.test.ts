//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotRegionRefresh.test.ts
// PURPOSE: BUG-0594 -- the region refresh scheduler. It replaced a re-entry
//          flag that returned early while a refresh was in flight, which was
//          meant for the refresh's own "grid:refresh" echo but also DROPPED a
//          real request that arrived while an earlier refresh was still
//          reading the backend: that refresh then published regions read
//          before the change, and nothing read them again.
//
//          Pinned here: requests in one task merge into one refresh (options
//          merged); a STRONG request during a refresh runs exactly once more
//          after it; a WEAK one (the generic grid:refresh) does not; a request
//          made inside the refresh's own synchronous work (`asEcho`) is its
//          echo; a failing refresh does not wedge the scheduler; reset drops
//          queued work without leaving a caller waiting forever.
//
//          And the doors' announcement (revD#2): one change is ONE public
//          "pivot:refresh", a macrotask later; none when the caller dispatched
//          it itself; a chain of awaited doors (a loop) is one, when its last
//          door ends; a door that started before it does not hold it; a hung
//          chain is announced after maxHoldMs anyway -- inside hold() too
//          (rev3B#5), counted from the first announcement.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  announcePivotOutputChanged,
  createPivotOutputAnnouncer,
  createRegionRefreshScheduler,
  isPivotOutputAnnouncement,
  PIVOT_REFRESH_EVENT,
  type PivotOutputAnnouncementDetail,
  type RegionRefreshOptions,
} from "../pivotRegionRefresh";

/** A deferral the test drives by hand: `flushStarts()` runs what was deferred. */
let deferred: Array<() => void> = [];
const defer = (start: () => void) => {
  deferred.push(start);
};
function flushStarts(): void {
  const now = deferred;
  deferred = [];
  for (const start of now) start();
}

/** A refresh body whose runs the test releases one at a time. */
function controllableRun() {
  const runs: Array<{ options: RegionRefreshOptions; release: () => void; fail: (e: unknown) => void }> = [];
  const run = vi.fn(
    (options: RegionRefreshOptions) =>
      new Promise<void>((resolve, reject) => {
        runs.push({ options: { ...options }, release: resolve, fail: reject });
      }),
  );
  return { run, runs };
}

async function microtasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const REPAINT: RegionRefreshOptions = { triggerRepaint: true, allowCachedHit: false };
const QUIET: RegionRefreshOptions = { triggerRepaint: false, allowCachedHit: false };
const CACHED: RegionRefreshOptions = { triggerRepaint: false, allowCachedHit: true };

beforeEach(() => {
  deferred = [];
});

describe("merging", () => {
  it("requests made before the refresh starts are ONE refresh, with their options merged", async () => {
    const { run, runs } = controllableRun();
    const s = createRegionRefreshScheduler(run, defer);
    const a = s.request(CACHED);
    const b = s.request(REPAINT);
    const c = s.request(QUIET, "weak");
    expect(run).not.toHaveBeenCalled();
    flushStarts();
    expect(run).toHaveBeenCalledTimes(1);
    // Repaint when ANY asked; a cached view only when EVERY strong request allowed it.
    expect(runs[0].options).toEqual({ triggerRepaint: true, allowCachedHit: false });
    runs[0].release();
    await Promise.all([a, b, c]);
    expect(s.isBusy()).toBe(false);
  });

  it("a sheet switch: the weak grid:refresh does not veto SHEET_CHANGED's cached view (either order)", async () => {
    for (const order of [["weak", "strong"], ["strong", "weak"]] as const) {
      const { run, runs } = controllableRun();
      const s = createRegionRefreshScheduler(run, defer);
      for (const u of order) void s.request(u === "weak" ? QUIET : CACHED, u);
      flushStarts();
      expect(runs[0].options, `order ${order.join(" then ")}`).toEqual({ triggerRepaint: false, allowCachedHit: true });
      runs[0].release();
      await microtasks();
    }
  });

  it("weak requests alone keep their own say: no cached view unless every one allowed it", async () => {
    const { run, runs } = controllableRun();
    const s = createRegionRefreshScheduler(run, defer);
    void s.request(CACHED, "weak");
    void s.request(QUIET, "weak");
    flushStarts();
    expect(runs[0].options.allowCachedHit).toBe(false);
    runs[0].release();
    await microtasks();
  });
});

describe("a request while a refresh is in flight", () => {
  it("STRONG: runs once more after the refresh ends, and its caller waits for that run", async () => {
    const { run, runs } = controllableRun();
    const s = createRegionRefreshScheduler(run, defer);
    void s.request(QUIET);
    flushStarts();
    expect(run).toHaveBeenCalledTimes(1);

    let secondDone = false;
    void s.request(REPAINT).then(() => {
      secondDone = true;
    });
    // Not started on top of the running refresh: one at a time.
    flushStarts();
    expect(run).toHaveBeenCalledTimes(1);

    runs[0].release();
    await microtasks();
    expect(secondDone, "resolved before the refresh that covers it ran").toBe(false);
    flushStarts();
    expect(run, "the request made mid-refresh was dropped (the lost update)").toHaveBeenCalledTimes(2);
    expect(runs[1].options).toEqual(REPAINT);
    runs[1].release();
    await microtasks();
    expect(secondDone).toBe(true);
    expect(s.isBusy()).toBe(false);
  });

  it("several STRONG requests mid-refresh are ONE further refresh", async () => {
    const { run, runs } = controllableRun();
    const s = createRegionRefreshScheduler(run, defer);
    void s.request(QUIET);
    flushStarts();
    void s.request(QUIET);
    void s.request(REPAINT);
    void s.request(QUIET, "weak");
    runs[0].release();
    await microtasks();
    flushStarts();
    expect(run).toHaveBeenCalledTimes(2);
    expect(runs[1].options.triggerRepaint).toBe(true);
    runs[1].release();
    await microtasks();
    flushStarts();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("WEAK (the generic grid:refresh) is covered by the refresh in flight: no further refresh", async () => {
    const { run, runs } = controllableRun();
    const s = createRegionRefreshScheduler(run, defer);
    void s.request(REPAINT);
    flushStarts();
    let weakDone = false;
    void s.request(QUIET, "weak").then(() => {
      weakDone = true;
    });
    runs[0].release();
    await microtasks();
    expect(weakDone).toBe(true);
    flushStarts();
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.isBusy()).toBe(false);
  });

  it("a request inside the refresh's own synchronous work (asEcho) is its echo, even STRONG", async () => {
    let runs = 0;
    const s = createRegionRefreshScheduler(async () => {
      runs++;
      await Promise.resolve();
      // The refresh publishes and dispatches "grid:refresh"; a listener asks again.
      s.asEcho(() => {
        void s.request(REPAINT);
        void s.request(QUIET, "weak");
      });
    }, defer);
    void s.request(QUIET);
    flushStarts();
    await microtasks();
    flushStarts();
    await microtasks();
    flushStarts();
    expect(runs, "the refresh's own echo started another refresh (a loop)").toBe(1);
    expect(s.isBusy()).toBe(false);
  });
});

describe("robustness", () => {
  it("a failing refresh does not wedge the scheduler", async () => {
    const { run, runs } = controllableRun();
    const s = createRegionRefreshScheduler(run, defer);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = s.request(QUIET);
    flushStarts();
    runs[0].fail(new Error("backend gone"));
    await first;
    expect(err).toHaveBeenCalled();
    void s.request(REPAINT);
    flushStarts();
    expect(run).toHaveBeenCalledTimes(2);
    runs[1].release();
    await microtasks();
    expect(s.isBusy()).toBe(false);
    err.mockRestore();
  });

  it("reset drops a queued refresh and releases its caller", async () => {
    const { run } = controllableRun();
    const s = createRegionRefreshScheduler(run, defer);
    const pending = s.request(REPAINT);
    s.reset();
    flushStarts();
    expect(run).not.toHaveBeenCalled();
    await pending;
    expect(s.isBusy()).toBe(false);
  });

  it("the default deferral is one macrotask: a request then starts by itself", async () => {
    const run = vi.fn(async () => undefined);
    const s = createRegionRefreshScheduler(run);
    const done = s.request(REPAINT);
    expect(run).not.toHaveBeenCalled();
    await done;
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("announcePivotOutputChanged", () => {
  it("dispatches the event the Pivot extension re-reads its regions on, ONCE, a macrotask later", async () => {
    const seen: Event[] = [];
    const onSeen = (e: Event) => seen.push(e);
    window.addEventListener(PIVOT_REFRESH_EVENT, onSeen);
    announcePivotOutputChanged(7);
    announcePivotOutputChanged(7);
    expect(seen, "announced synchronously: a caller's own dispatch can no longer replace it").toHaveLength(0);
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
    window.removeEventListener(PIVOT_REFRESH_EVENT, onSeen);
    expect(PIVOT_REFRESH_EVENT).toBe("pivot:refresh");
    expect(seen).toHaveLength(1);
    expect((seen[0] as CustomEvent).detail).toEqual({ pivotId: "7", pivotIds: ["7"] });
    expect(isPivotOutputAnnouncement(seen[0])).toBe(true);
  });
});

// ============================================================================
// revD#2 -- one change, one announcement
// ============================================================================

/** A promise the test resolves (or rejects) by hand. */
function gate(): { promise: Promise<void>; open: () => void; fail: (e: unknown) => void } {
  let open!: () => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

describe("the doors' announcement is coalesced (revD#2)", () => {
  let target: EventTarget;
  let seen: CustomEvent<PivotOutputAnnouncementDetail>[];
  let laters: Array<{ run: () => void; ms: number }>;
  let clock: number;
  const later = (run: () => void, ms: number) => {
    laters.push({ run, ms });
  };

  beforeEach(() => {
    target = new EventTarget();
    seen = [];
    laters = [];
    clock = 0;
    target.addEventListener(PIVOT_REFRESH_EVENT, (e) => seen.push(e as CustomEvent<PivotOutputAnnouncementDetail>));
  });

  const announcer = () => createPivotOutputAnnouncer(target, defer, later, 1000, () => clock);

  it("one change: ONE event, a task later, naming the pivot", () => {
    const a = announcer();
    a.announce(7);
    expect(seen).toHaveLength(0);
    flushStarts();
    expect(seen).toHaveLength(1);
    expect(seen[0].detail).toEqual({ pivotId: "7", pivotIds: ["7"] });
    expect(a.isOwn(seen[0])).toBe(true);
    flushStarts();
    expect(seen).toHaveLength(1);
  });

  it("several changes before it goes out: ONE event listing them all, naming no single pivot", () => {
    const a = announcer();
    a.announce(7);
    a.announce(9);
    a.announce(7);
    flushStarts();
    expect(seen).toHaveLength(1);
    expect(seen[0].detail).toEqual({ pivotIds: ["7", "9"] });
  });

  it("an announcement without a pivot id names no pivot", () => {
    const a = announcer();
    a.announce(7);
    a.announce(undefined);
    flushStarts();
    expect(seen.map((e) => e.detail)).toEqual([{ pivotIds: ["7"] }]);
  });

  it("the caller dispatches pivot:refresh itself right after the door: no second event", () => {
    const a = announcer();
    a.announce(7);
    // The filter menu, the field settings, the context menu... do this.
    const callers = new Event(PIVOT_REFRESH_EVENT);
    target.dispatchEvent(callers);
    flushStarts();
    expect(seen, "the door's announcement went out on top of its caller's").toHaveLength(1);
    expect(a.isOwn(seen[0]), "the one event is the caller's").toBe(false);
    // A change AFTER the caller's dispatch is a new announcement.
    a.announce(8);
    flushStarts();
    expect(seen).toHaveLength(2);
    expect(seen[1].detail.pivotId).toBe("8");
  });

  it("a chain of doors (a loop of awaited doors) is announced ONCE, when its last door ends", async () => {
    const a = announcer();
    const gates = [gate(), gate(), gate()];
    const loop = (async () => {
      for (let i = 0; i < 3; i++) {
        await a.door(async () => {
          await gates[i].promise;
          a.announce(i + 1);
        });
      }
    })();
    gates[0].open();
    await microtasks();
    // Door 1 announced and the loop already started door 2: the flush waits.
    flushStarts();
    expect(seen, "announced in the middle of the loop").toHaveLength(0);
    gates[1].open();
    await microtasks();
    flushStarts();
    expect(seen, "announced in the middle of the loop").toHaveLength(0);
    gates[2].open();
    await loop;
    flushStarts();
    expect(seen).toHaveLength(1);
    expect(seen[0].detail).toEqual({ pivotIds: ["1", "2", "3"] });
  });

  it("a door that FAILS in the chain releases it", async () => {
    const a = announcer();
    await a.door(async () => {
      a.announce(1);
    });
    const g = gate();
    const second = a.door(async () => {
      await g.promise;
    });
    flushStarts();
    expect(seen).toHaveLength(0);
    g.fail(new Error("refused"));
    await expect(second).rejects.toThrow("refused");
    flushStarts();
    expect(seen.map((e) => e.detail.pivotIds)).toEqual([["1"]]);
  });

  it("a door that started BEFORE the announcement does not hold it (an unrelated slow door)", async () => {
    const a = announcer();
    const slow = gate();
    const running = a.door(async () => {
      await slow.promise;
    });
    a.announce(9);
    flushStarts();
    expect(seen.map((e) => e.detail.pivotId)).toEqual(["9"]);
    slow.open();
    await running;
  });

  it("a chain that runs too long is announced anyway after maxHoldMs (a hung door holds nothing forever)", async () => {
    const a = announcer();
    await a.door(async () => {
      a.announce(1);
    });
    const hung = gate();
    const second = a.door(async () => {
      await hung.promise;
      a.announce(2);
    });
    flushStarts();
    expect(seen).toHaveLength(0);
    expect(laters).toHaveLength(1);
    expect(laters[0].ms).toBe(1000);
    clock = 1000;
    laters[0].run();
    expect(seen.map((e) => e.detail.pivotIds)).toEqual([["1"]]);
    hung.open();
    await second;
    flushStarts();
    expect(seen.map((e) => e.detail.pivotIds)).toEqual([["1"], ["2"]]);
  });

  it("hold(): every announcement inside is ONE, even with no announcement pending when it starts", async () => {
    const a = announcer();
    const g = gate();
    const held = a.hold(async () => {
      a.announce(1);
      await g.promise;
      a.announce(2);
    });
    flushStarts();
    expect(seen).toHaveLength(0);
    g.open();
    await held;
    flushStarts();
    expect(seen.map((e) => e.detail.pivotIds)).toEqual([["1", "2"]]);
  });

  it("hold() with a HUNG door inside: what the earlier doors announced goes out after maxHoldMs anyway (rev3B#5)", async () => {
    // handleTableDefsUpdated / handleCellsMoved: hold() around a loop of
    // awaited doors. The first pivot's door announces; the second door hangs.
    // Inside hold() no flush is ever armed (the chain is never empty), so
    // only the cap can release pivot 1 -- without it pivot 1 keeps painting
    // its pre-change region (BUG-0594's ghost rows) until the slow door ends.
    const a = announcer();
    const hung = gate();
    const held = a.hold(async () => {
      await a.door(async () => {
        a.announce(1);
      });
      await a.door(async () => {
        await hung.promise;
        a.announce(2);
      });
    });
    await microtasks();
    flushStarts();
    expect(seen, "announced in the middle of the hold").toHaveLength(0);
    expect(laters, "no hold check was armed inside hold(): a hung door holds pivot 1's announcement forever").toHaveLength(1);
    expect(laters[0].ms).toBe(1000);
    clock = 1000;
    laters[0].run();
    expect(seen.map((e) => e.detail.pivotIds)).toEqual([["1"]]);
    hung.open();
    await held;
    flushStarts();
    expect(seen.map((e) => e.detail.pivotIds)).toEqual([["1"], ["2"]]);
  });

  it("hold(): the cap counts from the FIRST announcement, not from when the check is armed", async () => {
    const a = announcer();
    const hung = gate();
    const held = a.hold(async () => {
      clock = 300;
      a.announce(1);
      clock = 700;
      a.announce(2);
      await hung.promise;
    });
    expect(laters).toHaveLength(1);
    expect(laters[0].ms, "the check waits maxHoldMs from the first announcement").toBe(1000);
    // Fired early (a timer may): it re-arms for the rest of the hold instead of dispatching.
    clock = 900;
    laters[0].run();
    expect(seen).toHaveLength(0);
    expect(laters).toHaveLength(2);
    expect(laters[1].ms).toBe(400);
    clock = 1300;
    laters[1].run();
    expect(seen.map((e) => e.detail.pivotIds)).toEqual([["1", "2"]]);
    hung.open();
    await held;
    flushStarts();
    expect(seen, "nothing new to announce when the hold ends").toHaveLength(1);
  });

  it("reset drops a pending announcement", () => {
    const a = announcer();
    a.announce(1);
    a.reset();
    flushStarts();
    expect(seen).toHaveLength(0);
  });
});
