//! FILENAME: app/extensions/Protection/handlers/sheetTabGuard.ts
// PURPOSE: Modifies sheet tab context menu items when workbook is protected.
// CONTEXT: Disables Insert/Delete/Rename/Move sheet operations when workbook structure is locked.

import { sheetExtensions, showDialog } from "../../../src/api";
import { isCurrentWorkbookProtected } from "../lib/protectionStore";

const PROTECTION_WARNING_DIALOG_ID = "protection-warning";

/**
 * Register sheet tab context menu overrides for workbook protection.
 * Re-registers the core menu items with a `disabled` callback that checks workbook protection.
 */
export function registerSheetTabProtection(): void {
  // Override "Rename" - disable when workbook protected
  sheetExtensions.registerContextMenuItem({
    id: "core:rename",
    label: "Rename",
    disabled: () => isCurrentWorkbookProtected(),
    onClick: async (context) => {
      if (isCurrentWorkbookProtected()) {
        showDialog(PROTECTION_WARNING_DIALOG_ID, {
          message: "Workbook structure is protected. You cannot rename sheets.",
        });
        return;
      }
      const newName = prompt("Enter new sheet name:", context.sheet.name);
      if (newName && newName.trim() !== "" && newName !== context.sheet.name) {
        const event = new CustomEvent("sheet:requestRename", {
          detail: { index: context.index, newName: newName.trim() },
        });
        window.dispatchEvent(event);
      }
    },
  });

  // Override "Delete" - disable when workbook protected or only one sheet
  sheetExtensions.registerContextMenuItem({
    id: "core:delete",
    label: "Delete",
    disabled: (context) => context.totalSheets <= 1 || isCurrentWorkbookProtected(),
    separatorAfter: true,
    onClick: async (context) => {
      if (isCurrentWorkbookProtected()) {
        showDialog(PROTECTION_WARNING_DIALOG_ID, {
          message: "Workbook structure is protected. You cannot delete sheets.",
        });
        return;
      }
      if (context.totalSheets <= 1) return;
      const confirmed = confirm(`Delete sheet "${context.sheet.name}"?`);
      if (confirmed) {
        const event = new CustomEvent("sheet:requestDelete", {
          detail: { index: context.index },
        });
        window.dispatchEvent(event);
      }
    },
  });

  // Override "Insert Sheet" - disable when workbook protected
  sheetExtensions.registerContextMenuItem({
    id: "core:insertSheet",
    label: "Insert Sheet",
    disabled: () => isCurrentWorkbookProtected(),
    onClick: async () => {
      if (isCurrentWorkbookProtected()) {
        showDialog(PROTECTION_WARNING_DIALOG_ID, {
          message: "Workbook structure is protected. You cannot insert sheets.",
        });
        return;
      }
      const event = new CustomEvent("sheet:requestAdd", { detail: {} });
      window.dispatchEvent(event);
    },
  });
}
