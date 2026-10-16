//! FILENAME: app/src/api/objectBindings/bridge.ts
// PURPOSE: The shell bridge of the binding seam: it keeps the seam's cache in
//          step with the Rust store, and it is THE trigger that tells Rust to
//          re-evaluate bindings after cells, names, sheets or page filters move.
// CONTEXT: D §3.7 / §9 D2. Rust owns evaluation and the dependency maps, but
//          the TRIGGER for "cells changed" lives here, because the frontend
//          already sees every mutation through announcements Core and the
//          Shell make anyway -- Core's coalesced CELLS_UPDATED (typed edits,
//          paste, fill, undo, sort, clear), the backend WINDOW event
//          "grid:refresh" (MCP / AI / script writes the backend made), the
//          MUTATION_REFRESH domains, named ranges, sheet add / delete / rename,
//          recalculation and structural undo. A Rust hook in every
//          cell-mutating command would be the copy-per-command shape the
//          decision forbids (computed properties prove the failure: one
//          caller, and paste / undo / sort never re-evaluated).
//
//          Every trigger of one animation frame is COALESCED into one flush:
//          at most one `SetPageFilters` and one `CellsChanged` per frame, and
//          requests reach the backend strictly in order (one queue), so an old
//          answer can never overwrite a newer one.
//
//          WHAT IS NOT A TRIGGER, deliberately: `AppEvents.GRID_REFRESH`. It is a
//          repaint REQUEST, not a mutation announcement, and families answer
//          `onBindingsChanged` by repainting. Listening to it would close a loop
//          (value changes -> repaint -> GRID_REFRESH -> re-evaluate -> a
//          volatile =NOW() binding changes again -> ...) once per frame forever.
//          Families repaint with `requestOverlayRedraw()`, never GRID_REFRESH.
//
//          Cost: a workbook with NO bindings sends no cell trigger at all. Page
//          filters are forwarded ALWAYS, bindings or not: the mirror is
//          runtime-only and cheap, and suppressing it would leave Rust at its
//          AFTER_OPEN state, so the FIRST `[Measure]` binding on an
//          already-filtered page would query unfiltered.
//
//          Seams point one way: this file imports nothing from app/extensions.

import { listenTauriEvent } from "../backend";
import {
  AppEvents,
  emitAppEvent,
  onAppEvent,
  type CellsUpdatedPayload,
  type MutationDomain,
} from "../events";
import { getPageFilters, listPageFilterPages, onPageFiltersChange } from "../pageFilters";
import { getGridStateSnapshot } from "../../core/state/GridContext";
import type {
  ChangedCellRef,
  ObjectBindingsChangedPayload,
  ObjectBindingsRequest,
  ObjectBindingsResponse,
  PageFilterPageWire,
} from "../types";
import {
  applyResolvedValues,
  bindingCount,
  cacheEpoch,
  notifyBindingsChanged,
  replaceAll,
  resetCache,
} from "./cache";
import { expectResponse, sendObjectBindingsRequest } from "./transport";

/**
 * The Tauri event Rust emits when binding values or the binding SET change.
 * Must stay in sync with `OBJECT_BINDINGS_CHANGED_EVENT` in
 * `app/src-tauri/src/object_bindings/mod.rs` (pinned by
 * `objectBindingsCatalogDrift.test.ts`).
 */
export const BACKEND_OBJECT_BINDINGS_EVENT = "object-bindings:changed";

/** The backend WINDOW event the shell re-dispatches after a backend-made cell write. */
const BACKEND_GRID_REFRESH_WINDOW_EVENT = "grid:refresh";

/**
 * Past this many distinct changed cells in one frame, the flush asks for a
 * FULL re-evaluation instead of listing them (a 10,000-cell paste is one
 * cheap pass, not a 10,000-entry request).
 */
export const MAX_CHANGED_CELLS_PER_FLUSH = 2000;

// --------------------------------------------------------------------------
// The ordered request queue
// --------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

/** Run `task` after every request queued before it, whatever they returned. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

function warnFailure(what: string, err: unknown): void {
  console.warn(`[objectBindings] ${what} failed:`, err);
}

async function send(request: ObjectBindingsRequest): Promise<ObjectBindingsResponse> {
  return sendObjectBindingsRequest(request);
}

// --------------------------------------------------------------------------
// Page filters
// --------------------------------------------------------------------------

/**
 * The FULL page-filter snapshot as Rust's mirror wants it: every (page,
 * connection) that holds a filter. Rust REPLACES its whole mirror with this.
 */
export function pageFiltersSnapshot(): PageFilterPageWire[] {
  return listPageFilterPages().map((page) => ({
    sheetIndex: page.sheetIndex,
    connectionId: page.connectionId,
    filters: getPageFilters(page.sheetIndex, page.connectionId).map((f) => ({
      field: f.field,
      includedItems: [...f.includedItems],
      filterLevel: f.filterLevel,
    })),
  }));
}

