//! FILENAME: app/extensions/Pivot/lib/pivotCellDoubleClick.ts
// PURPOSE: What a DOUBLE-CLICK on a pivot cell does: an expandable row header
//          toggles; a data or total cell drills through (to the pivot's
//          DESIGN-QUERY drill when its behaviour carries one, to the pivot's
//          script when a mounted script handles it, otherwise into a new sheet).
// CONTEXT: A worksheet pivot hears the double-click through the cell
//          double-click interceptor; a canvas pivot box through its overlay's
//          `onDoubleClick` (Core offers a double-click over a floating object to
//          nothing else). Both resolve the view cell and the hidden-grid cell
//          and then call this, so the drill behaviour has one implementation.
//          The drill half is its own export, `runPivotDrillThrough`, so the
//          value-cell menu's "Show Details" / "Drill through" runs the very
//          same drill.
//
//          THE DESIGN-QUERY DRILL (docs/design/model-drillthrough.md 2.3, 2.9).
//          A present `behavior.designQuery` WINS over `kind` and is tested
//          BEFORE the script branch. The clicked cell's identity is its
//          `groupPath` of (field index, value id) pairs, which only the backend
//          can turn into member KEYS: the `drill_through { op: "pivotContext" }`
//          op resolves it (blank member -> key "", a coordinate that cannot be
//          resolved FAILS the op) and answers the pivot's connection, the
//          CLICKED PATH (`filters`) and the pivot's own STANDING filters
//          (`standing`) apart, as keys, with notices for what it could not
//          carry. They are passed apart because the runner treats them apart:
//          a chart presentation leaves out a standing copy of a workbook-wide
//          filter that re-applies live, never the clicked path (spec 2.4).
//          `pivotCellItemKey` (the measure VALUE on a data cell) and
//          `getPivotDataFormula` (spells the blank "(blank)") are NOT used.
//          The shared runner then bakes the keys into the definition's DSL,
//          lands the result on an ephemeral sheet and tells the notices ONCE,
//          after the sheet landed; it toasts its own failures.

import { AppEvents, showToast, type DrillThroughPivotContextResponse } from "@api";
import { pivotCellItemKey } from "@api/pivotMembers";
import { emitAppEvent } from "@api/events";
import { setActiveSheet } from "@api/lib";
import { getGridStateSnapshot } from "@api/grid";
import type { DrillThroughDefinition } from "@api";
import { runDrillThrough } from "../../_shared/drillThrough/runDrillThrough";
import { getCachedRegions } from "../handlers/selectionHandler";
import { pivotBackend } from "./pivotBackend";
import type { PivotCellData } from "./pivot-api";
import {
  togglePivotGroup,
  getPivotDataFormula,
  drillThroughToSheet,
  isTotalCell,
  getPivotDrillBehavior,
} from "./pivot-api";
import { decideDrillDispatch, diagnoseScriptDrill } from "./drillDispatch";

/**
 * What a caller knows about the pivot's place that the drill cannot read
 * back later: both doors act on the ACTIVE sheet, so each defaults from the
 * grid snapshot (the sheet) and the cached regions (the name) at CALL time --
 * before any await, because the design-query runner switches sheets.
 */
export interface PivotDrillOptions {
  /** The pivot's TRUE sheet index (the page its filters are resolved on). */
  sheetIndex?: number;
  /** The pivot's name as a person knows it (the sheet-name and title fallbacks). */
  name?: string;
}

/**
 * Act on a double-click on `cell`, the view cell at hidden-grid cell
 * (gridRow, gridCol) and view column `viewCol`. Returns true when the cell
 * meant something (toggle or drill); false for any other cell.
 */
