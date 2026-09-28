//! FILENAME: app/extensions/Slicer/lib/slicerFilterBridge.ts
// PURPOSE: Bridges slicer selection changes to table/pivot filters.
// CONTEXT: A slicer names WHAT it filters through its connections; this module
//          turns each connection into concrete targets and filters them:
//
//          - "table"        -> the table's AutoFilter column, through the
//                              AutoFilter owner (@api/autoFilterService);
//          - "pivot"        -> that pivot (a Report Connections pivot);
//          - "biConnection" -> a MODEL slicer's PAGE: every BI pivot of the
//                              model connection whose destination is the
//                              slicer's own sheet (or canvas), resolved at
//                              apply time so it covers pivots added later.
//
//          The switch over the source type is EXHAUSTIVE (a `never` check): a
//          new source type is a compile error here, not a silent fall-through.
//          It used to treat every connection that was not "pivot" as a TABLE,
//          so a model slicer called get_tables_for_sheet, warned "Table not
//          found" and filtered nothing.
//
//          A model column is ALWAYS named to the backend by its "Table.Column"
//          key (`biFieldKey`): the Pivot owner resolves the cache index itself
//          and, when the pivot does not carry the column yet, adds it in the
//          same command from the stored definition -- nothing the pivot already
//          has is lost, and it is ONE undo step that joins the caller's open
//          transaction. This module never rebuilds a pivot itself (the three
//          drifted frontend copies of that rebuild dropped row/column hidden
//          items, hierarchy placements and value names). A CLEAR never adds a
//          field: a column the pivot does not carry is a no-op on the server.
//
//          A target that REFUSES (the backend errs: a column the model no
//          longer has, a protected sheet) is told to the user in ONE toast per
//          gesture, naming how many targets failed -- not one per pivot, and
//          not only in the console, where a click that filtered nothing looked
//          exactly like a click that worked. The same holds for a target this
//          module finds it cannot filter itself (a range pivot without the
//          slicer's field, a table without its column or without its own
//          AutoFilter): an APPLY there throws into the same report. A CLEAR
//          there is a no-op -- there is no filter of this slicer to take off.

import type { Slicer, SlicerConnection, SlicerItem, SlicerSourceType } from "./slicerTypes";
import type {
  ApplyPivotFilterRequest,
  BiPivotModelInfo,
  ClearPivotFilterRequest,
  PivotViewResponse,
} from "@api/pivotTypes";
import { surfacePivotNotices } from "@api/pivotNotices";
import type { PivotOverwriteTally } from "@api/pivotOverwrite";
import { requireAutoFilterController } from "@api/autoFilterService";
import { emitAppEvent, AppEvents } from "@api";
import { showToast } from "@api/notifications";
import { splitBiFieldKey } from "../../_shared/lib/biFieldKey";
import { slicerBackend } from "./slicerBackend";

// ============================================================================
// Failures: told once per gesture
// ============================================================================

