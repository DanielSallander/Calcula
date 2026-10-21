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
//          PAGE FILTERS (P4 S11). The mirror is keyed by SHEET ID end to end:
//          each touched (page, connection) carries the page's BASE set
//          (`resolvePageBase`) plus per-object OVERRIDES for the model
//          visuals that resolve differently (`resolveFiltersFor`: a
//          visual-scoped ribbon filter, another visual's filter-mode
//          selection, a `none` interaction). Highlights never reach a binding.
//          See `pageFiltersSnapshot`.
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
import {
  getCrossFilters,
  getReportFilters,
  onReportFiltersChange,
  resolveFiltersFor,
  resolvePageBase,
  startReportFilters,
  type ResolvedFieldFilter,
  type ResolvedTupleFilter,
} from "../reportFilters";
import { getReportPagesSnapshot, onReportPagesChanged } from "../reportPages";
import { listModelVisuals, modelVisualOf } from "../modelVisuals";
import { getGridStateSnapshot } from "../../core/state/GridContext";
import type {
  ChangedCellRef,
  ObjectBindingsChangedPayload,
  ObjectBindingsRequest,
  ObjectBindingsResponse,
  ObjectFilterOverrideWire,
  PageFilterPageWire,
  PageFilterWire,
  TupleFilterWire,
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

/** One resolved per-column filter as the mirror carries it (items = member KEYS). */
function fieldWire(f: ResolvedFieldFilter): PageFilterWire {
  return { field: f.field, includedItems: [...f.includedKeys], filterLevel: f.level };
}

/** One resolved OR-of-AND filter as the mirror carries it. */
function tupleWire(t: ResolvedTupleFilter): TupleFilterWire {
  return { fields: [...t.fields], tuples: t.tuples.map((row) => [...row]) };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every (page, connection) any resolver input touches, keyed `sheetId|conn`:
 *   - a page / pages-scoped filter: its pages;
 *   - an all-pages filter: every sheet of the live page list;
 *   - a visuals-scoped filter: the page of each target visual (by
 *     @api/modelVisuals; a target no provider lists has no page to reach);
 *   - a cross-filter selection: its page.
 * Interaction pairs touch nothing of their own: a pair changes what a target
 * reads only while its source publishes or selects, and that source already
 * touched the page.
 */
function touchedPages(): Map<string, { sheetId: string; connectionId: string }> {
  const pages = new Map<string, { sheetId: string; connectionId: string }>();
  const touch = (sheetId: string | null | undefined, connectionId: string): void => {
    if (!sheetId) return;
    pages.set(`${sheetId}|${connectionId}`, { sheetId, connectionId });
  };
  const everySheet = [...getReportPagesSnapshot().sheetIdByIndex.values()];
  for (const f of getReportFilters()) {
    switch (f.scope.kind) {
      case "page":
        touch(f.scope.sheetId, f.connectionId);
        break;
      case "pages":
        for (const id of f.scope.sheetIds) touch(id, f.connectionId);
        break;
      case "all":
        for (const id of everySheet) touch(id, f.connectionId);
        break;
      case "visuals":
        for (const target of f.scope.targets) touch(modelVisualOf(target)?.sheetId, f.connectionId);
        break;
    }
  }
  for (const sel of getCrossFilters()) touch(sel.pageSheetId, sel.connectionId);
  return pages;
}

/**
 * The FULL page-filter snapshot Rust's binding mirror replaces itself with
 * (`SetPageFilters`). Pages are SHEET IDS (an index shifts on every move).
 *
 * For every (page, connection) any resolver input touches (`touchedPages`):
 *   - `filters` / `tupleFilters`: the page's BASE (`resolvePageBase`, the ONE
 *     base path: page / pages / all-scoped filters; no visual-scoped filter,
 *     no selection, no interaction). What every bound object of the page
 *     reads unless it has an override -- a shape, a control, the page itself.
 *     The base never carries a tuple filter today (only selections make one);
 *     the field is on the wire so an override and a base read alike.
 *   - `objects`: one override per model visual of the page, on that
 *     connection, that FOLLOWS others (`role.target`), whose own resolved
 *     `filters + tupleFilters` (`resolveFiltersFor`) differ from the base: a
 *     visual-scoped ribbon filter that names it, another visual's filter-mode
 *     selection, a slicer filter its `none` pair drops. HIGHLIGHTS NEVER
 *     REACH BINDINGS: the visual is asked with its own `canHighlight`, so a
 *     highlight-mode selection lands in `highlights` and is not sent -- a
 *     bound measure shows the filtered value only under a filter-mode
 *     interaction (and a visual that cannot paint a highlight is filtered,
 *     which is exactly what it shows).
 *
 * Order is deterministic (page-list position, then sheet id, then connection;
 * objects by kind then id), so an unchanged state is an unchanged wire and the
 * dedupe below re-sends nothing.
 */
export function pageFiltersSnapshot(): PageFilterPageWire[] {
  const position = new Map<string, number>();
  for (const [index, id] of getReportPagesSnapshot().sheetIdByIndex) position.set(id, index);
  const at = (id: string): number => position.get(id) ?? Number.MAX_SAFE_INTEGER;

  return [...touchedPages().values()]
    .sort((a, b) => at(a.sheetId) - at(b.sheetId) || cmp(a.sheetId, b.sheetId) || cmp(a.connectionId, b.connectionId))
    .map(({ sheetId, connectionId }) => {
      const base = resolvePageBase(sheetId, connectionId);
      const filters = base.filters.map(fieldWire);
      const tupleFilters = base.tupleFilters.map(tupleWire);
      const baseKey = JSON.stringify([filters, tupleFilters]);

      const objects: ObjectFilterOverrideWire[] = [];
      const visuals = listModelVisuals({ sheetId, connectionId })
        .filter((v) => v.role.target)
        .sort((a, b) => cmp(a.ref.kind, b.ref.kind) || cmp(a.ref.id, b.ref.id));
      const seen = new Set<string>();
      for (const v of visuals) {
        const key = `${v.ref.kind}:${v.ref.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const own = resolveFiltersFor(sheetId, { ref: v.ref, canHighlight: v.role.canHighlight }, connectionId);
        const ownFilters = own.filters.map(fieldWire);
        const ownTuples = own.tupleFilters.map(tupleWire);
        if (JSON.stringify([ownFilters, ownTuples]) === baseKey) continue;
        objects.push({ object: { kind: v.ref.kind, id: v.ref.id }, filters: ownFilters, tupleFilters: ownTuples });
      }
      return { sheetId, connectionId, filters, tupleFilters, objects };
    });
}

/** Send the current snapshot NOW (in queue order). */
export function sendPageFiltersNow(): Promise<void> {
  pendingPageFilters = false;
  return enqueue(async () => {
    const pages = pageFiltersSnapshot();
    lastSentPageFilters = JSON.stringify(pages);
    expectResponse(await send({ op: "setPageFilters", pages }), "ack");
  });
}

/**
 * The wire last handed to Rust (JSON). A check trigger (the page list or the
 * set of objects moved) re-sends only when the wire actually changed.
 */
let lastSentPageFilters: string | null = null;

// --------------------------------------------------------------------------
// Coalesced frame flush
// --------------------------------------------------------------------------

let frameScheduled = false;
let pendingPageFilters = false;
/** Something the snapshot reads may have moved without a report-filter change: compare, send on a difference. */
let pendingPageFiltersCheck = false;
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

/** Whether the snapshot now differs from the wire last sent (a failed read counts as changed). */
function pageFiltersWireChanged(): boolean {
  try {
    return JSON.stringify(pageFiltersSnapshot()) !== lastSentPageFilters;
  } catch {
    return true;
  }
}

/** Compare the page-filter wire on the next frame (no send when nothing moved). */
function notePageFiltersCheck(): void {
  pendingPageFiltersCheck = true;
  requestFlush();
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

  const check = pendingPageFiltersCheck;
  pendingPageFiltersCheck = false;
  if (pendingPageFilters || (check && pageFiltersWireChanged())) {
    void sendPageFiltersNow().catch((e) => warnFailure("Mirroring the page filters", e));
  }

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
  // An object added, deleted or moved between sheets, a sheet added or
  // removed: the set of visuals (and so of per-object overrides) may differ
  // with no report-filter change. Compared on the frame, sent only on a
  // difference -- with NO bindings too, like every page-filter send.
  for (const evt of [
    AppEvents.MUTATION_REFRESH,
    AppEvents.SHEET_ADDED,
    AppEvents.SHEET_DELETED,
    AppEvents.STRUCTURAL_UNDO,
  ]) {
    offs.push(onAppEvent(evt, () => notePageFiltersCheck()));
  }
  offs.push(onAppEvent(AppEvents.NAMED_RANGES_CHANGED, () => reevaluateAfterNameChange()));

  // The report-filter seam's lifetime (the page list an all-pages filter
  // reaches, the selection reset): this bridge is one of its starters.
  offs.push(startReportFilters());
  const notePageFilters = (): void => {
    pendingPageFilters = true;
    requestFlush();
  };
  offs.push(onReportFiltersChange(notePageFilters));
  // The first page-list read answered, or a sheet came or went: an all-pages
  // filter now reaches other pages. The page list changes for many reasons (a
  // rename, a canvas re-size), so only a changed WIRE re-sends.
  offs.push(onReportPagesChanged(() => notePageFiltersCheck()));

  offs.push(onAppEvent(AppEvents.AFTER_OPEN, () => onDocumentReplaced()));
  offs.push(onAppEvent(AppEvents.AFTER_NEW, () => onDocumentReplaced()));
  offs.push(onAppEvent(AppEvents.BI_MODEL_CHANGED, () => void requestMeasureRefresh()));
  offs.push(onAppEvent(AppEvents.BI_REFRESH_COMPLETED, () => void requestMeasureRefresh()));
  // App locale switch (P2 S7): a binding's display text (a formatted number,
  // a measure's General text) is written by the backend in the app locale, so
  // the bindings re-resolve and the measures re-read.
  offs.push(
    onAppEvent(AppEvents.LOCALE_CHANGED, () => {
      void requestReload();
      void requestMeasureRefresh();
    }),
  );

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
