//! FILENAME: app/src/api/cellClipboard.ts
// PURPOSE: The CELL clipboard's one freshness rule, for extensions: is the
//          internal clipboard (the last Copy / Cut of cells, with formulas,
//          styles, comments and validations) still what the clipboard holds,
//          or did another program put newer text there since?
// CONTEXT: Home tab = Excel's Home tab, clipboard lane (2026-10-04; survey
//          clipboard.md section 9, defect 3). Plain Paste (Core,
//          hooks/useClipboard.ts) has always asked: it compares the system
//          clipboard's text with the text the copy wrote there and pastes the
//          system text when another program replaced it. The Paste Special
//          variants (Paste Values, Formulas, Formatting, Link, Transpose, ...)
//          read `getInternalClipboard()` and never asked, so after a copy in
//          Notepad, Paste Values pasted the OLD Calcula cells.
//
//          The rule lives in Core next to the clipboard it describes, and is
//          re-exported here so an extension asks the SAME question plain Paste
//          does -- never a copy of it (Windows line endings were the first
//          thing a copy would get wrong). `getInternalClipboard` and the
//          `ClipboardData` type stay where they are (@api/lib).
//
//          Imported by its own path (`@api/cellClipboard`), like every module
//          the Home-tab programme adds (contract 6.9): the barrel and
//          @api/lib belong to other lanes.

export {
  internalClipboardIsCurrent,
  internalClipboardMatchesSystemText,
} from "../core/hooks/useClipboard";
