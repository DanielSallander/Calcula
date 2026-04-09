//! FILENAME: app/extensions/CsvImportExport/handlers/dataMenuBuilder.ts
// PURPOSE: Registers "Get Data" menu items in the External Data menu for CSV import/export.
// CONTEXT: Appends items to the "externalData" menu created by ExternalData extension.

import { registerMenuItem, DialogExtensions } from "@api";

// ============================================================================
// Menu Registration
// ============================================================================

export function registerCsvMenuItems(): void {
  registerMenuItem("externalData", {
    id: "externalData:getData",
    label: "Get Data",
    children: [
      {
        id: "externalData:getData:csv",
        label: "From CSV...",
        action: () => {
          DialogExtensions.openDialog("csv-import", {});
        },
      },
    ],
  });

  registerMenuItem("externalData", {
    id: "externalData:csv:export",
    label: "Export to CSV...",
    action: () => {
      DialogExtensions.openDialog("csv-export", {});
    },
  });
}
