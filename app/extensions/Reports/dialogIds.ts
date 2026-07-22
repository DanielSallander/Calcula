//! FILENAME: app/extensions/Reports/dialogIds.ts
// PURPOSE: Dialog ids shared by the extension entry (registration), the
//   contextual ribbon tab, and the grid context menu — kept out of index.ts so
//   feature modules never import the extension entry (no import cycles).

export const CREATE_DIALOG_ID = "create-report-dialog";
export const MANAGE_DIALOG_ID = "manage-reports-dialog";
export const EDIT_DIALOG_ID = "edit-report-dialog";
