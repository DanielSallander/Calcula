//! FILENAME: app/extensions/Collaboration/lib/collectStreamsStore.ts
// PURPOSE: The ONE client-side copy of the workbook's Writeback > Collect From
//          view, shared by the Writeback tab's hero and the Collected Responses
//          pane, so a tick in either place shows in both at once.
// CONTEXT: The choice lives in Rust (`calp_collection_streams`); this store only
//          caches the last view it returned. Reads are asynchronous on the Rust
//          side (the pipeline and the publisher gate read the workspace), so an
//          unreachable share never freezes the window. Writes are serialized
//          through one promise chain: three quick ticks are three requests in
//          order, never two racing to be last.
//
//          Refreshed on activation, on document open/new, when this workbook's
//          own regions change, when the application's environments change (a
//          publish or push -- a FIRST publish creates the link -- an edited
//          pipeline, a promotion: the default is the last environment) and
//          whenever the menu opens -- never on every cursor move
//          (`COLLECT_STREAMS_REFRESH_EVENTS`, `wireCollectStreamsRefresh`).

import {
  getCollectionStreams,
  setCollectionStreams,
  type CollectionStreamsView,
  type CollectStreamsChoice,
} from "@api/collaboration";
import { emitAppEvent, AppEvents } from "@api/events";
import { showToast } from "@api/notifications";
import { ENVIRONMENTS_CHANGED_EVENT } from "@api/collaboration";
import { WRITEBACK_COLLECTION_STREAMS_CHANGED_EVENT, WRITEBACK_REGIONS_CHANGED_EVENT } from "./writebackIds";
import { nextChoice } from "./collectStreamsModel";

/**
 * EVERY EVENT AFTER WHICH THE VIEW CAN HAVE CHANGED. A first publish creates
 * the working-copy link (the control was disabled "Publish first" until it is
 * re-read), and a pipeline edit or promotion moves the default (the last
 * environment) -- both announce ENVIRONMENTS_CHANGED_EVENT only.
 */
export const COLLECT_STREAMS_REFRESH_EVENTS: readonly string[] = [
  AppEvents.AFTER_OPEN,
  AppEvents.AFTER_NEW,
  WRITEBACK_REGIONS_CHANGED_EVENT,
  ENVIRONMENTS_CHANGED_EVENT,
];

/** Re-read the view on every event in COLLECT_STREAMS_REFRESH_EVENTS; returns
 *  the unsubscribers. `on` is the extension context's `events.on`. */
export function wireCollectStreamsRefresh(
  on: (eventName: string, cb: () => void) => () => void,
): Array<() => void> {
  return COLLECT_STREAMS_REFRESH_EVENTS.map((eventName) => on(eventName, () => void refreshCollectStreams()));
}

let view: CollectionStreamsView | null = null;
let lastError: string | null = null;
let version = 0;
/** Bumped by every read and write, so a slow read never overwrites a newer
 *  result. */
let generation = 0;
let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function notify(): void {
  version++;
  for (const cb of Array.from(listeners)) {
    try {
      cb();
    } catch (err) {
      console.error("[CollectFrom] a listener threw:", err);
    }
  }
}

/** Subscribe to view changes (useSyncExternalStore-shaped). */
export function subscribeCollectStreams(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getCollectStreamsVersion(): number {
  return version;
}

/** The last view Rust returned, or null before the first read. */
export function getCollectStreamsView(): CollectionStreamsView | null {
  return view;
}

/** Why the last read or write failed, or null. */
export function getCollectStreamsError(): string | null {
  return lastError;
}

/** Re-read the view. Never throws; a failure is kept as the error. */
export async function refreshCollectStreams(): Promise<void> {
  const mine = ++generation;
  try {
    const next = await getCollectionStreams();
    if (mine !== generation) return;
    view = next;
    lastError = null;
  } catch (err) {
    if (mine !== generation) return;
    lastError = err instanceof Error ? err.message : String(err);
  }
  notify();
}

/**
 * Change the choice ("all", `{ only: [...] }`, or null for the default). Runs
 * after every write already asked for. On success the view is the one Rust
 * returned and WRITEBACK_COLLECTION_STREAMS_CHANGED_EVENT is announced; on a
 * refusal the Rust sentence is shown and the view re-read. Resolves to whether
 * it was applied.
 */
export function applyCollectChoice(choice: CollectStreamsChoice | null): Promise<boolean> {
  const run = writes.then(() => applyChoiceNow(choice));
  writes = run.catch(() => undefined);
  return run;
}

/** One write, run in the chain (callers chain it). */
async function applyChoiceNow(choice: CollectStreamsChoice | null): Promise<boolean> {
  const mine = ++generation;
  try {
    const next = await setCollectionStreams(choice);
    if (mine === generation) {
      view = next;
      lastError = null;
      notify();
    }
    emitAppEvent(WRITEBACK_COLLECTION_STREAMS_CHANGED_EVENT, { summary: next.summary });
    return true;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    showToast(lastError, { variant: "error" });
    await refreshCollectStreams();
    return false;
  }
}

/**
 * Tick or untick ONE stream in the menu. The next choice is computed INSIDE the
 * write chain, from the view as it stands when this request runs -- never from
 * the view the menu rendered: the menu stays open, and a second tick made while
 * the first is still on its way to Rust would otherwise be computed from the
 * old view and overwrite the first (untick test, quickly tick dev: test came
 * back). Resolves to whether a change was applied; leaving nothing collected
 * is refused without asking Rust.
 */
export function toggleCollectStream(stream: string): Promise<boolean> {
  const run = writes.then(async () => {
    if (!view) return false;
    const next = nextChoice(view, stream);
    if (next === "refuse") return false;
    return applyChoiceNow(next);
  });
  writes = run.catch(() => undefined);
  return run;
}

/** Forget everything (deactivation, tests). */
export function resetCollectStreams(): void {
  view = null;
  lastError = null;
  generation++;
  writes = Promise.resolve();
  notify();
}
