//! FILENAME: app/extensions/BuiltIn/BoundProperties/index.ts
// PURPOSE: The Bound Properties view (WP-D S10, D §3.21): Formulas > Bound
//          Properties... lists every object property in the workbook that
//          follows a formula, with Go to, Edit and Remove.
// CONTEXT: A built-in that uses only the public seams (`@api/objectBindings`,
//          `@api/objectSelection`, the shared fx widgets), like a third-party
//          extension would. The Formulas menu is Tracing's; this extension only
//          adds its own item to it and takes it back on deactivate.

import type { ExtensionContext, ExtensionModule } from "@api/contract";
import { DialogExtensions, IconTraceDependents } from "@api";
import { BoundPropertiesDialog } from "./BoundPropertiesDialog";

/** The command that opens the view (also the Quick Access entry). */
export const SHOW_BOUND_PROPERTIES_COMMAND = "objectBindings.showBoundProperties";
/** The dialog's registration id. */
export const BOUND_PROPERTIES_DIALOG_ID = "bound-properties";
/** The menu items this extension adds to the Formulas menu. */
export const BOUND_PROPERTIES_MENU_ITEM_ID = "formulas:boundProperties";
const BOUND_PROPERTIES_SEPARATOR_ID = "formulas:boundProperties:sep";

const cleanups: Array<() => void> = [];

function activate(context: ExtensionContext): void {
  context.ui.dialogs.register({
    id: BOUND_PROPERTIES_DIALOG_ID,
    component: BoundPropertiesDialog,
    priority: 110,
  });
  cleanups.push(() => context.ui.dialogs.unregister(BOUND_PROPERTIES_DIALOG_ID));

  context.commands.register(SHOW_BOUND_PROPERTIES_COMMAND, () => {
    DialogExtensions.openDialog(BOUND_PROPERTIES_DIALOG_ID, {});
  });
  cleanups.push(() => context.commands.unregister(SHOW_BOUND_PROPERTIES_COMMAND));

  context.ui.menus.registerItem("formulas", {
    id: BOUND_PROPERTIES_SEPARATOR_ID,
    label: "",
    separator: true,
  });
  context.ui.menus.registerItem("formulas", {
    id: BOUND_PROPERTIES_MENU_ITEM_ID,
    label: "Bound Properties...",
    icon: IconTraceDependents,
    action: () => {
      void context.commands.execute(SHOW_BOUND_PROPERTIES_COMMAND);
    },
  });
  cleanups.push(() => {
    context.ui.menus.unregisterItem("formulas", BOUND_PROPERTIES_MENU_ITEM_ID);
    context.ui.menus.unregisterItem("formulas", BOUND_PROPERTIES_SEPARATOR_ID);
  });
}

function deactivate(): void {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    try {
      cleanup?.();
    } catch (err) {
      console.error("[BoundProperties] Cleanup failed:", err);
    }
  }
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.bound-properties",
    name: "Bound Properties",
    version: "1.0.0",
    description: "Lists every object property that follows a formula, with Go to, Edit and Remove.",
  },
  activate,
  deactivate,
};

export default extension;
