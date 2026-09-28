//! FILENAME: app/extensions/ControlsPane/lib/filterPaneFilterBridge.ts
// PURPOSE: Bridges ribbon filter selection changes to the BI pivots backed
//          by the filter's model connection. Only pivots on the SAME
//          connection are ever targeted — a filter from one Calcula model
//          never touches pivots of another model.
//
//          A pivot that REFUSES (the backend errs: a column the model no
//          longer has) is told to the user in ONE toast per gesture, naming
//          how many pivots refused -- not one per pivot, and not only in the
//          console, where a filter that reached nothing looked like one that
//          worked. The other pivots still filter. A filter whose pivots cannot
//          even be LISTED (the model is not connected) is reported the same
//          way: it used to look exactly like a filter with no pivots.

import type { RibbonFilter } from "./filterPaneTypes";
import type {
  ApplyPivotFilterRequest,
  ClearPivotFilterRequest,
  PivotViewResponse,
} from "@api/pivotTypes";
import { surfacePivotNotices } from "@api/pivotNotices";
import type { PivotOverwriteTally } from "@api/pivotOverwrite";
import { emitAppEvent, AppEvents } from "@api";
import { showToast } from "@api/notifications";
import { runInUndoTransaction } from "@api/objectGeometry";
import { filterPaneBackend } from "./filterPaneBackend";
import { getAllFilters } from "./filterPaneStore";
import { getPivotsForBiConnection } from "./filterPaneApi";

// ============================================================================
// Failures: told once per gesture
// ============================================================================

