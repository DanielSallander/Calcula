//! FILENAME: app/extensions/Table/lib/dialogIds.ts
// PURPOSE: The Table extension's dialog ids, in a module that imports nothing.
// CONTEXT: The handlers that OPEN a dialog (Format as Table opens Create Table)
//          must not import manifest.ts, which imports every dialog and panel
//          component of the extension; manifest.ts re-exports these, so every
//          existing import keeps working.

/** Create Table (Insert > Table..., Ctrl+T, and Format as Table outside a table). */
export const TABLE_DIALOG_ID = "table:createDialog";
