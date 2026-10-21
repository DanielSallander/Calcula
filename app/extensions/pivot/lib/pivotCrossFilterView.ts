//! FILENAME: app/extensions/Pivot/lib/pivotCrossFilterView.ts
// PURPOSE: A canvas BI pivot box as a cross-filter TARGET (P4, G4, S7): while
//          another visual on its page holds a selection that reaches the box,
//          the box PAINTS a filtered view -- the pivot's own query plus that
//          selection, run headless by `run_bi_pivot_filtered_view` -- with a
//          "Filtered by <source>" badge. Nothing of the real pivot changes:
//          its cells in the canvas's hidden grid, GETPIVOTDATA and every
//          formula reading it keep the REAL values.
// CONTEXT: The real view lives in pivotViewStore.ts; the filtered response
//          lives ONLY here (`filteredViews`), never in that store, so
//          `getCachedPivotView` keeps answering the REAL view to every caller
//          that acts on the pivot (its groupPaths index the real cache; the
//          filtered response's index a TRANSIENT cache the backend built for
//          one read). Readers of what the box SHOWS ask `getDisplayedPivotView`;
//          the classification of every caller is pinned by
//          __tests__/pivotFilteredViewConsumers.test.ts.
//
//          WHAT REACHES THE BOX. `resolveFiltersFor(page, {pivot, canHighlight:
//          false}, connection, {include: "visualSelectionsOnly"})`: ONLY other
//          visuals' cross-filter selections. A model slicer and a ribbon filter
//          already reach the pivot through its persisted backend route (the
//          page fold writes their items into the pivot's definition), and the
//          command applies those itself -- sending them again would apply them
//          twice. A pivot cannot paint a highlight, so a highlight-mode pair is
//          a filter here (the resolver's rule 2).
//
//          WHEN. On every report-filter change naming the box's page (or "*")
//          and connection, or the box as a target; on every new REAL view of
//          the pivot (`PIVOT_VIEW_UPDATED`, which `cachePivotView` and
//          `setCachedPivotView` announce); and when the region sync announces
//          the page's boxes. A read is keyed by a signature (the request plus
//          the real view's version): the same question is never sent twice,
//          and only the latest read of a pivot is stored.
//
//          A REFUSAL (a windowed pivot, hierarchies, a calculation group, a
//          LOOKUP column, a measure the engine cannot evaluate under the
//          selection) is stored as `{error}`: the box shows its REAL view and
//          a badge "Not filtered by <source>: <reason>" -- never an
//          approximation.

import { showToast } from "@api";
import { AppEvents, onAppEvent } from "@api/events";
import { getGridStateSnapshot } from "@api/grid";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { getAppLocale } from "@api/locale";
import {
  clearCrossFilter,
  onReportFiltersChange,
  pruneMissingCrossFilterSources,
  resolveFiltersFor,
  startReportFilters,
  type ReportFiltersChange,
  type ResolvedFilters,
  type VisualRef,
} from "@api/reportFilters";
import { getReportPagesSnapshot, sheetIdAt } from "@api/reportPages";
import { splitBiFieldKey } from "../../_shared/lib/biFieldKey";
import type { DesignQueryFieldRef, DesignQueryTupleFilter } from "../../_shared/dsl/pivotLayout/designQuery";
import { PivotEvents } from "../../_shared/lib/pivotEvents";
import type { PivotRegionData, PivotViewResponse } from "./pivot-api";
import { pivotBackend } from "./pivotBackend";
import { getCachedPivotView } from "./pivotViewStore";
import {
  currentPivotBoxes,
  ensurePivotModelInfo,
  forgetPivotBox,
  forgetPivotModelInfo,
  getPivotBox,
  notePivotBoxes,
  pivotBoxSheetId,
  pivotModelInfo,
  registerPivotModelVisuals,
  resetPivotModelVisuals,
} from "./pivotModelVisuals";

/** The paint-only command (Rust `pivot::headless::run_bi_pivot_filtered_view`). A read. */
export const PIVOT_FILTERED_VIEW_COMMAND = "run_bi_pivot_filtered_view";