/** One pivot a ribbon filter could not be put on (or taken off). */
export interface RibbonFilterFailure {
  /** The filter's name, or its "Table.Column" key when only that is known. */
  filter: string;
  /** The pivot that refused; "" when the step failed before reaching one. */
  pivotId: string;
  /** True when the filter was being taken OFF. */
  clearing: boolean;
  /** The backend's reason. */
  message: string;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Tell the user ONCE which pivots refused which filters, with the first
 * reason. A gesture that runs several bridge calls (the Report Connections
 * Save: clears, then an apply) passes one list through them and calls this
 * once at the end.
 */
export function reportRibbonFilterFailures(failures: readonly RibbonFilterFailure[]): void {
  if (failures.length === 0) return;
  const filters = [...new Set(failures.map((f) => f.filter))];
  const who = filters.length === 1
    ? `Filter "${filters[0]}"`
    : `Filters ${filters.map((f) => `"${f}"`).join(", ")}`;
  const pivots = new Set(failures.map((f) => f.pivotId).filter((id) => id !== "")).size;
  const what = pivots === 0 ? "its PivotTables" : `${pivots} PivotTable${pivots === 1 ? "" : "s"}`;
  const clearing = failures.filter((f) => f.clearing).length;
  const verb = clearing === 0
    ? "could not filter"
    : clearing === failures.length
      ? "could not be removed from"
      : "could not update";
  showToast(`${who} ${verb} ${what}: ${failures[0].message}`, { type: "error", duration: 8000 });
}

// ============================================================================
// Filtering one pivot
// ============================================================================

/**
 * Filter one BI pivot by one model column. The column is named by its
 * "Table.Column" key (`biFieldKey`): the Pivot owner resolves it and, when the
 * pivot does not carry it yet, adds it in the same command from the STORED
 * definition, keeping every field, hidden item and hierarchy the pivot has.
 * This used to be a frontend rebuild through update_bi_pivot_fields that
 * REPLACED the pivot's slicer fields with this pane's own, dropping a canvas
 * slicer's field and its hidden items from the same pivot. A clear never adds
 * a field: a column the pivot does not carry is a no-op on the server.
 *
 * `overwrites` notes the response for the gesture's ONE "will overwrite
 * existing data" question (`@api/pivotOverwrite`), asked by the store once
 * the gesture's undo step has committed. `reconcile` marks a re-derive that
 * is not a user gesture (see {@link RibbonFilterReconcile}): the backend
 * records nothing for it.
 */
async function filterPivotByModelColumn(
  pivotId: string,
  fieldKey: string,
  selectedItems: string[] | null,
  filterLevel: number,
  overwrites?: PivotOverwriteTally,
  reconcile = false,
): Promise<void> {
  const quiet = reconcile ? { reconcile: true } : {};
  if (selectedItems === null) {
    const request: ClearPivotFilterRequest = { pivotId, biFieldKey: fieldKey, ...quiet };
    const response = await filterPaneBackend.invoke<PivotViewResponse>("clear_pivot_filter", { request });
    surfacePivotNotices(response);
    overwrites?.note(response);
    return;
  }
  const request: ApplyPivotFilterRequest = {
    pivotId,
    biFieldKey: fieldKey,
    filters: { manualFilter: { selectedItems } },
    // Level >= 2 routes the selection INSIDE the BI query (a pinned filter
    // that measure CLEAR/RESET semantics honor).
    filterLevel,
    ...quiet,
  };
  const response = await filterPaneBackend.invoke<PivotViewResponse>("apply_pivot_filter", { request });
  surfacePivotNotices(response);
  overwrites?.note(response);
}

/**
 * The undo step a ribbon filter's pivot writes share. Every column a target
 * pivot lacks is added by its own server-side ensure, and each ensure records
 * a pivot-definition step that JOINS the open transaction -- so one filter
 * change is one pivot step, not one per missing column (three active filters
 * on a new pivot used to leave three separate "Pivot table field change"
 * steps, each undoing one column while the filter still showed its
 * selection). The selection write (`update_ribbon_filter_selection`)
 * records its own step BEFORE this opens and is deliberately not inside it:
 * that command begins and commits a transaction itself, and its commit would
 * close this one half-way.
 */
export const RIBBON_FILTER_PIVOT_STEP = "Ribbon filter change";

/**
 * A bridge call that is NOT a user gesture: the re-derive after a DECLINED
 * change was taken back (fix round 5 review). The take-back restores every
 * pivot whose step it holds -- the ones that overwrote cells -- but a pivot
 * the change masked WITHOUT overwriting recorded nothing (a level-1 mask), so
 * it still shows the declined selection. The store re-applies the restored
 * selection to those. Every pivot request of such a call carries
 * `reconcile: true`, so the backend records NOTHING for it (an overwrite
 * included -- a step recorded here would sit on top of the history the
 * decline just put back); no undo transaction is opened around it; and the
 * pivots in `skipPivotIds`, which the taken-back step already restored
 * exactly, are left alone.
 */
export interface RibbonFilterReconcile {
  skipPivotIds: readonly string[];
}

/** The pivots a call writes: its targets, less the ones a reconcile skips. */
function writtenPivots(targets: readonly string[], reconcile?: RibbonFilterReconcile): string[] {
  if (!reconcile) return [...targets];
  const skip = new Set(reconcile.skipPivotIds);
  return targets.filter((id) => !skip.has(id));
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Resolve the pivots a filter applies to, based on its connectionMode.
 * Candidates are ALWAYS limited to the BI pivots backed by the filter's
 * model connection:
 * - "manual": the user-selected subset (stale/foreign ids dropped)
 * - "bySheet": the connection's pivots on the specified sheets
 * - "workbook": all of the connection's pivots
 *
 * A listing that FAILS throws: the caller reports it (review3 finding 7).
 * Swallowed into "no pivots", the filter reached nothing and said nothing.
 */
async function resolveTargetPivots(filter: RibbonFilter): Promise<string[]> {
  const candidates = await getPivotsForBiConnection(filter.connectionId);

  const mode = filter.connectionMode ?? "manual";
  if (mode === "manual") {
    const selected = new Set(filter.connectedPivots ?? []);
    return candidates.filter((p) => selected.has(p.id)).map((p) => p.id);
  }
  if (mode === "bySheet") {
    const sheetSet = new Set(filter.connectedSheets ?? []);
    return candidates.filter((p) => sheetSet.has(p.sheetIndex)).map((p) => p.id);
  }
  return candidates.map((p) => p.id);
}

/**
 * Apply a ribbon filter's selection to all its target pivots.
 * Resolves targets dynamically based on connectionMode.
 * Also re-applies every OTHER active filter that targets the same pivots, so a
 * pivot that appeared after those filters were set picks them up too.
 *
 * The pivots that refuse are told to the user in one toast -- or, when the
 * caller passes `failures` (one gesture running several bridge calls), added
 * there for the caller's one report. `overwrites` collects what the pivot
 * writes grew over, for the gesture's one overwrite question. `reconcile`:
 * see {@link RibbonFilterReconcile}.
 */
export async function applyRibbonFilter(
  filter: RibbonFilter,
  failures?: RibbonFilterFailure[],
  overwrites?: PivotOverwriteTally,
  reconcile?: RibbonFilterReconcile,
): Promise<void> {
  const refused: RibbonFilterFailure[] = [];
  await applyRibbonFilterCollecting(filter, refused, overwrites, reconcile);
  if (failures) failures.push(...refused);
  else reportRibbonFilterFailures(refused);
}

async function applyRibbonFilterCollecting(
  filter: RibbonFilter,
  refused: RibbonFilterFailure[],
  overwrites?: PivotOverwriteTally,
  reconcile?: RibbonFilterReconcile,
): Promise<void> {
  try {
    // If all items are selected (null), there's no filter to apply.
    // Skip entirely to avoid unnecessary pivot resets and flicker.
    if (filter.selectedItems === null) return;

    const targetPivotIds = writtenPivots(await resolveTargetPivots(filter), reconcile);
    if (targetPivotIds.length === 0) return;

    // Collect ALL active filters so every one that targets a pivot is applied with this one
    const allFilters = getAllFilters();
    const activeFilters = allFilters.filter(
      (f) => f.selectedItems !== null,
    );

    // Resolve targets of the other active filters once (used per pivot below)
    const otherTargets = new Map<string, string[]>();
    for (const other of activeFilters) {
      if (other.id === filter.id) continue;
      try {
        otherTargets.set(other.id, await resolveTargetPivots(other));
      } catch (err) {
        // This filter still applies; the other one is reported and skipped.
        refused.push({ filter: other.name, pivotId: "", clearing: false, message: errorText(err) });
        otherTargets.set(other.id, []);
      }
    }

    // Show loading overlay on affected pivots; the finally guarantees the
    // overlays clear even when an apply step throws mid-way.
    for (const pivotId of targetPivotIds) {
      window.dispatchEvent(
        new CustomEvent("pivot:set-loading", {
          detail: { pivotId, stage: "Applying filter..." },
        }),
      );
    }

    try {
      // For each affected pivot, apply this filter and every other active
      // filter that targets it, without intermediate refreshes. A column the
      // pivot lacks is added by the backend inside the apply itself -- all
      // of them inside ONE undo step (see RIBBON_FILTER_PIVOT_STEP). A
      // reconcile records nothing and opens no step.
      const applyAll = async (): Promise<void> => {
        for (const pivotId of targetPivotIds) {
          const filtersForPivot: Array<{
            name: string;
            fieldName: string;
            selectedItems: string[];
            filterLevel: number;
          }> = [];

          // The current filter
          filtersForPivot.push({
            name: filter.name,
            fieldName: filter.fieldName,
            selectedItems: filter.selectedItems!,
            filterLevel: filter.filterLevel ?? 1,
          });

          // Other active filters targeting the same pivot
          for (const other of activeFilters) {
            if (other.id === filter.id) continue;
            if ((otherTargets.get(other.id) ?? []).includes(pivotId)) {
              filtersForPivot.push({
                name: other.name,
                fieldName: other.fieldName,
                selectedItems: other.selectedItems!,
                filterLevel: other.filterLevel ?? 1,
              });
            }
          }

          for (const f of filtersForPivot) {
            try {
              await filterPivotByModelColumn(
                pivotId,
                f.fieldName,
                f.selectedItems,
                f.filterLevel,
                overwrites,
                reconcile !== undefined,
              );
            } catch (err) {
              console.warn("[FilterPane] Failed to filter pivot", pivotId, "by", f.fieldName, err);
              refused.push({ filter: f.name, pivotId, clearing: false, message: errorText(err) });
            }
          }
        }
      };
      if (reconcile) await applyAll();
      else await runInUndoTransaction(RIBBON_FILTER_PIVOT_STEP, applyAll);

      // Single pivot:refresh after all filters are applied
      window.dispatchEvent(new Event("pivot:refresh"));
    } finally {
      for (const pivotId of targetPivotIds) {
        window.dispatchEvent(
          new CustomEvent("pivot:clear-loading", { detail: { pivotId } }),
        );
      }
    }

    emitAppEvent(AppEvents.GRID_REFRESH);
  } catch (err) {
    console.error("[FilterPane] Failed to apply filter:", err);
    refused.push({ filter: filter.name, pivotId: "", clearing: false, message: errorText(err) });
  }
}

/**
 * Clear a ribbon filter from all its target pivots. The pivots that refuse are
 * told in one toast, or added to the caller's `failures` (see
 * {@link applyRibbonFilter}). `reconcile`: see {@link RibbonFilterReconcile}.
 */
export async function clearRibbonFilter(
  filter: RibbonFilter,
  failures?: RibbonFilterFailure[],
  overwrites?: PivotOverwriteTally,
  reconcile?: RibbonFilterReconcile,
): Promise<void> {
  const refused: RibbonFilterFailure[] = [];
  await clearRibbonFilterCollecting(filter, refused, overwrites, reconcile);
  if (failures) failures.push(...refused);
  else reportRibbonFilterFailures(refused);
}

async function clearRibbonFilterCollecting(
  filter: RibbonFilter,
  refused: RibbonFilterFailure[],
  overwrites?: PivotOverwriteTally,
  reconcile?: RibbonFilterReconcile,
): Promise<void> {
  try {
    const targetPivotIds = writtenPivots(await resolveTargetPivots(filter), reconcile);
    if (targetPivotIds.length === 0) return;

    // Show loading overlay on affected pivots; cleared in the finally so a
    // failure mid-way can't leave a pivot stuck behind the overlay.
    for (const pivotId of targetPivotIds) {
      window.dispatchEvent(
        new CustomEvent("pivot:set-loading", {
          detail: { pivotId, stage: "Clearing filter..." },
        }),
      );
    }

    try {
      await clearModelColumnOnPivots(filter.fieldName, targetPivotIds, {
        label: filter.name,
        failures: refused,
        overwrites,
        reconcile: reconcile !== undefined,
      });
      window.dispatchEvent(new Event("pivot:refresh"));
    } finally {
      for (const pivotId of targetPivotIds) {
        window.dispatchEvent(
          new CustomEvent("pivot:clear-loading", { detail: { pivotId } }),
        );
      }
    }

    emitAppEvent(AppEvents.GRID_REFRESH);
  } catch (err) {
    console.error("[FilterPane] Failed to clear filter:", err);
    refused.push({ filter: filter.name, pivotId: "", clearing: true, message: errorText(err) });
  }
}

/**
 * Take a model column's filter off each of `pivotIds`, naming the column by
 * its "Table.Column" key: the Pivot owner resolves it, and a pivot that does
 * not carry the column is left alone (a clear never adds a field). ONE undo
 * step (a pinned clear re-queries, which records). Best effort per pivot.
 *
 * The Report Connections panel calls this for the pivots a filter was just
 * disconnected from. It used to find the pivot's field INDEX itself -- exact
 * name, else the text after the LAST dot -- and BI pivot cache names are bare,
 * so a filter on Customers.Region cleared the user's own row filter on
 * Stores.Region (the first "Region" in the cache), with no undo.
 *
 * The pivots that refuse are told in one toast naming the filter by `label`
 * (else by the key), or added to `failures` for the caller's one report.
 * `reconcile`: the clears record nothing and open no step (see
 * {@link RibbonFilterReconcile}).
 */
export async function clearModelColumnOnPivots(
  fieldKey: string,
  pivotIds: Iterable<string>,
  options: {
    label?: string;
    failures?: RibbonFilterFailure[];
    overwrites?: PivotOverwriteTally;
    reconcile?: boolean;
  } = {},
): Promise<void> {
  const ids = Array.from(pivotIds);
  if (ids.length === 0) return;
  const refused: RibbonFilterFailure[] = [];
  const clearAll = async (): Promise<void> => {
    for (const pivotId of ids) {
      try {
        await filterPivotByModelColumn(pivotId, fieldKey, null, 1, options.overwrites, options.reconcile === true);
      } catch (err) {
        console.warn("[FilterPane] Failed to clear", fieldKey, "on pivot", pivotId, err);
        refused.push({ filter: options.label ?? fieldKey, pivotId, clearing: true, message: errorText(err) });
      }
    }
  };
  if (options.reconcile) await clearAll();
  else await runInUndoTransaction(RIBBON_FILTER_PIVOT_STEP, clearAll);
  if (options.failures) options.failures.push(...refused);
  else reportRibbonFilterFailures(refused);
}
