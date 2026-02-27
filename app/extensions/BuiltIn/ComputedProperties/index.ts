//! FILENAME: app/extensions/BuiltIn/ComputedProperties/index.ts
// PURPOSE: Computed Properties extension module.
// CONTEXT: Registers the Computed Properties dialog and context menu item.

import type {
  ExtensionModule,
  ExtensionContext,
} from "../../../src/api/contract";
import { DialogExtensions } from "../../../src/api/ui";
import {
  gridExtensions,
  GridMenuGroups,
} from "../../../src/api/extensions";
import type { GridMenuContext } from "../../../src/api/extensions";
import { ComputedPropertiesDialog } from "./ComputedPropertiesDialog";

let isActivated = false;

function activate(_context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[ComputedProperties] Already activated, skipping.");
    return;
  }

  console.log("[ComputedProperties] Activating...");

  // Register the dialog component
  DialogExtensions.registerDialog({
    id: "computed-properties",
    component: ComputedPropertiesDialog,
    priority: 300,
  });

  // Register context menu item
  gridExtensions.registerContextMenuItem({
    id: "computed-properties",
    label: "Computed Properties...",
    group: GridMenuGroups.FORMAT,
    order: 90,
    visible: true,
    onClick: (ctx: GridMenuContext) => {
      const data: Record<string, unknown> = {};
      const sel = ctx.selection;

      if (sel && sel.type === "columns") {
        data.targetType = "column";
        data.index = Math.min(sel.startCol, sel.endCol);
      } else if (sel && sel.type === "rows") {
        data.targetType = "row";
        data.index = Math.min(sel.startRow, sel.endRow);
      } else {
        data.targetType = "cell";
        data.index = sel?.startRow ?? 0;
        data.index2 = sel?.startCol ?? 0;
      }

      DialogExtensions.openDialog("computed-properties", data);
    },
  });

  isActivated = true;
  console.log("[ComputedProperties] Activated successfully.");
}

function deactivate(): void {
  if (!isActivated) {
    return;
  }

  console.log("[ComputedProperties] Deactivating...");
  DialogExtensions.unregisterDialog("computed-properties");
  gridExtensions.unregisterContextMenuItem("computed-properties");
  isActivated = false;
  console.log("[ComputedProperties] Deactivated.");
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.computed-properties",
    name: "Computed Properties",
    version: "1.0.0",
    description:
      "Formula-driven attributes for columns, rows, and cells.",
  },
  activate,
  deactivate,
};

export default extension;
