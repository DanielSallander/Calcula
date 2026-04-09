//! FILENAME: app/extensions/Subtotals/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Subtotals menu item in the Data > Outline submenu.
// CONTEXT: Uses registerMenuItem to add to the "Outline" submenu in the "data" menu.

import {
  registerMenuItem,
  DialogExtensions,
  IconOutline,
  IconSubtotals,
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
  // Register under "Outline" submenu (merged with Grouping's Outline)
  registerMenuItem("data", {
    id: "data:outline",
    label: "Outline",
    icon: IconOutline,
    children: [
      {
        id: "data:outline:subtotals",
        label: "Subtotals...",
        icon: IconSubtotals,
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
      },
    ],
  });
}
