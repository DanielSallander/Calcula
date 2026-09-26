//! FILENAME: app/extensions/Pivot/lib/pivotCellDoubleClick.ts
// PURPOSE: What a DOUBLE-CLICK on a pivot cell does: an expandable row header
//          toggles; a data or total cell drills through (to the pivot's script
//          when a mounted script handles it, otherwise into a new sheet).
// CONTEXT: A worksheet pivot hears the double-click through the cell
//          double-click interceptor; a canvas pivot box through its overlay's
//          `onDoubleClick` (Core offers a double-click over a floating object to
//          nothing else). Both resolve the view cell and the hidden-grid cell
//          and then call this, so the drill behaviour has one implementation.

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
  // If this cell is an expandable row header, toggle it
  if (cell.cellType === "RowHeader" && cell.isExpandable) {
    try {
      togglePivotGroup({
        pivotId,
        isRow: true,
        fieldIndex: cell.indentLevel || viewCol,
        value: cell.formattedValue,
      }).catch((error) => {
        console.error("[Pivot Extension] Failed to toggle hierarchy on double-click:", error);
      });
      window.dispatchEvent(new CustomEvent("pivot:refresh"));
    } catch (error) {
      console.error("[Pivot Extension] Failed to toggle hierarchy on double-click:", error);
    }
    return true;
  }

  if (cell.cellType === "Data" || isTotalCell(cell.cellType)) {
    // Data / total cell: drill through. A "script"-mode pivot dispatches
    // the onDrillThrough hook to its sandboxed script (which produces the
    // drill via its consented capabilities); otherwise the host runs the
    // built-in / query secured drill into a new sheet.
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
    return true;
  }

  return false;
}
