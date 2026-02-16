//! FILENAME: app/extensions/Table/handlers/tableMenuBuilder.ts
// PURPOSE: Builds the contextual "Table" menu definition.
// CONTEXT: Called by the selection handler to register/update the Table menu
//          whenever the table context changes.

import type { MenuDefinition } from "../../../src/api/ui";
import { registerMenu } from "../../../src/api/ui";
import {
  updateTableOptions,
  deleteTable,
  type TableDefinition,
  type TableOptions,
} from "../lib/tableStore";
import { emitAppEvent } from "../../../src/api/events";
import { TableEvents } from "../lib/tableEvents";

const TABLE_MENU_ID = "table";
const TABLE_MENU_ORDER = 45; // After Insert (40)

/**
 * Build the contextual Table menu definition.
 *
 * @param table - The currently active table (null if no table context)
 * @param hidden - Whether the menu should be hidden
 */
export function buildTableMenu(
  table: TableDefinition | null,
  hidden: boolean,
): MenuDefinition {
  const opts = table?.options;

  const toggleOption = (key: keyof TableOptions) => {
    if (!table || !opts) return;
    const newValue = !opts[key];
    updateTableOptions(table.tableId, { [key]: newValue });
    // Re-register menu with updated toggle state
    const updatedOpts = { ...opts, [key]: newValue };
    const updatedTable: TableDefinition = { ...table, options: updatedOpts };
    registerMenu(buildTableMenu(updatedTable, false));
    emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
  };

  return {
    id: TABLE_MENU_ID,
    label: "Table",
    order: TABLE_MENU_ORDER,
    hidden,
    items: [
      {
        id: "table.resize",
        label: "Resize Table...",
        action: () => {
          // Future: open resize dialog
        },
        disabled: !table,
      },
      { id: "table.sep1", label: "", separator: true },
      {
        id: "table.headerRow",
        label: "Header Row",
        checked: opts?.headerRow ?? false,
        action: () => toggleOption("headerRow"),
      },
      {
        id: "table.totalRow",
        label: "Total Row",
        checked: opts?.totalRow ?? false,
        action: () => toggleOption("totalRow"),
      },
      {
        id: "table.bandedRows",
        label: "Banded Rows",
        checked: opts?.bandedRows ?? false,
        action: () => toggleOption("bandedRows"),
      },
      {
        id: "table.bandedColumns",
        label: "Banded Columns",
        checked: opts?.bandedColumns ?? false,
        action: () => toggleOption("bandedColumns"),
      },
      {
        id: "table.firstColumn",
        label: "First Column",
        checked: opts?.firstColumn ?? false,
        action: () => toggleOption("firstColumn"),
      },
      {
        id: "table.lastColumn",
        label: "Last Column",
        checked: opts?.lastColumn ?? false,
        action: () => toggleOption("lastColumn"),
      },
      { id: "table.sep2", label: "", separator: true },
      {
        id: "table.convertToRange",
        label: "Convert to Range",
        action: () => {
          if (table) {
            deleteTable(table.tableId);
            registerMenu(buildTableMenu(null, true));
            emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
          }
        },
        disabled: !table,
      },
      { id: "table.sep3", label: "", separator: true },
      {
        id: "table.delete",
        label: "Delete Table",
        action: () => {
          if (table) {
            deleteTable(table.tableId);
            registerMenu(buildTableMenu(null, true));
            emitAppEvent(TableEvents.TABLE_DEFINITIONS_UPDATED);
          }
        },
        disabled: !table,
      },
    ],
  };
}
