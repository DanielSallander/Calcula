//! FILENAME: app/extensions/Sorting/handlers/dataMenuBuilder.ts
// PURPOSE: Registers sort-related items in the Data menu.
// CONTEXT: Each item names its COMMAND (sort.ascending / sort.descending /
//          sort.customDialog, lib/sortCommands.ts) -- the same ids the Home
//          tab's Sort & Filter menu runs -- so the two surfaces cannot sort
//          differently. The items used to call a private quickSort that ignored
//          the selection and always assumed a header row.

import type { ExtensionContext } from "@api/contract";
import { IconSortAZ, IconSortZA, IconCustomSort } from "@api";
import { ExtensionCommands } from "@api/commands";

// ============================================================================
// Menu Registration
// ============================================================================

/**
 * Register sort items in the Data menu.
 * Assumes the "data" menu was already created by AutoFilter.
 *
 * Returns the cleanup for deactivation: it takes back this extension's OWN
 * items, never the shared Data menu (wave E, Y14).
 */
export function registerSortMenuItems(context: ExtensionContext): () => void {
  // Separator before sort items
  context.ui.menus.registerItem("data", {
    id: "data:sort:separator",
    label: "",
    separator: true,
  });

  // Sort A to Z (quick ascending)
  context.ui.menus.registerItem("data", {
    id: "data:sort:ascending",
    label: "Sort A to Z",
    icon: IconSortAZ,
    commandId: ExtensionCommands.SORT_ASCENDING,
  });

  // Sort Z to A (quick descending)
  context.ui.menus.registerItem("data", {
    id: "data:sort:descending",
    label: "Sort Z to A",
    icon: IconSortZA,
    commandId: ExtensionCommands.SORT_DESCENDING,
  });

  // Custom Sort (opens the dialog on the block the quick sort would use)
  context.ui.menus.registerItem("data", {
    id: "data:sort:custom",
    label: "Custom Sort...",
    icon: IconCustomSort,
    commandId: ExtensionCommands.SORT_CUSTOM,
  });

  return () => {
    for (const id of ["data:sort:separator", "data:sort:ascending", "data:sort:descending", "data:sort:custom"]) {
      context.ui.menus.unregisterItem("data", id);
    }
  };
}