/** The wire request of the command (Rust `BiPivotFilteredViewRequest`). */
export interface PivotFilteredViewRequest {
  pivotId: string;
  pageFilterFields: DesignQueryFieldRef[];
  tupleFilters: DesignQueryTupleFilter[];
}

/** What one box shows besides its real view. */
interface FilteredViewState {
  /** The question this state answers (request + real view version). */
  signature: string;
  /** The names of the visuals whose selections filter the box (badge, note). */
  sources: string[];
  /** Their refs ("Clear visual selection" clears them). */
  sourceRefs: VisualRef[];
  /** The filtered view, or null when the backend refused. */
  view: PivotViewResponse | null;
  /** The refusal, or null. */
  error: string | null;
}

/** The badge a box paints in its content rect's top-right corner. */
export interface PivotCrossFilterBadge {
  kind: "filtered" | "notFiltered";
  text: string;
}

const filteredViews = new Map<string, FilteredViewState>();
/** The signature of the read in flight per pivot (the same question is not sent twice). */
const pendingSignature = new Map<string, string>();
/** Read sequence per pivot: only the latest read is stored. */
const readSeq = new Map<string, number>();
const changeListeners = new Set<(pivotId: string) => void>();

/** The ref a pivot box's selection is held under, and the target it is resolved as. */
export function pivotVisualRef(pivotId: string): VisualRef {
  return { kind: "pivot", id: pivotId };
}

function notify(pivotId: string): void {
  for (const cb of [...changeListeners]) {
    try {
      cb(pivotId);
    } catch (err) {
      console.error("[Pivot] a filtered-view listener threw:", err);
    }
  }
  requestOverlayRedraw();
}

/** Be told when a box's filtered view appears, changes or goes. Returns the unsubscribe. */
export function onPivotFilteredViewChange(cb: (pivotId: string) => void): () => void {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}

/** The filtered view a box shows now, or undefined (none, or refused). */
export function getFilteredPivotView(pivotId: string): PivotViewResponse | undefined {
  return filteredViews.get(pivotId)?.view ?? undefined;
}

/**
 * What the box SHOWS: its filtered view while one applies, else the REAL view.
 * Paint, the clamp of the cell selection, keyboard moves over the cells, the
 * formula bar and Copy read this; everything that ACTS on the pivot reads the
 * real view (`getCachedPivotView`).
 */
export function getDisplayedPivotView(pivotId: string): PivotViewResponse | undefined {
  return getFilteredPivotView(pivotId) ?? getCachedPivotView(pivotId);
}

/** Whether the box shows a filtered view now (its cells are not the real pivot's). */
export function isShowingFilteredView(pivotId: string): boolean {
  return getFilteredPivotView(pivotId) !== undefined;
}

function sourceList(names: readonly string[]): string {
  return names.length > 0 ? names.join(", ") : "another visual";
}

/** The badge of a box, or null when no selection reaches it. */
export function getPivotCrossFilterBadge(pivotId: string): PivotCrossFilterBadge | null {
  const state = filteredViews.get(pivotId);
  if (!state) return null;
  if (state.view) return { kind: "filtered", text: `Filtered by ${sourceList(state.sources)}` };
  if (state.error) return { kind: "notFiltered", text: `Not filtered by ${sourceList(state.sources)}: ${state.error}` };
  return null;
}

/** The one sentence a refused action of a filtered box says. */
export function filteredViewNote(pivotId: string): string {
  const names = filteredViews.get(pivotId)?.sources ?? [];
  return `Filtered by ${sourceList(names)} -- clear the selection to change this PivotTable here`;
}

/**
 * The guard of every action that would hand a DISPLAYED cell's coordinates or
 * groupPath to a command acting on the real pivot: while the box shows a
 * filtered view it refuses -- tells the user, sends nothing -- and answers true.
 */
export function refuseWhileFiltered(pivotId: string): boolean {
  if (!isShowingFilteredView(pivotId)) return false;
  showToast(filteredViewNote(pivotId), { variant: "info" });
  return true;
}

