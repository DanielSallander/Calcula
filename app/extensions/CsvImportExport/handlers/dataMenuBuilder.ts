//! FILENAME: app/extensions/CsvImportExport/handlers/dataMenuBuilder.ts
// PURPOSE: Registers "Get Data" menu items in the Data menu for CSV import/export.
// CONTEXT: Appends items to the existing "data" menu created by AutoFilter.

import { registerMenuItem, DialogExtensions } from "../../../src/api";

// ============================================================================
// Menu Registration
// ============================================================================

export function registerCsvMenuItems(): void {
  // Separator before the Get Data section
  registerMenuItem("data", {
    id: "data:csv:separator",
    label: "",
    separator: true,
  });

  registerMenuItem("data", {
    id: "data:getData",
    label: "Get Data",
    children: [
      {
        id: "data:getData:csv",
        label: "From CSV...",
        action: () => {
          DialogExtensions.openDialog("csv-import", {});
        },
      },
    ],
  });

  registerMenuItem("data", {
    id: "data:csv:export",
    label: "Export to CSV...",
    action: () => {
      DialogExtensions.openDialog("csv-export", {});
    },
  });
}
