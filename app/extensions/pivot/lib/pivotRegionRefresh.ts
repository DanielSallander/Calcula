//! FILENAME: app/extensions/Pivot/lib/pivotRegionRefresh.ts
// PURPOSE: The ONE way a pivot's grid region (and the cells it covers) is made
//          to follow the backend's output: a coalescing scheduler for the
//          region refresh, and the announcement every output-changing pivot
//          operation makes.
// CONTEXT: BUG-0594. A pivot that SHRANK under `pivot.applyFilter` (@api) went
//          on painting its old cells -- numbers that exist nowhere, under a
//          Grand Total that excludes them -- and `getGridRegions()` kept the
//          pre-filter extent. The backend was right; two things in the
//          frontend were not:
//
//          1. NOTHING ASKED. The region set (and the Core's cell cache, which
//             only re-reads on "grid:refresh") was re-derived only when the
//             CALLER of an operation remembered to dispatch "pivot:refresh"
//             afterwards -- dozens of call sites did; the @api facade route
//             (scripts, other extensions, the journey that found this) and
//             the pivot store service's refresh did not. Every output-changing door in pivot-api now announces
//             itself (`announcePivotOutputChanged`), so no caller has to.
//
//          2. A REQUEST DURING A REFRESH WAS DROPPED. The old re-entry guard
//             returned early while a refresh was in flight -- meant for the
//             refresh's OWN echo (it dispatches "grid:refresh", which asks
//             again), it also swallowed a real request that arrived while an
//             earlier refresh was still awaiting the backend, so that earlier
//             refresh published the regions it had read BEFORE the change and
//             nothing read them again: a lost update. The scheduler below runs
//             a strong request that arrives mid-refresh once the refresh ends.
//
//          Requests in the same task MERGE (the first run starts a macrotask
//          later), so a door's own announcement and its caller's explicit
//          "pivot:refresh" + "grid:refresh" right after still cost ONE refresh.
//
//          3. ONE CHANGE, ONE ANNOUNCEMENT (revD#2). "pivot:refresh" is a
//             PUBLIC event: Charts invalidates every pivot and design-query
//             chart on it, TimelineSlicer re-reads every timeline, Conditional
//             Formatting re-arms, a script's `pivot.onRefresh` runs. A door
//             that dispatched it at once doubled all of that whenever its
//             caller dispatched it too (the filter menu, the field settings,
//             the context menu...), and a loop of doors (BI Connections >
//             Refresh, the data aftermath) announced once per pivot. The
//             announcement is therefore COALESCED (`createPivotOutputAnnouncer`):
//             it goes out once, a macrotask later; not at all when the caller
//             dispatched "pivot:refresh" itself meanwhile (every listener has
//             heard); and not before the last door of a chain -- a door started
//             while an announcement was pending, the next turn of a loop --
//             has finished.

/** The window event the Pivot extension re-reads its regions on. */
export const PIVOT_REFRESH_EVENT = "pivot:refresh";

/** What the coalesced announcement carries on `event.detail`. */
export interface PivotOutputAnnouncementDetail {
  /**
   * Present when exactly ONE pivot changed. The script host's
   * `pivot.onRefresh` forwards an event that names a pivot to that pivot's
   * handlers only.
   */
  pivotId?: string;
  /** Every pivot the announced doors changed. */
  pivotIds: string[];
}

/** Longest a pending announcement waits for a chain of doors (a hung door must not hold it forever). */
export const PIVOT_ANNOUNCEMENT_MAX_HOLD_MS = 1000;