/** Clear the selections that filter a box ("Clear visual selection"). */
export function clearSelectionsFiltering(pivotId: string): void {
  const refs = filteredViews.get(pivotId)?.sourceRefs ?? [];
  for (const ref of refs) clearCrossFilter(ref);
}

/** Split a "Table.Column" field against the model, or null when the model has no such table. */
function splitModelField(field: string, tableNames: readonly string[]): { table: string; column: string } | null {
  const split = splitBiFieldKey(field, [...tableNames]);
  return tableNames.includes(split.table) && split.column ? split : null;
}

/**
 * The command's request for the resolved selections, pure. A rectangular
 * selection arrives as one KEEP filter per field (`pageFilterFields`, keys as
 * keys -- the backend re-spells them for the engine and maps the blank key ""
 * to the engine's blank); a non-rectangular one as a tuple filter. A field
 * naming no table of the model is skipped (and said): it cannot be kept, and
 * sending it would refuse the whole view instead of that one filter; a tuple
 * filter is skipped WHOLE, since dropping one column would widen it.
 * Null when nothing is left to apply.
 */
export function buildFilteredViewRequest(
  pivotId: string,
  resolved: Pick<ResolvedFilters, "filters" | "tupleFilters">,
  tableNames: readonly string[],
): PivotFilteredViewRequest | null {
  const pageFilterFields: DesignQueryFieldRef[] = [];
  for (const f of resolved.filters) {
    const split = splitModelField(f.field, tableNames);
    if (!split) {
      console.warn(`[Pivot] "${f.from}" filters "${f.field}", which this PivotTable's model has no table for; not applied.`);
      continue;
    }
    const level = typeof f.level === "number" && f.level > 1 ? { level: f.level } : {};
    pageFilterFields.push({ table: split.table, column: split.column, includedItems: [...f.includedKeys], ...level });
  }
  const tupleFilters: DesignQueryTupleFilter[] = [];
  for (const tf of resolved.tupleFilters) {
    const fields: Array<{ table: string; column: string }> = [];
    let missing: string | null = null;
    for (const field of tf.fields) {
      const split = splitModelField(field, tableNames);
      if (!split) {
        missing = field;
        break;
      }
      fields.push(split);
    }
    if (missing !== null) {
      console.warn(`[Pivot] "${tf.from}" filters "${missing}", which this PivotTable's model has no table for; not applied.`);
      continue;
    }
    tupleFilters.push({ fields, tuples: tf.tuples.map((t) => [...t]) });
  }
  if (pageFilterFields.length === 0 && tupleFilters.length === 0) return null;
  return { pivotId, pageFilterFields, tupleFilters };
}

/** Stop showing a box's filtered view (nothing reaches it any more). */
function drop(pivotId: string): void {
  readSeq.set(pivotId, (readSeq.get(pivotId) ?? 0) + 1);
  pendingSignature.delete(pivotId);
  if (filteredViews.delete(pivotId)) notify(pivotId);
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.trim() || "the backend refused the filtered view";
}

/**
 * Bring one box's filtered view up to date: resolve what reaches it, and read
 * the view when that changed. Resolves once the state is stored (or the read
 * was superseded).
 */