/** Send the current snapshot NOW (in queue order). */
export function sendPageFiltersNow(): Promise<void> {
  pendingPageFilters = false;
  return enqueue(async () => {
    expectResponse(await send({ op: "setPageFilters", pages: pageFiltersSnapshot() }), "ack");
  });
}

// --------------------------------------------------------------------------
// Coalesced frame flush
// --------------------------------------------------------------------------

let frameScheduled = false;
let pendingPageFilters = false;
let pendingFull = false;
let pendingCells: Map<string, ChangedCellRef> | null = null;

/** A `CellsChanged` that is queued but has not started: later frames merge into it. */
let queuedCellsTask: { full: boolean; cells: Map<string, ChangedCellRef> } | null = null;

function scheduleFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => cb());
  else setTimeout(cb, 16);
}

function requestFlush(): void {
  if (frameScheduled) return;
  frameScheduled = true;
  scheduleFrame(flush);
}

function activeSheetIndex(): number {
  const idx = getGridStateSnapshot()?.sheetContext?.activeSheetIndex;
  return typeof idx === "number" && idx >= 0 ? idx : 0;
}

/** A trigger that names cells. Ignored while the workbook has no binding. */
function noteCells(cells: readonly ChangedCellRef[]): void {
  if (bindingCount() === 0) return;
  if (!pendingFull) {
    pendingCells = pendingCells ?? new Map();
    for (const c of cells) pendingCells.set(`${c.sheetIndex}:${c.row}:${c.col}`, c);
    if (pendingCells.size > MAX_CHANGED_CELLS_PER_FLUSH) {
      pendingFull = true;
      pendingCells = null;
    }
  }
  requestFlush();
}

/** A trigger that names no cells: re-evaluate everything. Ignored with no binding. */
function noteFull(): void {
  if (bindingCount() === 0) return;
  pendingFull = true;
  pendingCells = null;
  requestFlush();
}

function flush(): void {
  frameScheduled = false;

  if (pendingPageFilters) void sendPageFiltersNow().catch((e) => warnFailure("Mirroring the page filters", e));

  const full = pendingFull;
  const cells = pendingCells;
  pendingFull = false;
  pendingCells = null;
  if (!full && !cells) return;
  if (bindingCount() === 0) return;

  if (queuedCellsTask) {
    // Not started yet: fold this frame into it.
    if (full || queuedCellsTask.full) {
      queuedCellsTask.full = true;
      queuedCellsTask.cells.clear();
    } else if (cells) {
      for (const [k, c] of cells) queuedCellsTask.cells.set(k, c);
      if (queuedCellsTask.cells.size > MAX_CHANGED_CELLS_PER_FLUSH) {
        queuedCellsTask.full = true;
        queuedCellsTask.cells.clear();
      }
    }
    return;
  }

  const task = { full, cells: cells ?? new Map<string, ChangedCellRef>() };
  queuedCellsTask = task;
  void enqueue(async () => {
    if (queuedCellsTask === task) queuedCellsTask = null;
    const epoch = cacheEpoch();
    const wire = task.full ? null : [...task.cells.values()];
    const answer = expectResponse(await send({ op: "cellsChanged", cells: wire }), "resolved");
    if (epoch !== cacheEpoch()) return;
    const changed = applyResolvedValues(answer.values);
    if (changed.length > 0) notifyBindingsChanged({ objects: changed, reload: false });
  }).catch((e) => warnFailure("Re-evaluating bindings", e));
}

// --------------------------------------------------------------------------
// Reload (the binding SET changed somewhere)
// --------------------------------------------------------------------------

let reloadQueued = false;

/** Re-read the binding set and every value (coalesced: one queued reload at a time). */
export function requestReload(): Promise<void> {
  if (reloadQueued) return chain.then(() => undefined);
  reloadQueued = true;
  return enqueue(async () => {
    reloadQueued = false;
    const epoch = cacheEpoch();
    const listed = expectResponse(await send({ op: "list", object: null }), "bindings");
    const values = expectResponse(await send({ op: "resolveAll" }), "resolved");
    if (epoch !== cacheEpoch()) return;
    const changed = replaceAll(listed.bindings, values.values);
    if (changed.length > 0) notifyBindingsChanged({ objects: changed, reload: true });
  }).catch((e) => warnFailure("Reloading the bindings", e));
}

/** Ask Rust to re-fetch every measure (a model changed or was refreshed). */
function requestMeasureRefresh(): Promise<void> {
  return enqueue(async () => {
    expectResponse(await send({ op: "refreshMeasures", sheetIndex: null }), "ack");
  }).catch((e) => warnFailure("Refreshing bound measures", e));
}

