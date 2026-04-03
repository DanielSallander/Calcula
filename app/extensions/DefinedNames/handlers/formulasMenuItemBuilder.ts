//! FILENAME: app/extensions/DefinedNames/handlers/formulasMenuItemBuilder.ts
// PURPOSE: Register "Define Name" and "Name Manager" menu items in the Formulas menu.
// CONTEXT: Adds menu items that open the define name / name manager dialogs.

import type { ExtensionContext } from "@api/contract";
import {
  showDialog,
  IconNameManager,
  IconDefineName,
  IconDefineFunction,
} from "@api";

/**
 * Register defined names menu items in the Formulas menu.
 * Returns a cleanup function.
 */
export function registerDefinedNamesMenuItems(context: ExtensionContext): () => void {
  const cleanups: (() => void)[] = [];

  cleanups.push(
    context.ui.menus.registerItem("formulas", {
      id: "formulas:separator-names",
      label: "",
      separator: true,
    })
  );

  cleanups.push(
    context.ui.menus.registerItem("formulas", {
      id: "formulas:nameManager",
      label: "Name Manager",
      icon: IconNameManager,
      action: () => {
        showDialog("name-manager");
      },
      children: [
        {
          id: "formulas:defineName",
          label: "Define Name...",
          icon: IconDefineName,
          action: () => {
            showDialog("define-name", { mode: "new" });
          },
        },
        {
          id: "formulas:defineFunction",
          label: "Define Function...",
          icon: IconDefineFunction,
          action: () => {
            showDialog("define-function", { mode: "new" });
          },
        },
      ],
    })
  );

  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Ignore cleanup errors
      }
    }
  };
}