export interface PivotOutputAnnouncer {
  /**
   * A door accepted a change to `pivotId`'s output: announce it (coalesced).
   * Without an id the announcement names no pivot (every `pivot.onRefresh`
   * handler runs).
   */
  announce(pivotId?: string | number | null): void;
  /**
   * Run one output-changing door. A door started while an announcement is
   * pending is the next link of a chain (a loop's next turn): the pending
   * announcement waits for it, so the whole chain is announced once.
   */
  door<T>(body: () => Promise<T>): Promise<T>;
  /**
   * Hold every announcement made while `body` runs (an explicit loop of doors
   * inside this extension) and make ONE when it ends -- or after `maxHoldMs`.
   */
  hold<T>(body: () => Promise<T>): Promise<T>;
  /** True for the event this announcer dispatched (never a caller's own "pivot:refresh"). */
  isOwn(event: Event): boolean;
  /** True while an announcement is pending. */
  isPending(): boolean;
  /** Drop a pending announcement (deactivate). */
  reset(): void;
}

/**
 * The announcer over `target` (the window). `defer` starts the flush a
 * macrotask later, so every announcement of the current task -- and a caller's
 * own dispatch in the continuation of an awaited door -- is seen first;
 * `later` re-checks a chain that is still running after `maxHoldMs`.
 */
export function createPivotOutputAnnouncer(
  target: EventTarget,
  defer: (run: () => void) => void = (run) => {
    setTimeout(run, 0);
  },
  later: (run: () => void, ms: number) => void = (run, ms) => {
    setTimeout(run, ms);
  },
  maxHoldMs: number = PIVOT_ANNOUNCEMENT_MAX_HOLD_MS,
  now: () => number = () => Date.now(),
): PivotOutputAnnouncer {
  /** The pivots announced since the last announcement went out. */
  let pending: Set<string> | null = null;
  /** An announcement among them named no pivot. */
  let pendingUnnamed = false;
  let pendingSince = 0;
  let armed = false;
  let holdCheckArmed = false;
  /** Doors of the current chain still running. */
  let chained = 0;
  const own = new WeakSet<Event>();
  let listening = false;

  // A "pivot:refresh" dispatched by anyone else reached every listener: the
  // changes announced so far are covered, and announcing them again is the
  // duplicate this exists to remove.
  const onPublic = (event: Event): void => {
    if (own.has(event)) return;
    pending = null;
  };
  const listen = (): void => {
    if (listening) return;
    listening = true;
    target.addEventListener(PIVOT_REFRESH_EVENT, onPublic);
  };

  const dispatch = (): void => {
    if (pending === null) return;
    const ids = [...pending];
    const unnamed = pendingUnnamed;
    pending = null;
    pendingUnnamed = false;
    const detail: PivotOutputAnnouncementDetail =
      ids.length === 1 && !unnamed ? { pivotId: ids[0], pivotIds: ids } : { pivotIds: ids };
    const event = new CustomEvent<PivotOutputAnnouncementDetail>(PIVOT_REFRESH_EVENT, { detail });
    own.add(event);
    target.dispatchEvent(event);
  };

  /**
   * Re-check a pending announcement once it has waited `maxHoldMs` (counted
   * from its FIRST announcement) -- the cap on how long a running chain may
   * hold it. Armed by `flush` (a door chain) AND by `announce` inside a chain
   * (rev3B#5: inside `hold()` the chain is never empty, so no flush runs until
   * the body ends, and a hung door there held every earlier pivot's
   * announcement -- its ghost rows -- for as long as it hung).
   */
  const armHoldCheck = (): void => {
    if (holdCheckArmed || pending === null) return;
    holdCheckArmed = true;
    later(
      () => {
        holdCheckArmed = false;
        flush();
      },
      Math.max(0, maxHoldMs - (now() - pendingSince)),
    );
  };

  const flush = (): void => {
    if (pending === null) return;
    if (chained > 0) {
      // A chain is still running: its last door re-arms. Unless it has held
      // this announcement too long -- then out it goes, and the rest of the
      // chain is announced after it.
      if (now() - pendingSince >= maxHoldMs) {
        dispatch();
        return;
      }
      armHoldCheck();
      return;
    }
    dispatch();
  };

  const arm = (): void => {
    if (armed) return;
    armed = true;
    defer(() => {
      armed = false;
      flush();
    });
  };

  /** Run `body` as a link of the chain: what it and its peers announce goes out when the last one ends. */
  const holding = async <T>(body: () => Promise<T>): Promise<T> => {
    chained++;
    try {
      return await body();
    } finally {
      chained--;
      if (chained === 0 && pending !== null) arm();
    }
  };

  return {
    announce(pivotId) {
      listen();
      if (pending === null) {
        pending = new Set();
        pendingUnnamed = false;
        pendingSince = now();
      }
      if (pivotId === undefined || pivotId === null) pendingUnnamed = true;
      else pending.add(String(pivotId));
      // Outside a chain: out a task later. Inside one (a door chain or a
      // hold()): its last door arms the flush, and the cap is armed NOW, so a
      // hung door holds this for `maxHoldMs` at most.
      if (chained === 0) arm();
      else armHoldCheck();
    },
    door(body) {
      return pending !== null ? holding(body) : body();
    },
    hold(body) {
      return holding(body);
    },
    isOwn(event) {
      return own.has(event);
    },
    isPending() {
      return pending !== null;
    },
    reset() {
      pending = null;
    },
  };
}

