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

const DIALOG_ID = "data-validation-dialog";

/**
 * Register Data Validation menu items under a "Validation" submenu in the Data menu.
 */
export function registerDataValidationMenuItems(context: ExtensionContext): void {
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
}
