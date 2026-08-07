//! FILENAME: app/src/api/coalescedRefresh.ts
// PURPOSE: One shared answer to "an announcement asked me to re-read, and so did
//          the caller that caused it — do not do the work twice".
// CONTEXT: The backend-state refresh announcements (OUTLINE_CHANGED,
//          HYPERLINKS_CHANGED, VALIDATIONS_CHANGED, ANNOTATIONS_CHANGED) are
//          emitted by the IPC WRAPPER, so every route announces without
//          remembering to. That correctness has a cost the naive shape pays
//          twice over, and the timing is not obvious enough to re-derive in four
//          extensions:
//
//            await addComment(...)        // wrapper announces HERE
//            await refreshAnnotations()   // ...and the caller re-reads HERE
//
//          The announcement is emitted before the wrapper's promise resolves, so
//          the listener's refresh is not merely scheduled by the time the caller
//          continues — one microtask is enough for it to have STARTED. A plain
//          "is a refresh pending?" check therefore misses, and every mutation
//          costs two identical round-trips.
//
//          `request()` is what a listener calls; `join()` is what the caller
//          that performed the mutation calls. They differ in exactly one
//          respect: join() will attach to a pass that is already running, on the
//          grounds that a running pass exists BECAUSE something announced, and an
//          announcement is emitted after the backend committed — so that pass
//          observes the write. request() never attaches to a running pass,
//          because a later mutation's request must not be answered by a read
//          that started before it.
//
//          `invalidate()` closes the one hole in that reasoning: caches like
//          these describe the ACTIVE SHEET, so a pass that is in flight when the
//          sheet changes is answering about a sheet that is no longer on screen.
//          After invalidate(), a pass in flight abandons its writes instead of
//          applying them, which is both correct on its own and what makes
//          join()'s attach-to-running rule safe.

/** A refresh that coalesces redundant requests. See the file header. */
export interface CoalescedRefresh {
  /**
   * Ask for a re-read. Returns the pass that will answer.
   *
   * Requests that arrive before a pass starts share it. A request arriving
   * while a pass is RUNNING gets its own pass, chained after — it was caused by
   * a later change, so the running read may predate it.
   */
  request(): Promise<void>;
  /**
   * Await whichever pass is already answering for a change this caller just
   * made, requesting one only if nothing is. Use this — not request() — right
   * after performing a mutation whose IPC wrapper announces.
   */
  join(): Promise<void>;
  /**
   * Abandon the writes of any pass in flight (the sheet or document it is
   * reading is no longer the one on screen). Later passes are unaffected.
   */
  invalidate(): void;
  /** True while a pass is running. Exposed for tests and diagnostics. */
  isRunning(): boolean;
}

/**
 * Build a coalesced refresh around a read.
 *
 * @param read Performs the backend read and applies it. It MUST NOT reject —
 *   handle and log failures inside, as a rejected refresh would otherwise
 *   propagate into whatever UI happened to await it. It receives a
 *   `stillCurrent()` predicate: check it after every await and return without
 *   applying when it answers false.
 */
export function createCoalescedRefresh(
  read: (stillCurrent: () => boolean) => Promise<void>,
): CoalescedRefresh {
  let generation = 0;
  let pending: Promise<void> | null = null;
  let running: Promise<void> | null = null;
  let tail: Promise<void> = Promise.resolve();

  function request(): Promise<void> {
    if (pending) return pending;
    const started: Promise<void> = tail.then(() => {
      pending = null;
      running = started;
      const gen = generation;
      return read(() => gen === generation).finally(() => {
        if (running === started) running = null;
      });
    });
    pending = started;
    tail = started;
    return started;
  }

  return {
    request,
    join: () => pending ?? running ?? request(),
    invalidate: () => { generation++; },
    isRunning: () => running !== null,
  };
}