export async function refreshPivotCrossFilter(pivotId: string): Promise<void> {
  const box = getPivotBox(pivotId);
  if (!box || !box.isModel) {
    drop(pivotId);
    return;
  }
  const sheetId = pivotBoxSheetId(box);
  if (!sheetId) {
    drop(pivotId);
    return;
  }
  let info = pivotModelInfo(pivotId);
  if (info === undefined) {
    const seqBefore = readSeq.get(pivotId) ?? 0;
    info = await ensurePivotModelInfo(pivotId);
    // A later refresh (or a drop) took over while the model was read.
    if ((readSeq.get(pivotId) ?? 0) !== seqBefore) return;
  }
  if (!info) {
    drop(pivotId);
    return;
  }
  const ref = pivotVisualRef(pivotId);
  const resolved = resolveFiltersFor(sheetId, { ref, canHighlight: false }, info.connectionId, {
    include: "visualSelectionsOnly",
  });
  const request = buildFilteredViewRequest(pivotId, resolved, info.tableNames);
  if (!request) {
    drop(pivotId);
    return;
  }
  // The real view is what the filtered one stands in for: without it there
  // is nothing to pair (its arrival announces itself and refreshes again).
  const real = getCachedPivotView(pivotId);
  if (!real) return;

  const visualSources = resolved.sources.filter((s) => s.ref !== null);
  const sources = [...new Set(visualSources.map((s) => s.name).filter((n) => n !== ""))];
  const sourceRefs = visualSources.map((s) => s.ref as VisualRef);
  // The LOCALE belongs in the question: Rust writes the filtered view's
  // formatted values and member labels in the app locale, and a locale switch
  // moves neither the definition version nor the request's keys -- without it
  // the box kept the old locale's text after a switch.
  const signature = JSON.stringify({ version: real.version, locale: getAppLocale()?.localeId ?? "", request });
  if (filteredViews.get(pivotId)?.signature === signature) return;
  if (pendingSignature.get(pivotId) === signature) return;

  const mine = (readSeq.get(pivotId) ?? 0) + 1;
  readSeq.set(pivotId, mine);
  pendingSignature.set(pivotId, signature);
  let next: FilteredViewState;
  try {
    const view = await pivotBackend.invoke<PivotViewResponse>(PIVOT_FILTERED_VIEW_COMMAND, { request });
    next = { signature, sources, sourceRefs, view, error: null };
  } catch (err) {
    next = { signature, sources, sourceRefs, view: null, error: messageOf(err) };
  }
  if (readSeq.get(pivotId) !== mine) return;
  pendingSignature.delete(pivotId);
  filteredViews.set(pivotId, next);
  notify(pivotId);
}

/** Refresh every box of the active canvas. */
export function refreshAllPivotCrossFilters(): void {
  for (const box of currentPivotBoxes()) void refreshPivotCrossFilter(box.pivotId);
}

/** Whether a report-filter change may move what reaches `box`. */
function changeReaches(change: ReportFiltersChange, pivotId: string): boolean {
  if (change.targets.some((t) => t.kind === "pivot" && t.id === pivotId)) return true;
  const box = getPivotBox(pivotId);
  if (!box) return false;
  const sheetId = pivotBoxSheetId(box);
  const info = pivotModelInfo(pivotId);
  return change.pages.some(
    (p) =>
      (p.sheetId === "*" || p.sheetId === sheetId) &&
      // A model not read yet cannot be compared: refresh (it reads it).
      (info === undefined || info === null || p.connectionId === info.connectionId),
  );
}

/** The canvas sheet index Core shows now, or null. */
function activeSheetIndex(): number | null {
  const idx = getGridStateSnapshot()?.sheetContext?.activeSheetIndex;
  return typeof idx === "number" ? idx : null;
}

/** The region sync announced the active sheet's pivots: note its boxes and refresh them. */
export function syncPivotCrossFilterBoxes(regions: readonly PivotRegionData[], sheetIndex: number): void {
  const boxes = notePivotBoxes(regions, sheetIndex);
  // A pivot no longer on this page -- gone by ANY route: undo of its
  // creation, a script/MCP/AI removal, not only Delete PivotTable -- takes its
  // cross-filter selection with it, or the page stays filtered by a box
  // nobody can click to clear (P4: "cleared on source delete").
  const pageSheetId = sheetIdAt(getReportPagesSnapshot(), sheetIndex);
  if (pageSheetId) pruneMissingCrossFilterSources("pivot", regions.map((r) => r.pivotId), pageSheetId);
  const shown = new Set(boxes.map((b) => b.pivotId));
  // A box no longer shown paints nothing: its filtered view goes (it is read
  // again when its page comes back).
  for (const pivotId of [...filteredViews.keys(), ...pendingSignature.keys()]) {
    if (!shown.has(pivotId)) drop(pivotId);
  }
  for (const box of boxes) void refreshPivotCrossFilter(box.pivotId);
}