export function runPivotCellDoubleClick(
  pivotId: string,
  cell: PivotCellData,
  gridRow: number,
  gridCol: number,
  viewCol: number,
): boolean {
  if (cell.cellType === "RowHeader" && cell.isExpandable) {
    togglePivotRowHeader(pivotId, cell, viewCol);
    return true;
  }

  if (cell.cellType === "Data" || isTotalCell(cell.cellType)) {
    runPivotDrillThrough(pivotId, cell, gridRow, gridCol);
    return true;
  }

  return false;
}

/**
 * Toggle an expandable row header. The toggle names the header by its GROUP
 * PATH, the one identity the backend matches exactly (two "Female" headers
 * under two different cities are two different groups), with the shown label
 * as the fallback name (`pivotCellItemKey`: the member KEY, else the value as
 * invariant text -- never "" for an unformatted number, BUG-0454, and never a
 * localised label). A
 * failure is TOLD (BUG-0096): a double-click is never a silent no-op.
 */
function togglePivotRowHeader(pivotId: string, cell: PivotCellData, viewCol: number): void {
  const groupPath = cell.groupPath && cell.groupPath.length > 0 ? cell.groupPath : undefined;
  void (async () => {
    try {
      await togglePivotGroup({
        pivotId,
        isRow: true,
        fieldIndex: cell.indentLevel || viewCol,
        value: pivotCellItemKey(cell),
        groupPath,
      });
      window.dispatchEvent(new CustomEvent("pivot:refresh"));
    } catch (error) {
      console.error("[Pivot Extension] Failed to toggle hierarchy on double-click:", error);
      showToast(`Expand/Collapse failed: ${errorText(error)}`, { variant: "error" });
    }
  })();
}

/**
 * Drill through the data / total `cell` of `pivotId`, the view cell written
 * to hidden-grid cell (gridRow, gridCol). A behaviour with a `designQuery`
 * runs the design-query drill (the clicked members as KEY filters on the
 * stored DSL, onto an ephemeral sheet); a "script"-mode pivot dispatches the
 * onDrillThrough hook to its sandboxed script (which produces the drill via
 * its consented capabilities); otherwise the host runs the built-in / query
 * secured drill into a new sheet, which becomes the active sheet. Runs in the
 * background and returns at once; every failure is a toast.
 */
