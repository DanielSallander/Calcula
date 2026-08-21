//! FILENAME: app/src/api/scriptHost/scriptPreview/runShape.ts
// PURPOSE: The timing rules a dry run has to obey, shared by both drivers.
// CONTEXT: docs/design/local-model-script-authoring.md §5c.
//
//          Small, but not incidental: `drainBrokerTraffic` encodes the
//          highest-severity finding of the eval harness's adversarial review,
//          and getting it wrong makes a CORRECT script report as broken.

/** Reject if `work` has not settled within `ms`, naming what was waited on. */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not settle within ${ms / 1000}s`)),
      ms,
    );
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * The payload the product's forwarder sends with each hook — mirrored from the
 * `button:clicked` emitter (`{ instanceId, x, y }` thinned to `{ x, y }`).
 */
export function hookPayload(event: string): unknown {
  return event === "onClick" || event === "onDoubleClick" ? { x: 0, y: 0 } : undefined;
}

/**
 * Wait until no broker call is in flight, across two consecutive macrotask
 * turns, before the grid is observed.
 *
 * `dispatchEvent` awaits only the thenables a handler RETURNS. A handler
 * written `() => { api.getCellValue(...).then(v => api.setCellValue(...)) }`
 * settles the dispatch while its tail write is still queued — and in the
 * product there is no early observation point at all (the host executes each
 * call as its message arrives), so that candidate performs the task correctly.
 * Snapshotting before quiescence graded the `.then` idiom as wrong-valued and
 * fed the repair loop a false diagnosis — the high-severity finding of the eval
 * harness's adversarial review.
 *
 * TWO QUIET TURNS, NOT ONE: pending can read 0 in the gap between a settle and
 * the continuation that issues the NEXT call.
 *
 * `pendingCount` is supplied by the driver because the two drivers observe
 * different sides of the same traffic — the offline one reads the worker
 * runtime's own pending map, the in-app one counts the calls the HOST has
 * accepted and not yet answered. Returns a reason string when it gave up, or
 * undefined when the realm went quiet.
 */
export async function drainBrokerTraffic(
  pendingCount: () => number,
  timeoutMs: number,
): Promise<string | undefined> {
  const startedAt = Date.now();
  let quiet = 0;
  while (quiet < 2) {
    if (Date.now() - startedAt > timeoutMs) {
      return `broker calls were still in flight ${timeoutMs / 1000}s after the handler returned`;
    }
    quiet = pendingCount() > 0 ? 0 : quiet + 1;
    await new Promise((r) => setTimeout(r, 0));
  }
  return undefined;
}
