//! FILENAME: app/extensions/CsvImportExport/handlers/dataMenuBuilder.ts
// PURPOSE: Registers "Get Data" menu items in the External Data menu for CSV import/export.
// CONTEXT: Appends items to the "externalData" menu created by ExternalData extension.

import {
  registerMenuItem,
  unregisterMenuItem,
  DialogExtensions,
  IconGetData,
  IconFromCsv,
  IconExport,
} from "@api";

// ============================================================================
// Menu Registration
// ============================================================================

/**
 * Returns the cleanup for deactivation. It takes back CSV's OWN items: the
 * "From CSV..." CHILD, never the "Get Data" parent -- a source submenu other
 * extensions can add their own "From ..." to; it goes with its last child
 * (wave E, Y14) -- and "Export to CSV...".
 */
export function registerCsvMenuItems(): () => void {
  registerMenuItem("externalData", {
    id: "externalData:getData",
    label: "Get Data",
    icon: IconGetData,
    children: [
      {
        id: "externalData:getData:csv",
        label: "From CSV...",
        icon: IconFromCsv,
        action: () => {
          DialogExtensions.openDialog("csv-import", {});
        },
      },
    ],
  });

  registerMenuItem("externalData", {
    id: "externalData:csv:export",
    label: "Export to CSV...",
    icon: IconExport,
    action: () => {
      DialogExtensions.openDialog("csv-export", {});
    },
  });

  return () => {
    unregisterMenuItem("externalData", "externalData:getData:csv");
    unregisterMenuItem("externalData", "externalData:csv:export");
  };
}