/** The pivot-api doors' announcer (one per window). */
const announcer: PivotOutputAnnouncer | null =
  typeof window === "undefined" ? null : createPivotOutputAnnouncer(window);

/**
 * A pivot operation changed what `pivotId` shows (its cells, its extent, its
 * position): announce "pivot:refresh" so its region is re-read from the
 * backend and repainted (a shrunk pivot's vacated cells cleared, a grown one's
 * new cells shown) and every other listener follows. Called by every
 * output-changing door in pivot-api AFTER it accepted the result. COALESCED
 * (see 3. above): a caller that dispatches "pivot:refresh" itself right after
 * the door gets ONE event in all, not two.
 */
export function announcePivotOutputChanged(pivotId: string | number | null | undefined): void {
  announcer?.announce(pivotId);
}

/** Run an output-changing door as a link of a chain of doors (see `PivotOutputAnnouncer.door`). */
export function runPivotOutputDoor<T>(body: () => Promise<T>): Promise<T> {
  return announcer ? announcer.door(body) : body();
}

/** Hold the doors' announcements while `body` runs, then make one (see `PivotOutputAnnouncer.hold`). */
export function holdPivotOutputAnnouncements<T>(body: () => Promise<T>): Promise<T> {
  return announcer ? announcer.hold(body) : body();
}

/** `fn` as an output-changing door (`runPivotOutputDoor`), same signature. */
export function asPivotOutputDoor<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args: A) => runPivotOutputDoor(() => fn(...args));
}

/** True for the announcement the doors made (never a caller's or another extension's own dispatch). */
export function isPivotOutputAnnouncement(event: Event): boolean {
  return announcer?.isOwn(event) ?? false;
}

/** Drop a pending door announcement (the extension deactivates). */
export function resetPivotOutputAnnouncements(): void {
  announcer?.reset();
}

/** What one region refresh does. */
export interface RegionRefreshOptions {
  /** Re-read the Core's cells, styles and dimensions after publishing. */
  triggerRepaint: boolean;
  /** A cached view may stand in for a fetch (sheet switch back). */
  allowCachedHit: boolean;
}

/**
 * How a request relates to a refresh already under way.
 *   - "strong": something CHANGED in the backend (an operation's output, an
 *     undo, a sheet switch, a package update). Arriving while a refresh is
 *     in flight, it runs again once that refresh ends -- the refresh in flight
 *     may have read the regions before the change.
 *   - "weak": the generic "grid:refresh" echo. Arriving while a refresh is in
 *     flight it is dropped, as before: the refresh it would repeat is the one
 *     that dispatched it, or one already reading the current state.
 */
export type RegionRefreshUrgency = "strong" | "weak";