/** File > New / Open: forget the old workbook, then read the new one. */
function onDocumentReplaced(): void {
  const held = resetCache();
  queuedCellsTask = null;
  pendingFull = false;
  pendingCells = null;
  if (held.length > 0) notifyBindingsChanged({ objects: held, reload: true });
  void sendPageFiltersNow().catch((e) => warnFailure("Mirroring the page filters", e));
  void requestReload();
  void requestMeasureRefresh();
}

/** The Tauri event: changed values, and/or "the set changed -- re-list". */
function onBackendChanged(payload: ObjectBindingsChangedPayload | null | undefined): void {
  const values = Array.isArray(payload?.values) ? payload!.values : [];
  if (values.length > 0) {
    const changed = applyResolvedValues(values);
    if (changed.length > 0) notifyBindingsChanged({ objects: changed, reload: false });
  }
  if (payload?.reload) void requestReload();
}

// --------------------------------------------------------------------------
// Public triggers
// --------------------------------------------------------------------------

/**
 * What the NAMED_RANGES_CHANGED handler calls: a name moved, so every binding
 * that reads a name may read something else now (queues a full CellsChanged).
 * Exported because the object-dependency matrix names it
 * (`frontend:objectBindings.reevaluateAfterNameChange`).
 */
export function reevaluateAfterNameChange(): void {
  noteFull();
}

/** Emit the MutationDomain refresh a literal write's answer asks for. */
export function announceLiteralDomains(domains: readonly string[]): void {
  if (domains.length === 0) return;
  emitAppEvent(AppEvents.MUTATION_REFRESH, { domains: [...domains] as MutationDomain[], source: "commit" });
}

let uninstallCurrent: (() => void) | null = null;

/**
 * Install the bridge (once, from shell/bootstrap.ts). Listens to the Tauri
 * event, wires the triggers, reads the current workbook's bindings, and
 * returns its uninstall. A second install replaces the first.
 */
export function installObjectBindingsBridge(): () => void {
  if (uninstallCurrent) uninstallCurrent();

  const offs: Array<() => void> = [];
  let disposed = false;

  offs.push(
    onAppEvent<CellsUpdatedPayload | undefined>(AppEvents.CELLS_UPDATED, (detail) => {
      const changes = detail?.changes;
      if (!Array.isArray(changes) || changes.length === 0) {
        noteFull();
        return;
      }
      const active = activeSheetIndex();
      noteCells(
        changes.map((c) => ({
          sheetIndex: typeof c.sheetIndex === "number" ? c.sheetIndex : active,
          row: c.row,
          col: c.col,
        })),
      );
    }),
  );
  const onWindowGridRefresh = (): void => noteFull();
  window.addEventListener(BACKEND_GRID_REFRESH_WINDOW_EVENT, onWindowGridRefresh);
  offs.push(() => window.removeEventListener(BACKEND_GRID_REFRESH_WINDOW_EVENT, onWindowGridRefresh));

  for (const evt of [
    AppEvents.MUTATION_REFRESH,
    AppEvents.SHEET_ADDED,
    AppEvents.SHEET_DELETED,
    AppEvents.SHEET_RENAMED,
    AppEvents.RECALCULATION_COMPLETED,
    AppEvents.STRUCTURAL_UNDO,
  ]) {
    offs.push(onAppEvent(evt, () => noteFull()));
  }
  offs.push(onAppEvent(AppEvents.NAMED_RANGES_CHANGED, () => reevaluateAfterNameChange()));

  offs.push(
    onPageFiltersChange(() => {
      pendingPageFilters = true;
      requestFlush();
    }),
  );

  offs.push(onAppEvent(AppEvents.AFTER_OPEN, () => onDocumentReplaced()));
  offs.push(onAppEvent(AppEvents.AFTER_NEW, () => onDocumentReplaced()));
  offs.push(onAppEvent(AppEvents.BI_MODEL_CHANGED, () => void requestMeasureRefresh()));
  offs.push(onAppEvent(AppEvents.BI_REFRESH_COMPLETED, () => void requestMeasureRefresh()));

  let unlistenTauri: (() => void) | null = null;
  listenTauriEvent<ObjectBindingsChangedPayload>(BACKEND_OBJECT_BINDINGS_EVENT, onBackendChanged)
    .then((unlisten) => {
      if (disposed) unlisten();
      else unlistenTauri = unlisten;
    })
    .catch(() => {
      // No Tauri runtime (a test or a plain browser): nothing to bridge.
    });

  // The workbook already open when the shell starts (a file given on the
  // command line opens before any AFTER_OPEN listener exists).
  void sendPageFiltersNow().catch(() => undefined);
  void requestReload();

  const uninstall = (): void => {
    if (disposed) return;
    disposed = true;
    for (const off of offs) off();
    unlistenTauri?.();
    if (uninstallCurrent === uninstall) uninstallCurrent = null;
  };
  uninstallCurrent = uninstall;
  return uninstall;
}
