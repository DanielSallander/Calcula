//! FILENAME: app/extensions/DefinedNames/handlers/formulasMenuItemBuilder.ts
// PURPOSE: Register "Define Name" and "Name Manager" menu items in the Formulas menu.
// CONTEXT: Adds menu items that open the define name / name manager dialogs.

import { registerMenuItem, showDialog } from "../../../src/api";

/**
 * Register defined names menu items in the Formulas menu.
 * Returns a cleanup function.
 */
export function registerDefinedNamesMenuItems(): () => void {
  const cleanups: (() => void)[] = [];

  cleanups.push(
    registerMenuItem("formulas", {
      id: "formulas:separator-names",
      label: "",
      separator: true,
    })
  );

  cleanups.push(
    registerMenuItem("formulas", {
      id: "formulas:defineName",
      label: "Define Name...",
      action: () => {
        showDialog("define-name", { mode: "new" });
      },
    })
  );

  cleanups.push(
    registerMenuItem("formulas", {
      id: "formulas:nameManager",
      label: "Name Manager...",
      action: () => {
        showDialog("name-manager");
      },
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