export interface RegionRefreshScheduler {
  /** Ask for a refresh; resolves once a refresh that covers this request has run. */
  request(options: RegionRefreshOptions, urgency?: RegionRefreshUrgency): Promise<void>;
  /**
   * Run `fn` synchronously as the running refresh's OWN work: a request made
   * inside it (the "grid:refresh" it dispatches, a region listener) is its
   * echo and is ignored, exactly as the old re-entry guard ignored it.
   */
  asEcho<T>(fn: () => T): T;
  /** True while a refresh is queued or running. */
  isBusy(): boolean;
  /** Drop queued work (deactivate); a refresh already running finishes alone. */
  reset(): void;
}

interface QueuedRefresh {
  options: RegionRefreshOptions;
  /** Whether a STRONG request is among those merged (see `mergeInto`). */
  strong: boolean;
  promise: Promise<void>;
  resolve: () => void;
}

function queuedRefresh(options: RegionRefreshOptions, urgency: RegionRefreshUrgency): QueuedRefresh {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { options: { ...options }, strong: urgency === "strong", promise, resolve };
}

/**
 * Requests as one: repaint if ANY wants it; reuse a cached view only if every
 * STRONG request allows it. A weak "grid:refresh" has no say on the cached
 * view once a strong request is present: on a sheet switch it arrives in the
 * same task as SHEET_CHANGED's cached-hit request, and must not turn the
 * instant return to a sheet into a round-trip per pivot (the old guard let
 * whichever came first win). The regions themselves are ALWAYS re-read.
 */
function mergeInto(into: QueuedRefresh, add: RegionRefreshOptions, urgency: RegionRefreshUrgency): void {
  into.options.triggerRepaint = into.options.triggerRepaint || add.triggerRepaint;
  if (urgency === "strong") {
    into.options.allowCachedHit = into.strong ? into.options.allowCachedHit && add.allowCachedHit : add.allowCachedHit;
    into.strong = true;
  } else if (!into.strong) {
    into.options.allowCachedHit = into.options.allowCachedHit && add.allowCachedHit;
  }
}

/**
 * The scheduler over one refresh body. `defer` starts a queued run; the default
 * is a macrotask, so every request made in the current task (and its
 * microtasks -- an awaiting caller's continuation) merges into that run.
 */
export function createRegionRefreshScheduler(
  run: (options: RegionRefreshOptions) => Promise<void>,
  defer: (start: () => void) => void = (start) => {
    setTimeout(start, 0);
  },
): RegionRefreshScheduler {
  let queued: QueuedRefresh | null = null;
  let running: Promise<void> | null = null;
  let echoDepth = 0;
  /** Bumped by reset(): a start deferred before it does nothing. */
  let epoch = 0;

  const start = (startEpoch: number): void => {
    if (startEpoch !== epoch || running !== null || queued === null) return;
    const job = queued;
    queued = null;
    const current = (async () => {
      try {
        await run(job.options);
      } catch (err) {
        console.error("[Pivot Extension] region refresh failed:", err);
      }
    })();
    running = current;
    void current.then(() => {
      if (running === current) running = null;
      job.resolve();
      // A strong request arrived while this one ran: read the regions again.
      if (queued !== null) {
        const nextEpoch = epoch;
        defer(() => start(nextEpoch));
      }
    });
  };

  return {
    request(options, urgency = "strong") {
      if (echoDepth > 0) return running ?? queued?.promise ?? Promise.resolve();
      if (queued !== null) {
        mergeInto(queued, options, urgency);
        return queued.promise;
      }
      if (running !== null) {
        if (urgency === "weak") return running;
        queued = queuedRefresh(options, urgency);
        // Started by the running refresh when it ends.
        return queued.promise;
      }
      const job = queuedRefresh(options, urgency);
      queued = job;
      const startEpoch = epoch;
      defer(() => start(startEpoch));
      return job.promise;
    },
    asEcho(fn) {
      echoDepth++;
      try {
        return fn();
      } finally {
        echoDepth--;
      }
    },
    isBusy() {
      return queued !== null || running !== null;
    },
    reset() {
      epoch++;
      const dropped = queued;
      queued = null;
      dropped?.resolve();
    },
  };
}
