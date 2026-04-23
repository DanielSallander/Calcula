//! FILENAME: app/extensions/DefinedNames/handlers/formulasMenuItemBuilder.ts
// PURPOSE: Register "Define Name" and "Name Manager" menu items in the Formulas menu.
// CONTEXT: Adds menu items that open the define name / name manager dialogs.

import type { ExtensionContext } from "@api/contract";
import {
  showDialog,
  IconNameManager,
  IconDefineName,
  IconDefineFunction,
  getAllNamedRanges,
  applyNamesToFormulas,
  updateCellsBatch,
  emitAppEvent,
  AppEvents,
} from "@api";
import { getGridStateSnapshot } from "@api/grid";

/**
 * Register defined names menu items in the Formulas menu.
 * Returns a cleanup function.
 */
export function registerDefinedNamesMenuItems(context: ExtensionContext): () => void {
  const cleanups: (() => void)[] = [];

  cleanups.push(
    context.ui.menus.registerItem("formulas", {
      id: "formulas:separator-names",
      label: "",
      separator: true,
    })
  );

  cleanups.push(
    context.ui.menus.registerItem("formulas", {
      id: "formulas:nameManager",
      label: "Name Manager",
      icon: IconNameManager,
      action: () => {
        showDialog("name-manager");
      },
      children: [
        {
          id: "formulas:defineName",
          label: "Define Name...",
          icon: IconDefineName,
          action: () => {
            showDialog("define-name", { mode: "new" });
          },
        },
        {
          id: "formulas:defineFunction",
          label: "Define Function...",
          icon: IconDefineFunction,
          action: () => {
            showDialog("define-function", { mode: "new" });
          },
        },
      ],
    })
  );

  // "Paste Names" menu item - pastes a list of all defined names into the sheet
  cleanups.push(
    context.ui.menus.registerItem("formulas", {
      id: "formulas:pasteNames",
      label: "Paste Names...",
      action: async () => {
        try {
          const namedRanges = await getAllNamedRanges();
          if (namedRanges.length === 0) {
            console.warn("[DefinedNames] No named ranges to paste.");
            return;
          }

          const gridState = getGridStateSnapshot();
          if (!gridState) return;

          const startRow = gridState.selection.startRow;
          const startCol = gridState.selection.startCol;

          const updates = namedRanges.map((nr, i) => [
            { row: startRow + i, col: startCol, value: nr.name },
            { row: startRow + i, col: startCol + 1, value: nr.refersTo },
          ]).flat();

          await updateCellsBatch(updates);
          emitAppEvent(AppEvents.GRID_REFRESH);
        } catch (err) {
          console.error("[DefinedNames] Failed to paste names:", err);
        }
      },
    })
  );

  // "Apply Names..." menu item - replaces cell references in formulas with named range names
  cleanups.push(
    context.ui.menus.registerItem("formulas", {
      id: "formulas:applyNames",
      label: "Apply Names...",
      action: async () => {
        try {
          const namedRanges = await getAllNamedRanges();
          if (namedRanges.length === 0) {
            console.warn("[DefinedNames] No named ranges to apply.");
            return;
          }

          const result = await applyNamesToFormulas([]);
          if (result.formulasModified > 0) {
            emitAppEvent(AppEvents.GRID_REFRESH);
            console.log(
              `[DefinedNames] Applied names to ${result.formulasModified} formula(s).`
            );
          } else {
            console.log("[DefinedNames] No formulas were modified.");
          }
        } catch (err) {
          console.error("[DefinedNames] Failed to apply names:", err);
        }
      },
    })
  );

  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Ignore cleanup errors
      }
    }
  };
}