export function runPivotDrillThrough(
  pivotId: string,
  cell: PivotCellData,
  gridRow: number,
  gridCol: number,
  options: PivotDrillOptions = {},
): void {
  const groupPath = (cell.groupPath ?? []) as Array<[number, number]>;
  // Read NOW, synchronously: the design-query runner moves the active sheet.
  const sheetIndex = options.sheetIndex ?? getGridStateSnapshot()?.sheetContext?.activeSheetIndex ?? 0;
  const name = options.name ?? getCachedRegions().find((r) => r.pivotId === pivotId)?.name ?? "PivotTable";
  void (async () => {
    try {
      const behavior = await getPivotDrillBehavior(pivotId);
      // A design-query definition WINS over `kind` (model-drillthrough.md
      // 2.1): it is tested first, before the script branch.
      if (behavior?.designQuery) {
        await runDesignQueryDrill(pivotId, groupPath, behavior.designQuery, { sheetIndex, name });
        return;
      }
      // Dispatch to the pivot's script only when a MOUNTED script has
      // actually REGISTERED a drill handler. "Does this pivot have a
      // script" answers the wrong question: the handler side is opt-in
      // (the forwarder exists only once the script calls
      // `pivot.onDrillThrough`), so a script that hooks only, say,
      // `onRefresh` left the emitted event with no subscriber — and
      // because this branch had already returned, the user got no
      // drill, no fallback and no message at all (BUG-0096). Every
      // other case falls through to the built-in drill below, which is
      // what makes "a double-click is never a silent no-op" true rather
      // than merely intended.
      if (behavior?.kind === "script") {
        // Dynamic, matching the ObjectScriptManager use in Controls:
        // the script host pulls in the worker bootstrap, and Pivot
        // activates long before any script does.
        const { ObjectScriptManager, mountedScriptHasHook } = await import("@api");
        const script = ObjectScriptManager.getScript("pivot", pivotId);
        const mounted = script ? ObjectScriptManager.isScriptMounted(script.id) : false;
        const facts = {
          kind: behavior.kind,
          script: script ? { id: script.id, name: script.name } : null,
          mounted,
          handlesDrill:
            script && mounted
              ? mountedScriptHasHook(script.id, "pivot.onDrillThrough")
              : false,
        };

        if (decideDrillDispatch(facts) === "script") {
          // Resolve the drilled cell to (table, column, value) pairs and
          // dispatch the hook; the pivot's script handles the rest.
          // `getPivotDataFormula` stays INSIDE this branch: it is an
          // extra IPC round trip that only the script path needs.
          const resolved = await getPivotDataFormula(gridRow, gridCol);
          const drillCell = (resolved?.fieldItemPairs ?? []).map(([fn, value]) => {
            const dot = fn.lastIndexOf(".");
            return dot >= 0
              ? { table: fn.slice(0, dot), column: fn.slice(dot + 1), value }
              : { table: "", column: fn, value };
          });
          emitAppEvent("pivot:drillThrough", { pivotId, cell: drillCell });
          return;
        }

        const diagnosis = diagnoseScriptDrill(facts);
        if (diagnosis) showToast(diagnosis.message, { type: diagnosis.variant });
      }
      const resp = await drillThroughToSheet({ pivotId, groupPath });
      try {
        await setActiveSheet(resp.sheetIndex);
      } catch {
        /* the SHEET_CHANGED emit below still re-syncs the tab bar */
      }
      emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: resp.sheetIndex });
    } catch (error) {
      // MUST be visible. The backend now REFUSES a drill whose
      // dimension column the active "view as" role denies, instead
      // of silently retrying without it — so without this toast a
      // denied double-click would do nothing at all, with the
      // reason only in devtools. That is verbatim the BUG-0096
      // failure mode ("no drill, no fallback and no message") the
      // comment above this handler exists to prevent. The same line
      // also covers a failed getPivotDrillBehavior and a failed
      // pivotContext op (a non-model pivot, an unresolvable coordinate):
      // such a drill is told and runs nothing else -- never the
      // built-in drill on another datum's member.
      console.error("[Pivot Extension] Drill-through failed:", error);
      showToast(String(error), { type: "error" });
    }
  })();
}

/**
 * The design-query drill: the backend resolves the cell's path to member
 * KEYS (`pivotContext`), and the shared runner takes the pivot as the source
 * (its connection comes from the answer, never from the definition, spec 2.2)
 * over this extension's own bound channel. The answer's clicked path and the
 * pivot's standing filters go to the runner APART, exactly as answered --
 * never re-split by `groupPath.length`, because a measure-only pivot's
 * synthetic "Total" row contributes no path spec. The notices are NOT told
 * here: the runner tells them once, only after the sheet has landed, so a
 * drill that fails shows its failure alone. The runner toasts every failure
 * of its own and resolves to an outcome, so a `{ ok: false }` answer is not
 * toasted a second time here.
 */
async function runDesignQueryDrill(
  pivotId: string,
  groupPath: Array<[number, number]>,
  definition: DrillThroughDefinition,
  source: { sheetIndex: number; name: string },
): Promise<void> {
  const context = await pivotBackend.invoke<DrillThroughPivotContextResponse>("drill_through", {
    request: { op: "pivotContext", pivotId, groupPath },
  });
  await runDrillThrough(
    {
      kind: "pivot",
      id: pivotId,
      sheetIndex: source.sheetIndex,
      connectionId: String(context.connectionId ?? ""),
      name: source.name,
    },
    definition,
    {
      filters: context.filters,
      standing: context.standing,
      notices: context.notices.map((n) => n.message),
    },
    { invoke: pivotBackend.invoke },
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
