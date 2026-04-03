//! FILENAME: app/extensions/Subtotals/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Subtotals menu item in the Data menu.
// CONTEXT: Uses registerMenuItem to add to the existing "data" menu.

import {
  registerMenuItem,
  DialogExtensions,
} from "@api";

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

export function registerSubtotalsMenuItem(): void {
  // Add separator before subtotals
  registerMenuItem("data", {
    id: "data:subtotals:separator",
    label: "",
    separator: true,
  });

  registerMenuItem("data", {
    id: "data:subtotals",
    label: "Subtotals...",
    action: () => {
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
  });
}
