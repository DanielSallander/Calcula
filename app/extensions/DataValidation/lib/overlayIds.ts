//! FILENAME: app/extensions/DataValidation/lib/overlayIds.ts
// PURPOSE: Overlay/dialog ids shared by the extension entry point and its handlers.
// CONTEXT: The dropdown is opened from three places (chevron click, keyboard,
//          sheet/structure teardown); the id must be stated once.

export const DROPDOWN_OVERLAY_ID = "validation-list-dropdown";
export const PROMPT_OVERLAY_ID = "validation-prompt";
export const ERROR_DIALOG_ID = "data-validation-error";
export const CONFIG_DIALOG_ID = "data-validation-dialog";