/** One thing a slicer's filter could not be put on (or taken off). */
export interface SlicerFilterFailure {
  /** The slicer's name, as the user sees it. */
  slicer: string;
  /** What refused: a pivot, a table, or the listing of a model slicer's page. */
  target: "pivot" | "table" | "model";
  /** True when the filter was being taken OFF (a disconnected target). */
  clearing: boolean;
  /** The backend's (or the seam's) reason. */
  message: string;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/**
 * A target cannot take this slicer's filter. Applying: throw, so the gesture's
 * one report tells the user. Clearing: nothing of this slicer's is there to
 * clear -- say so in the console and carry on.
 */
function cannotFilter(selectedItems: string[] | null, reason: string): void {
  if (selectedItems !== null) throw new Error(reason);
  console.info(`[Slicer] Nothing to clear: ${reason}`);
}

/**
 * Tell the user ONCE which targets of which slicers refused, with the first
 * reason. A caller that runs several applies for one gesture (the reconcile
 * after an undo) collects the failures and calls this once at the end.
 */
export function reportSlicerFilterFailures(failures: readonly SlicerFilterFailure[]): void {
  if (failures.length === 0) return;
  const slicers = [...new Set(failures.map((f) => f.slicer))];
  const who = slicers.length === 1
    ? `Slicer "${slicers[0]}"`
    : `Slicers ${slicers.map((s) => `"${s}"`).join(", ")}`;
  const pivots = failures.filter((f) => f.target === "pivot").length;
  const tables = failures.filter((f) => f.target === "table").length;
  const parts: string[] = [];
  if (pivots > 0) parts.push(plural(pivots, "PivotTable"));
  if (tables > 0) parts.push(plural(tables, "table"));
  if (failures.some((f) => f.target === "model")) parts.push("the PivotTables of its model");
  const what = parts.join(" and ");
  const clearing = failures.filter((f) => f.clearing).length;
  const verb = clearing === 0
    ? "could not filter"
    : clearing === failures.length
      ? "could not clear its filter on"
      : "could not update";
  showToast(`${who} ${verb} ${what}: ${failures[0].message}`, { type: "error", duration: 8000 });
}

// ============================================================================
// Targets
// ============================================================================

/** A BI pivot of a model connection, as `get_pivots_for_bi_connection` lists
 *  it (its sheet is the pivot's DESTINATION sheet, canvas-correct). */
export interface ModelConnectionPivot {
  id: string;
  name: string;
  sheetIndex: number;
}

/** One concrete thing a slicer filters. */
export type SlicerFilterTarget =
  | { kind: "table"; tableId: string }
  /** A Report Connections pivot: a range pivot (field by name) or a BI pivot
   *  (field by model key). */
  | { kind: "pivot"; pivotId: string }
  /** A model slicer's page target: always a BI pivot, always by model key. */
  | { kind: "modelPivot"; pivotId: string };

function assertNever(value: never, what: string): never {
  throw new Error(`[Slicer] Unhandled ${what}: ${String(value)}`);
}

/**
 * The PAGE rule, pure: a model slicer filters exactly the pivots of its model
 * whose destination is the slicer's own sheet. Another sheet's pivot of the
 * same model is never touched.
 */
export function pageTargets(
  pivots: readonly ModelConnectionPivot[],
  sheetIndex: number,
): ModelConnectionPivot[] {
  return pivots.filter((p) => p.sheetIndex === sheetIndex);
}

/** The BI pivots a model slicer on `sheetIndex` filters, read now. */
export async function getModelSlicerPageTargets(
  connectionId: string,
  sheetIndex: number,
): Promise<ModelConnectionPivot[]> {
  const pivots = await slicerBackend.invoke<ModelConnectionPivot[]>(
    "get_pivots_for_bi_connection",
    { connectionId },
  );
  return pageTargets(pivots ?? [], sheetIndex);
}

/**
 * Turn connections into concrete targets. A connection whose targets cannot be
 * read is skipped (its neighbours still filter) and, when the caller passes
 * `failures`, recorded there for the gesture's one report.
 */
export async function resolveFilterTargets(
  slicer: Slicer,
  connections: readonly SlicerConnection[],
  failures?: SlicerFilterFailure[],
  clearing = false,
): Promise<SlicerFilterTarget[]> {
  const out: SlicerFilterTarget[] = [];
  const seenPivots = new Set<string>();
  const pushPivot = (target: SlicerFilterTarget & { pivotId: string }) => {
    if (seenPivots.has(target.pivotId)) return;
    seenPivots.add(target.pivotId);
    out.push(target);
  };
  for (const conn of connections) {
    const type: SlicerSourceType = conn.sourceType;
    switch (type) {
      case "table":
        out.push({ kind: "table", tableId: conn.sourceId });
        break;
      case "pivot":
        pushPivot({ kind: "pivot", pivotId: conn.sourceId });
        break;
      case "biConnection":
        try {
          const page = await getModelSlicerPageTargets(conn.sourceId, slicer.sheetIndex);
          for (const p of page) pushPivot({ kind: "modelPivot", pivotId: p.id });
        } catch (err) {
          console.warn("[Slicer] Could not list the model's pivots for", conn, err);
          failures?.push({ slicer: slicer.name, target: "model", clearing, message: errorText(err) });
        }
        break;
      default:
        assertNever(type, "slicer source type");
    }
  }
  return out;
}

/**
 * The PIVOT connections among `connections` whose pivot still EXISTS. The
 * store's reconcile takes a slicer's mask off the pivots an outside change
 * DISCONNECTED (an undone or declined Report Connections save that had added
 * one) -- but a pivot disconnected because it was DELETED (the delete cascade
 * prunes it from every slicer's connections) has nothing left to clear, and a
 * clear sent to it would only come back as a refusal told to the user. Table
 * and model connections are never returned: a table's AutoFilter write
 * recorded undo of its own, and a model slicer's connection is fixed. Throws
 * when the pivots cannot be listed.
 */
export async function connectionsToExistingPivots(
  connections: readonly SlicerConnection[],
): Promise<SlicerConnection[]> {
  const pivotConnections = connections.filter((c) => c.sourceType === "pivot");
  if (pivotConnections.length === 0) return [];
  const pivots = await slicerBackend.invoke<Array<{ id: string }>>("get_all_pivot_tables", {});
  const alive = new Set((pivots ?? []).map((p) => String(p.id)));
  return pivotConnections.filter((c) => alive.has(String(c.sourceId)));
}

function pivotIdsOf(targets: readonly SlicerFilterTarget[]): string[] {
  const ids: string[] = [];
  for (const t of targets) {
    if (t.kind === "pivot" || t.kind === "modelPivot") ids.push(t.pivotId);
  }
  return ids;
}

// ============================================================================
// Public API
// ============================================================================

/** How {@link applySlicerFilter} runs. */
export interface ApplySlicerFilterOptions {
  /**
   * Re-derive ONLY the pivot masks and leave every TABLE target alone. The
   * reconcile after an undo / redo passes it, and nothing else should.
   *
   * A table target's AutoFilter write records undo of its own, JOINING the
   * click's step, so an undo or redo of the click already put the AutoFilter
   * back. Writing it again recorded a fresh step with no transaction open,
   * which cleared the redo stack and left a no-op step on top (Ctrl+Y dead,
   * the next Ctrl+Z spent on nothing). A level-1 pivot mask records no undo,
   * so it is the one target the undo cannot restore and the reconcile must.
   * Filtered per TARGET, not per slicer: one slicer can reach a table AND a
   * pivot through Report Connections, and its pivot still needs re-masking.
   */
  masksOnly?: boolean;
  /**
   * Collect the targets that refused HERE instead of telling the user. For a
   * caller that applies several slicers for ONE gesture (the reconcile after
   * an undo): it reports them once, with {@link reportSlicerFilterFailures}.
   * Absent, the apply tells the user itself -- one toast for all its targets.
   */
  failures?: SlicerFilterFailure[];
  /**
   * Note every pivot response here, for the gesture's ONE "will overwrite
   * existing data" question once its undo step has committed
   * (`@api/pivotOverwrite`). The reconcile passes none: it never asks.
   */
  overwrites?: PivotOverwriteTally;
}

/**
 * How one run of pivot/table writes is told apart: the gesture's overwrite
 * tally, and whether it is the undo/redo RECONCILE -- whose pivot requests
 * carry `reconcile: true`, so the backend records NO undo step for them (an
 * overwrite included): one recorded after an undo wipes the redo stack.
 */
interface FilterRun {
  overwrites?: PivotOverwriteTally;
  reconcile: boolean;
}

/**
 * Apply the slicer's current selection to everything it filters: its Report
 * Connections, or -- for a model slicer -- every BI pivot of its model on its
 * own sheet. Run it inside the caller's undo transaction when it is part of a
 * user gesture: a server-side ensure records one step that JOINS it.
 */
export async function applySlicerFilter(
  slicer: Slicer,
  options: ApplySlicerFilterOptions = {},
): Promise<void> {
  const failures: SlicerFilterFailure[] = [];
  try {
    const resolved = await resolveFilterTargets(slicer, slicer.connectedSources ?? [], failures);
    const targets = options.masksOnly ? resolved.filter((t) => t.kind !== "table") : resolved;
    if (targets.length > 0) {
      const run: FilterRun = { overwrites: options.overwrites, reconcile: options.masksOnly === true };
      failures.push(...(await filterTargets(slicer, targets, slicer.selectedItems, "Applying filter...", run)));
      // Trigger grid refresh so filtered rows are visible
      emitAppEvent(AppEvents.GRID_REFRESH);
    }
  } catch (err) {
    console.error("[Slicer] Failed to apply filter:", err);
    failures.push({ slicer: slicer.name, target: "pivot", clearing: false, message: errorText(err) });
  }
  if (options.failures) options.failures.push(...failures);
  else reportSlicerFilterFailures(failures);
}

/**
 * Called when Report Connections change. Clears filters on removed pivots/tables
 * and applies the slicer's current selection on newly added ones. `overwrites`
 * collects the pivot responses for the Save's one overwrite question.
 */
export async function syncReportConnections(
  slicer: Slicer,
  oldConns: SlicerConnection[],
  newConns: SlicerConnection[],
  overwrites?: PivotOverwriteTally,
): Promise<void> {
  // ONE report for the whole Save: the clears and the applies together.
  const failures: SlicerFilterFailure[] = [];
  const run: FilterRun = { overwrites, reconcile: false };
  try {
    const key = (c: SlicerConnection) => `${c.sourceType}:${c.sourceId}`;
    const oldKeys = new Set(oldConns.map(key));
    const newKeys = new Set(newConns.map(key));

    const removed = oldConns.filter((c) => !newKeys.has(key(c)));
    const added = newConns.filter((c) => !oldKeys.has(key(c)));

    // Clear filter on disconnected sources
    const removedTargets = await resolveFilterTargets(slicer, removed, failures, true);
    if (removedTargets.length > 0) {
      failures.push(...(await filterTargets(slicer, removedTargets, null, "Clearing filter...", run)));
    }
    // Apply current filter on newly connected sources
    const addedTargets = await resolveFilterTargets(slicer, added, failures);
    if (addedTargets.length > 0) {
      failures.push(...(await filterTargets(slicer, addedTargets, slicer.selectedItems, "Applying filter...", run)));
    }

    if (removed.length > 0 || added.length > 0) {
      emitAppEvent(AppEvents.GRID_REFRESH);
    }
  } catch (err) {
    console.error("[Slicer] Failed to sync report connections:", err);
    failures.push({ slicer: slicer.name, target: "pivot", clearing: false, message: errorText(err) });
  }
  reportSlicerFilterFailures(failures);
}

/**
 * The items of a PIVOT slicer whose column its BI pivot no longer carries
 * (`get_slicer_items` answered "not found in pivot cache": the column was
 * dragged out of Rows, or a Clear followed by a layout edit dropped it), read
 * from the pivot's MODEL instead. Resolves null when the slicer's pivot is not
 * a BI pivot or the key names no model column.
 *
 * READS ONLY. This runs from the store's item refresh, which a sheet switch
 * triggers, and a navigation must never write. It used to put the column back
 * into the pivot from here (`apply_pivot_filter` with an ensure): a BI
 * re-query that dirtied the document and pushed a standalone undo step --
 * clearing the redo stack -- on a plain sheet-tab click, and again on the next
 * one. Listing the items from the model keeps the slicer usable; the column
 * goes back into the pivot on the next CLICK, whose apply runs the same ensure
 * inside the click's own undo step.
 */
export async function listPivotSlicerItemsFromModel(slicer: Slicer): Promise<SlicerItem[] | null> {
  if (slicer.sourceType !== "pivot" || !isModelKey(slicer.fieldName)) return null;
  const info = await slicerBackend.invoke<PivotHierarchiesInfo>("get_pivot_hierarchies", {
    pivotId: slicer.cacheSourceId,
  });
  const model = info?.biModel;
  if (!model?.connectionId) return null;
  const { table, column } = splitBiFieldKey(
    slicer.fieldName,
    (model.tables ?? []).map((t) => t.name),
  );
  if (!table) return null;
  const values = await slicerBackend.invoke<string[]>("bi_get_column_values", {
    connectionId: model.connectionId,
    table,
    column,
  });
  const selected = slicer.selectedItems;
  // The same rule get_slicer_items applies: no selection = every item on.
  // Availability is not shaded -- it would have to come from the pivot cache,
  // which is exactly what does not carry the column.
  return (values ?? []).map((value) => ({
    value,
    selected: selected === null || selected.includes(value),
    hasData: true,
  }));
}

// ============================================================================
// Filtering
// ============================================================================

/** The slice of `get_pivot_hierarchies` this module reads. */
interface PivotHierarchiesInfo {
  hierarchies: Array<{ index: number; name: string }>;
  /** Present only for BI (model) pivots. */
  biModel?: Partial<Pick<BiPivotModelInfo, "connectionId" | "tables">>;
}

/** A model column key is "Table.Column": the backend splits it against the
 *  model's own table names (a table name may contain a dot). */
function isModelKey(fieldName: string): boolean {
  return fieldName.includes(".");
}

/**
 * Filter every target with `selectedItems` (null = clear), with the loading
 * overlay on each pivot for the duration (cleared even when a step throws),
 * and ONE pivot:refresh at the end. A target that refuses does not stop the
 * others; it is returned, for the caller's one report.
 */
async function filterTargets(
  slicer: Slicer,
  targets: readonly SlicerFilterTarget[],
  selectedItems: string[] | null,
  stage: string,
  run: FilterRun,
): Promise<SlicerFilterFailure[]> {
  const failures: SlicerFilterFailure[] = [];
  const pivotIds = pivotIdsOf(targets);
  for (const pivotId of pivotIds) {
    window.dispatchEvent(new CustomEvent("pivot:set-loading", { detail: { pivotId, stage } }));
  }
  try {
    for (const target of targets) {
      try {
        await filterOneTarget(slicer, target, selectedItems, run);
      } catch (err) {
        console.warn("[Slicer] Failed to filter", target, err);
        failures.push({
          slicer: slicer.name,
          target: target.kind === "table" ? "table" : "pivot",
          clearing: selectedItems === null,
          message: errorText(err),
        });
      }
    }
  } finally {
    for (const pivotId of pivotIds) {
      window.dispatchEvent(new CustomEvent("pivot:clear-loading", { detail: { pivotId } }));
    }
  }
  if (pivotIds.length > 0) window.dispatchEvent(new Event("pivot:refresh"));
  return failures;
}

async function filterOneTarget(
  slicer: Slicer,
  target: SlicerFilterTarget,
  selectedItems: string[] | null,
  run: FilterRun,
): Promise<void> {
  const level = slicer.filterLevel ?? 1;
  switch (target.kind) {
    case "table":
      await applyTableFilterForSource(target.tableId, slicer.fieldName, selectedItems, slicer.sheetIndex);
      return;
    case "pivot":
      await applyPivotFilterForSource(target.pivotId, slicer.fieldName, selectedItems, level, slicer.id, run);
      return;
    case "modelPivot":
      await applyModelColumnFilter(target.pivotId, slicer.fieldName, selectedItems, level, slicer.id, run);
      return;
    default:
      assertNever(target, "slicer filter target");
  }
}

/**
 * Filter one BI pivot by a model column. Apply: the backend resolves -- and,
 * when missing, adds -- the column. Clear: a column the pivot does not carry
 * is a no-op; clearing never adds a field.
 */
async function applyModelColumnFilter(
  pivotId: string,
  key: string,
  selectedItems: string[] | null,
  filterLevel: number,
  slicerId: string,
  run: FilterRun,
): Promise<void> {
  if (selectedItems === null) {
    const request: ClearPivotFilterRequest = { pivotId, biFieldKey: key, ...reconcileFlag(run) };
    notePivotResponse(run, await slicerBackend.invoke<PivotViewResponse>("clear_pivot_filter", { request }));
    return;
  }
  const request: ApplyPivotFilterRequest = {
    pivotId,
    biFieldKey: key,
    filters: { manualFilter: { selectedItems } },
    // Level >= 2 routes the selection INSIDE the BI query (a pinned filter
    // that measure CLEAR/RESET semantics honor); the slicer id preserves
    // origin.
    filterLevel,
    slicerId,
    ...reconcileFlag(run),
  };
  notePivotResponse(run, await slicerBackend.invoke<PivotViewResponse>("apply_pivot_filter", { request }));
}

/** `reconcile: true` on the reconcile's requests only (absent otherwise). */
function reconcileFlag(run: FilterRun): { reconcile?: true } {
  return run.reconcile ? { reconcile: true } : {};
}

/** Tell the user a response's notices, and note what it overwrote for the
 *  gesture's one question. */
function notePivotResponse(run: FilterRun, response: PivotViewResponse | null | undefined): void {
  surfacePivotNotices(response);
  run.overwrites?.note(response);
}

/**
 * A range pivot's field for `fieldName`: the exact name, else -- for a model
 * key ("Table.Column") connected to a range pivot -- the field whose name the
 * key ENDS with after a dot, longest first. Matching the suffix instead of
 * splitting on a dot keeps a column name that itself contains a dot intact.
 */
export function rangePivotField(
  hierarchies: ReadonlyArray<{ index: number; name: string }>,
  fieldName: string,
): { index: number; name: string } | undefined {
  const exact = hierarchies.find((h) => h.name === fieldName);
  if (exact) return exact;
  let best: { index: number; name: string } | undefined;
  for (const h of hierarchies) {
    if (h.name.length > 0 && fieldName.endsWith(`.${h.name}`) && (!best || h.name.length > best.name.length)) {
      best = h;
    }
  }
  return best;
}

/**
 * Filter a Report Connections pivot. A BI pivot is addressed by the model key
 * (the backend resolves it; a bare column name would be ambiguous between two
 * tables that share it). A range pivot carries every source column, so its
 * field is resolved by name; a missing one is reported, not guessed.
 */
async function applyPivotFilterForSource(
  pivotId: string,
  fieldName: string,
  selectedItems: string[] | null,
  filterLevel: number,
  slicerId: string,
  run: FilterRun,
): Promise<void> {
  const info = await slicerBackend.invoke<PivotHierarchiesInfo>("get_pivot_hierarchies", { pivotId });
  if (info?.biModel && isModelKey(fieldName)) {
    await applyModelColumnFilter(pivotId, fieldName, selectedItems, filterLevel, slicerId, run);
    return;
  }
  const field = rangePivotField(info?.hierarchies ?? [], fieldName);
  if (!field) {
    cannotFilter(selectedItems, `the PivotTable has no field "${fieldName}"`);
    return;
  }
  // A range pivot grows over the user's cells exactly as a BI pivot does: its
  // response is noted for the gesture's one question too. (The write is
  // awaited on its own line: `run.overwrites?.note(await ...)` would skip the
  // WRITE, not just the note, whenever there is no tally.)
  if (selectedItems === null) {
    const request: ClearPivotFilterRequest = { pivotId, fieldIndex: field.index, ...reconcileFlag(run) };
    const response = await slicerBackend.invoke<PivotViewResponse>("clear_pivot_filter", { request });
    run.overwrites?.note(response);
  } else {
    const request: ApplyPivotFilterRequest = {
      pivotId,
      fieldIndex: field.index,
      filters: { manualFilter: { selectedItems } },
      filterLevel,
      slicerId,
      ...reconcileFlag(run),
    };
    const response = await slicerBackend.invoke<PivotViewResponse>("apply_pivot_filter", { request });
    run.overwrites?.note(response);
  }
}

/**
 * Apply a table filter to a specific table source.
 *
 * The AutoFilter belongs to its OWNER, reached through @api/autoFilterService
 * (the Seam Rule): the owner's controller sends the same backend commands, and
 * it also re-reads the filter into the owner's cache and pushes the new
 * hidden-row set into the grid. This used to invoke `get_auto_filter` /
 * `set_column_filter_values` / `clear_column_criteria` itself, which
 * filtered the WORKBOOK and left the grid showing the rows it had just hidden
 * (and the owner's cached range stale) until something else re-read it.
 */
async function applyTableFilterForSource(
  tableId: string,
  fieldName: string,
  selectedItems: string[] | null,
  sheetIndex: number,
): Promise<void> {
  // `get_tables_for_sheet` reads the named sheet regardless of which one is
  // active. It was invoked here long before it existed on the Rust side, so
  // every table-sourced slicer threw on click; the rest of the table-slicer
  // path (value listing, connections, filtering) was implemented and working.
  const tables = await slicerBackend.invoke<Array<{
    id: string;
    startCol: number;
    autoFilterId?: string;
    columns: Array<{ name: string }>;
    styleOptions: { headerRow: boolean; showFilterButton: boolean };
  }>>("get_tables_for_sheet", { sheetIndex });

  const table = tables.find((t) => t.id === tableId);
  if (!table) {
    cannotFilter(selectedItems, "its table is no longer on the slicer's sheet");
    return;
  }

  const colOffset = table.columns.findIndex((c) => c.name === fieldName);
  if (colOffset < 0) {
    cannotFilter(selectedItems, `the table has no column "${fieldName}"`);
    return;
  }

  // A sheet has exactly ONE AutoFilter, and `column_filters` is keyed relative
  // to THAT filter's start_col — not to the table's. So two things have to hold
  // before we can touch it: the filter must actually BE this table's (compare
  // ids; with several filter-bearing tables on a sheet it belongs to just one),
  // and the index must be translated through absolute grid coordinates.
  const autoFilter = requireAutoFilterController();
  const af = await autoFilter.get();
  if (!af) {
    cannotFilter(selectedItems, "the table's sheet has no AutoFilter to filter with");
    return;
  }
  if (!table.autoFilterId || table.autoFilterId !== af.id) {
    // Refused rather than filtering ANOTHER table's columns.
    cannotFilter(selectedItems, "the sheet's AutoFilter belongs to another table");
    return;
  }
  const absCol = table.startCol + colOffset;
  if (absCol < af.startCol || absCol > af.endCol) {
    cannotFilter(selectedItems, `column "${fieldName}" is outside the table's AutoFilter range`);
    return;
  }
  const colIndex = absCol - af.startCol;

  // A refusal (a protected sheet) throws here and is reported per target by
  // the caller; the other targets still filter.
  if (selectedItems === null) {
    await autoFilter.clear(colIndex);
  } else {
    await autoFilter.setColumn(colIndex, {
      kind: "values",
      values: selectedItems.filter((v) => v !== "" && v !== "(Blanks)"),
      includeBlanks: selectedItems.some((v) => v === "" || v === "(Blanks)"),
    });
  }
}