/** A pivot was deleted: its selection goes (Power BI), and so does its box. */
export function notePivotDeleted(pivotId: string): void {
  clearCrossFilter(pivotVisualRef(pivotId));
  drop(pivotId);
  forgetPivotBox(pivotId);
}

/**
 * Install the Pivot family's cross-filter services: the seam's lifetime
 * (`startReportFilters`), the @api/modelVisuals provider, and the listeners
 * that keep every box's filtered view current. Returns the cleanups.
 */
export function installPivotCrossFilter(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  cleanups.push(startReportFilters());
  cleanups.push(registerPivotModelVisuals());
  cleanups.push(
    onReportFiltersChange((change) => {
      for (const box of currentPivotBoxes()) {
        if (changeReaches(change, box.pivotId)) void refreshPivotCrossFilter(box.pivotId);
      }
    }),
  );
  cleanups.push(
    onAppEvent<{ pivotId?: unknown }>(PivotEvents.PIVOT_VIEW_UPDATED, (detail) => {
      const pivotId = detail?.pivotId;
      if (typeof pivotId === "string" && getPivotBox(pivotId)) void refreshPivotCrossFilter(pivotId);
    }),
  );
  cleanups.push(
    onAppEvent<{ regions?: unknown }>(PivotEvents.PIVOT_REGIONS_UPDATED, (detail) => {
      const regions = Array.isArray(detail?.regions) ? (detail.regions as PivotRegionData[]) : null;
      const sheetIndex = activeSheetIndex();
      if (!regions || sheetIndex === null) return;
      syncPivotCrossFilterBoxes(regions, sheetIndex);
    }),
  );
  // A locale switch re-reads every box's filtered view (its text is Rust's,
  // written in the app locale; the signature carries the locale id).
  cleanups.push(onAppEvent(AppEvents.LOCALE_CHANGED, () => refreshAllPivotCrossFilters()));
  cleanups.push(
    onAppEvent("bi:model-changed", () => {
      forgetPivotModelInfo();
      refreshAllPivotCrossFilters();
    }),
  );
  // A new document: its pivots may reuse the old one's ids, so no view and no
  // model read survives. The boxes stay -- the new document's region sync may
  // already have announced them (event order is not promised) -- and a box of
  // the old document names a sheet id the new one does not have, so it is
  // never listed (pivotModelVisuals.ts).
  const onDocument = () => resetPivotCrossFilterViews({ keepBoxes: true });
  cleanups.push(onAppEvent(AppEvents.AFTER_NEW, onDocument));
  cleanups.push(onAppEvent(AppEvents.AFTER_OPEN, onDocument));
  cleanups.push(() => resetPivotCrossFilterViews());
  return cleanups;
}

/**
 * Forget every filtered view and every model read, and -- unless `keepBoxes`
 * -- every box (deactivation, tests).
 */
export function resetPivotCrossFilterViews(options: { keepBoxes?: boolean } = {}): void {
  const had = [...filteredViews.keys()];
  filteredViews.clear();
  pendingSignature.clear();
  for (const k of [...readSeq.keys()]) readSeq.set(k, (readSeq.get(k) ?? 0) + 1);
  if (options.keepBoxes) forgetPivotModelInfo();
  else resetPivotModelVisuals();
  for (const pivotId of had) notify(pivotId);
}

/** Test hook: state a box's filtered view directly (no backend). */
export function setFilteredPivotViewForTest(
  pivotId: string,
  state: { view?: PivotViewResponse | null; error?: string | null; sources?: string[]; sourceRefs?: VisualRef[] } | null,
): void {
  if (state === null) {
    filteredViews.delete(pivotId);
  } else {
    filteredViews.set(pivotId, {
      signature: "test",
      sources: state.sources ?? [],
      sourceRefs: state.sourceRefs ?? [],
      view: state.view ?? null,
      error: state.error ?? null,
    });
  }
  notify(pivotId);
}
