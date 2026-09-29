//! FILENAME: app/extensions/DataValidation/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Data Validation menu items in the Data menu under a "Validation" submenu.
// CONTEXT: Groups "Data Validation...", "Circle Invalid Data", and "Clear Validation Circles".

import type { ExtensionContext } from "@api/contract";
import {
  showDialog,
  IconValidation,
  IconDataValidation,
  IconCircleInvalid,
  IconClearCircles,
} from "@api";
import { toggleCircleInvalidData, clearCircles } from "../lib/validationStore";
import { refuseIfSelectionOwned } from "@api/selectionOwner";

const DIALOG_ID = "data-validation-dialog";

/**
 * Register Data Validation menu items under a "Validation" submenu in the Data menu.
 *
 * Returns the cleanup for deactivation: it takes back this extension's OWN
 * items (the Validation submenu's children go with it), never the shared Data
 * menu (wave E, Y14).
 */
export function registerDataValidationMenuItems(context: ExtensionContext): () => void {
  // Separator before validation submenu
  context.ui.menus.registerItem("data", {
    id: "data:validation-separator",
    label: "",
    separator: true,
  });

  // "Validation" submenu with all validation commands
  context.ui.menus.registerItem("data", {
    id: "data:validation",
    label: "Validation",
    icon: IconValidation,
    children: [
      {
        id: "data:validation:dataValidation",
        label: "Data Validation...",
        icon: IconDataValidation,
        action: () => {
          // The dialog edits the validation of Core's selection -- HIDDEN
          // while something else owns the selection (a floating grid's
          // selected cell) -- so refuse, once (D4, BUG-0185 class). Circle
          // Invalid Data and Clear Circles are sheet-level and stay allowed.
          if (refuseIfSelectionOwned("Data Validation")) return;
          showDialog(DIALOG_ID);
        },
      },
      {
        id: "data:validation:separator",
        label: "",
        separator: true,
      },
      {
        id: "data:validation:circleInvalidData",
        label: "Circle Invalid Data",
        icon: IconCircleInvalid,
        action: () => {
          toggleCircleInvalidData();
        },
      },
      {
        id: "data:validation:clearCircles",
        label: "Clear Validation Circles",
        icon: IconClearCircles,
        action: () => {
          clearCircles();
        },
      },
    ],
  });

  return () => {
    context.ui.menus.unregisterItem("data", "data:validation-separator");
    context.ui.menus.unregisterItem("data", "data:validation");
  };
}
