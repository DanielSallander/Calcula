//! FILENAME: app/extensions/Pivot/lib/pivotCellDoubleClick.ts
// PURPOSE: What a DOUBLE-CLICK on a pivot cell does: an expandable row header
//          toggles; a data or total cell drills through (to the pivot's script
//          when a mounted script handles it, otherwise into a new sheet).
// CONTEXT: A worksheet pivot hears the double-click through the cell
//          double-click interceptor; a canvas pivot box through its overlay's
//          `onDoubleClick` (Core offers a double-click over a floating object to
//          nothing else). Both resolve the view cell and the hidden-grid cell
//          and then call this, so the drill behaviour has one implementation.
//          The drill half is its own export, `runPivotDrillThrough`, so the
//          value-cell menu's "Show Details" runs the very same drill.

import { AppEvents, showToast } from "@api";
import { emitAppEvent } from "@api/events";
import { setActiveSheet } from "@api/lib";
import type { PivotCellData } from "./pivot-api";
import {
  togglePivotGroup,
  getPivotDataFormula,
  drillThroughToSheet,
  isTotalCell,
  getPivotDrillBehavior,
} from "./pivot-api";
import { pivotCellLabel } from "./pivotChromeActions";
import { decideDrillDispatch, diagnoseScriptDrill } from "./drillDispatch";

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
 * as the fallback name (`pivotCellLabel`: `formattedValue` is empty for text
 * labels and unformatted numbers, and an empty name toggles nothing). A
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
        value: pivotCellLabel(cell),
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
 * to hidden-grid cell (gridRow, gridCol). A "script"-mode pivot dispatches the
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
): void {
  const groupPath = (cell.groupPath ?? []) as Array<[number, number]>;
  void (async () => {
    try {
      const behavior = await getPivotDrillBehavior(pivotId);
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
      // also covers a failed getPivotDrillBehavior.
      console.error("[Pivot Extension] Drill-through failed:", error);
      showToast(String(error), { type: "error" });
    }
  })();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
