//! FILENAME: app/extensions/DataValidation/handlers/dataMenuBuilder.ts
// PURPOSE: Registers Data Validation menu items in the Data menu.
// CONTEXT: Adds "Data Validation...", "Circle Invalid Data", and "Clear Validation Circles".

import type { ExtensionContext } from "@api/contract";
import { showDialog } from "@api";
import { toggleCircleInvalidData, clearCircles } from "../lib/validationStore";

const DIALOG_ID = "data-validation-dialog";

/**
 * Register Data Validation menu items into the existing Data menu.
 */
export function registerDataValidationMenuItems(context: ExtensionContext): void {
  // Separator before validation items
  context.ui.menus.registerItem("data", {
    id: "data:validation-separator",
    label: "",
    separator: true,
  });

  // Data Validation... (opens the config dialog)
  context.ui.menus.registerItem("data", {
    id: "data:dataValidation",
    label: "Data Validation...",
    action: () => {
      showDialog(DIALOG_ID);
    },
  });

  // Circle Invalid Data (toggle red circles)
  context.ui.menus.registerItem("data", {
    id: "data:circleInvalidData",
    label: "Circle Invalid Data",
    action: () => {
      toggleCircleInvalidData();
    },
  });

  // Clear Validation Circles
  context.ui.menus.registerItem("data", {
    id: "data:clearValidationCircles",
    label: "Clear Validation Circles",
    action: () => {
      clearCircles();
    },
  });
}
