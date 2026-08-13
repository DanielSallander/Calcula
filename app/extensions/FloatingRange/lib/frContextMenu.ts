//! FILENAME: app/extensions/FloatingRange/lib/frContextMenu.ts
// PURPOSE: Grid context-menu items for a selected floating range (Add/Delete
//          Row/Column, Rename…, Properties…, Delete).
// CONTEXT: Precedent Controls/lib/controlContextMenu.ts — registered through
//          gridExtensions, items gated on the FR object selection so they only
//          appear when one is selected. Actions are injected by index.ts (the
//          lifecycle owner) to keep this module free of backend plumbing.

import { gridExtensions } from "@api";
import type { GridContextMenuItem } from "@api/extensions";
import { getSelectedFloatingRange } from "./frSelection";

const ITEM_IDS = [
  "floatingRange.addRow",
  "floatingRange.addColumn",
  "floatingRange.deleteLastRow",
  "floatingRange.deleteLastColumn",
  "floatingRange.rename",
  "floatingRange.properties",
  "floatingRange.delete",
];

export interface FrContextMenuHandlers {
  addRow(frId: string): void;
  addColumn(frId: string): void;
  deleteLastRow(frId: string): void;
  deleteLastColumn(frId: string): void;
  rename(frId: string): void;
  properties(frId: string): void;
  deleteObject(frId: string): void;
  /** Window size lookup for the shrink-item gating (a 1-row FR cannot lose a row). */
  getCounts(frId: string): { rows: number; cols: number } | null;
}

function selectedId(): string | null {
  return getSelectedFloatingRange();
}

/**
 * Register the context menu items. Returns a cleanup that unregisters them.
 */
export function registerFrContextMenu(handlers: FrContextMenuHandlers): () => void {
  const withSelected = (fn: (frId: string) => void) => () => {
    const id = selectedId();
    if (id) fn(id);
  };

  const items: GridContextMenuItem[] = [
    {
      id: "floatingRange.addRow",
      label: "Add Row",
      group: "floatingRange",
      order: 1,
      visible: () => selectedId() !== null,
      onClick: withSelected(handlers.addRow),
    },
    {
      id: "floatingRange.addColumn",
      label: "Add Column",
      group: "floatingRange",
      order: 2,
      visible: () => selectedId() !== null,
      onClick: withSelected(handlers.addColumn),
    },
    {
      id: "floatingRange.deleteLastRow",
      label: "Delete Last Row",
      group: "floatingRange",
      order: 3,
      visible: () => {
        const id = selectedId();
        if (!id) return false;
        return (handlers.getCounts(id)?.rows ?? 1) > 1;
      },
      onClick: withSelected(handlers.deleteLastRow),
    },
    {
      id: "floatingRange.deleteLastColumn",
      label: "Delete Last Column",
      group: "floatingRange",
      order: 4,
      visible: () => {
        const id = selectedId();
        if (!id) return false;
        return (handlers.getCounts(id)?.cols ?? 1) > 1;
      },
      separatorAfter: true,
      onClick: withSelected(handlers.deleteLastColumn),
    },
    {
      id: "floatingRange.rename",
      label: "Rename…",
      group: "floatingRange",
      order: 10,
      visible: () => selectedId() !== null,
      onClick: withSelected(handlers.rename),
    },
    {
      id: "floatingRange.properties",
      label: "Properties…",
      group: "floatingRange",
      order: 11,
      visible: () => selectedId() !== null,
      separatorAfter: true,
      onClick: withSelected(handlers.properties),
    },
    {
      id: "floatingRange.delete",
      label: "Delete",
      shortcut: "Del",
      group: "floatingRange",
      order: 20,
      visible: () => selectedId() !== null,
      onClick: withSelected(handlers.deleteObject),
    },
  ];

  gridExtensions.registerContextMenuItems(items);

  return () => {
    for (const id of ITEM_IDS) {
      gridExtensions.unregisterContextMenuItem(id);
    }
  };
}
