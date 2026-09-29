//! FILENAME: app/extensions/DefinedNames/handlers/formulasMenuItemBuilder.ts
// PURPOSE: Register "Define Name" and "Name Manager" menu items in the Formulas menu.
// CONTEXT: Adds menu items that open the define name / name manager dialogs.

import type { ExtensionContext } from "@api/contract";
import {
  showDialog,
  IconNameManager,
  IconDefineName,
  IconDefineFunction,
  IconPasteNames,
  IconApplyNames,
  getAllNamedRanges,
  applyNamesToFormulas,
  updateCellsBatch,
  emitAppEvent,
  AppEvents,
} from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { refuseIfSelectionOwned } from "@api/selectionOwner";

/**
 * Register defined names menu items in the Formulas menu.
 * Returns a cleanup function.
 */
export function registerDefinedNamesMenuItems(context: ExtensionContext): () => void {
  const cleanups: (() => void)[] = [];
  // Every item registered below is taken back by the returned cleanup (the D3
  // class, found in wave C beside W20/W21: the list was empty, so all four
  // Formulas items outlived the extension).
  for (const itemId of [
    "formulas:separator-names",
    "formulas:nameManager",
    "formulas:pasteNames",
    "formulas:applyNames",
  ]) {
    cleanups.push(() => context.ui.menus.unregisterItem("formulas", itemId));
  }

  context.ui.menus.registerItem("formulas", {
    id: "formulas:separator-names",
    label: "",
    separator: true,
  });

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
          // The new name's Refers To is prefilled from Core's selection --
          // HIDDEN while something else owns the selection (a floating grid's
          // selected cell) -- so refuse, once (D4, BUG-0185 class).
          if (refuseIfSelectionOwned("Define Name")) return;
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
  });

  // "Paste Names" menu item - pastes a list of all defined names into the sheet
  context.ui.menus.registerItem("formulas", {
    id: "formulas:pasteNames",
    label: "Paste Names...",
    icon: IconPasteNames,
    action: async () => {
      // Pastes the list at Core's active cell -- HIDDEN while something else
      // owns the selection (a floating grid's selected cell) -- so refuse,
      // once (D4, BUG-0185 class).
      if (refuseIfSelectionOwned("Paste Names")) return;
      try {
        const namedRanges = await getAllNamedRanges();
        if (namedRanges.length === 0) {
          console.warn("[DefinedNames] No named ranges to paste.");
          return;
        }

        const gridState = getGridStateSnapshot();
        if (!gridState || !gridState.selection) return;

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
  });

  // "Apply Names..." menu item - replaces cell references in formulas with named range names
  context.ui.menus.registerItem("formulas", {
    id: "formulas:applyNames",
    label: "Apply Names...",
    icon: IconApplyNames,
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
  });

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
