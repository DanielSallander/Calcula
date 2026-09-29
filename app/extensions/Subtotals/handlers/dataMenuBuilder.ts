//! FILENAME: app/extensions/Subtotals/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Subtotals menu item in the Data > Outline submenu.
// CONTEXT: Uses registerMenuItem to add to the "Outline" submenu in the "data" menu.

import {
  registerMenuItem,
  unregisterMenuItem,
  DialogExtensions,
  IconOutline,
  IconSubtotals,
} from "@api";
import { refuseIfSelectionOwned } from "@api/selectionOwner";

/** Current selection state, updated by the extension's selection listener. */
let currentSelection: {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
} | null = null;

export function setCurrentSelection(
  sel: { startRow: number; endRow: number; startCol: number; endCol: number } | null,
): void {
  currentSelection = sel;
}

const SUBTOTALS_MENU_ITEM_ID = "data:outline:subtotals";

/**
 * Register "Subtotals..." under Data > Outline. Returns the cleanup for
 * deactivation, which takes back this extension's own CHILD -- never
 * "data:outline", which Grouping builds and shares (X18).
 */
export function registerSubtotalsMenuItem(): () => void {
  // Register under "Outline" submenu (merged with Grouping's Outline)
  registerMenuItem("data", {
    id: "data:outline",
    label: "Outline",
    icon: IconOutline,
    children: [
      {
        id: SUBTOTALS_MENU_ITEM_ID,
        label: "Subtotals...",
        icon: IconSubtotals,
        action: () => {
          // The dialog subtotals Core's selection -- HIDDEN while something
          // else owns the selection (a floating grid's selected cell) -- so
          // refuse, once (D4, BUG-0185 class).
          if (refuseIfSelectionOwned("Subtotals")) return;
          const context = currentSelection
            ? {
                startRow: currentSelection.startRow,
                endRow: currentSelection.endRow,
                startCol: currentSelection.startCol,
                endCol: currentSelection.endCol,
              }
            : {
                startRow: 0,
                endRow: 10,
                startCol: 0,
                endCol: 5,
              };
          DialogExtensions.openDialog("subtotals", context);
        },
      },
    ],
  });
  return () => unregisterMenuItem("data", SUBTOTALS_MENU_ITEM_ID);
}
