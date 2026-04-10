//! FILENAME: app/extensions/BuiltIn/CollectionPreview/index.ts
// PURPOSE: Extension that shows a sidebar preview panel when selecting a List or Dict cell.
// CONTEXT: Part of the 3D cells feature. Listens to selection changes and auto-opens
//          a task pane showing the structured contents of collection cells.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerTaskPane,
  unregisterTaskPane,
  openTaskPane,
  closeTaskPane,
  addTaskPaneContextKey,
  removeTaskPaneContextKey,
  registerMenuItem,
  notifyMenusChanged,
} from "@api/ui";
import { ExtensionRegistry, IconOtherOptions } from "@api";
import { getCellCollection } from "@api/lib";
import { CollectionPreviewPanel } from "./components/CollectionPreviewPanel";

const PANE_ID = "collection-preview";
let isActivated = false;
const cleanupFns: (() => void)[] = [];

// Auto-show preference: stored in-memory (resets on restart)
let autoShowEnabled = true;

export function isAutoShowEnabled(): boolean {
  return autoShowEnabled;
}

function activate(context: ExtensionContext): void {
  if (isActivated) return;
  console.log("[CollectionPreview] Activating...");

  // Register the task pane
  registerTaskPane({
    id: PANE_ID,
    title: "Collection Preview",
    component: CollectionPreviewPanel,
    contextKeys: ["collection"],
    priority: 15,
    closable: true,
  });
  cleanupFns.push(() => unregisterTaskPane(PANE_ID));

  // Listen for selection changes to detect List/Dict cells
  const unsubSelection = ExtensionRegistry.onSelectionChange(async (selection) => {
    if (!selection) {
      removeTaskPaneContextKey("collection");
      closeTaskPane(PANE_ID);
      return;
    }

    const row = selection.endRow;
    const col = selection.endCol;
    try {
      const result = await getCellCollection(row, col);
      if (result.cellType === "list" || result.cellType === "dict") {
        addTaskPaneContextKey("collection");
        if (autoShowEnabled) {
          openTaskPane(PANE_ID, { row, col });
        }
      } else {
        removeTaskPaneContextKey("collection");
        closeTaskPane(PANE_ID);
      }
    } catch {
      removeTaskPaneContextKey("collection");
      closeTaskPane(PANE_ID);
    }
  });
  cleanupFns.push(unsubSelection);

  // Register the "Other Options" submenu under View with auto-show toggle
  const menuItem: import("../../../src/api/uiTypes").MenuItemDefinition = {
    id: "view.otherOptions",
    label: "Other Options",
    icon: IconOtherOptions,
    children: [
      {
        id: "view.otherOptions.autoShowCollection",
        label: "Auto-show Collection Preview",
        checked: autoShowEnabled,
        action: () => {
          autoShowEnabled = !autoShowEnabled;
          // Update the checked state on the menu item
          if (menuItem.children?.[0]) {
            menuItem.children[0].checked = autoShowEnabled;
            notifyMenusChanged();
          }
        },
      },
    ],
  };
  registerMenuItem("view", menuItem);

  // Register command to toggle panel manually
  context.commands.register("collection-preview.toggle", async () => {
    const { getGridStateSnapshot } = await import("../../../src/api/grid");
    const state = getGridStateSnapshot();
    if (state?.selection) {
      openTaskPane(PANE_ID, {
        row: state.selection.startRow,
        col: state.selection.startCol,
      });
    }
  });

  isActivated = true;
  console.log("[CollectionPreview] Activated.");
}

function deactivate(): void {
  if (!isActivated) return;
  console.log("[CollectionPreview] Deactivating...");
  for (let i = cleanupFns.length - 1; i >= 0; i--) {
    cleanupFns[i]();
  }
  cleanupFns.length = 0;
  isActivated = false;
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.collection-preview",
    name: "Collection Preview",
    version: "1.0.0",
    description:
      "Shows a sidebar panel previewing the contents of List and Dict cells.",
  },
  activate,
  deactivate,
};

export default extension;
