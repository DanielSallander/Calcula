//! FILENAME: app/src/api/externalEdit.ts
// PURPOSE: The external edit seam for the shell and extensions: one edit
//          session with two views (an extension's in-place editor and the
//          formula bar), a selected external cell, the Name Box address
//          resolver, and the point-mode sheet switch.
// CONTEXT: A PURE re-export of Core's modules (core/lib/formulaEditTarget.ts,
//          core/lib/pointModeSheetSwitch.ts and, for the typed-key rule,
//          core/lib/editOpenBuffer.ts) -- one binding each, so the
//          `@api/editing` door (which does `export * from "./externalEdit"`)
//          and this subpath can never drift. The shell imports THIS subpath
//          because its tests mock `@api/editing` with fixed export lists.
//
//          Deliberately NOT here: `registerExternalFormulaTarget` /
//          `getExternalFormulaTarget` (they stay in `@api/editing`),
//          `setExternalSessionParked` (Core-internal: only the point-mode
//          switch may park a session) and the test reset.

export {
  subscribeExternalEdit,
  getExternalEditVersion,
  notifyExternalEditChanged,
  getExternalEditSession,
  isExternalEditLive,
  isExternalSessionParked,
  getParkedViewSheetIndex,
  isCrossSheetPointMode,
  getCrossSheetPointModeKey,
  publishExternalCellTarget,
  getExternalCellTarget,
  resolveFormulaBarSource,
  getExternalNameBoxAddress,
  registerExternalAddressResolver,
  resolveExternalAddress,
  isFormulaBarElement,
} from "../core/lib/formulaEditTarget";
export type {
  ExternalEditMove,
  ExternalEditView,
  ExternalEditSession,
  ExternalCellTarget,
  FormulaBarSource,
  ExternalAddressResolution,
  ExternalAddressResolver,
} from "../core/lib/formulaEditTarget";

export {
  switchSheetForPointMode,
  endExternalFormulaSession,
  enterCommitMove,
  returnParkedViewToHost,
  focusFormulaBar,
  focusExternalSessionView,
} from "../core/lib/pointModeSheetSwitch";
export type { GridDispatch } from "../core/lib/pointModeSheetSwitch";

// The ONE "does this keydown TYPE its character" rule (core/lib/editOpenBuffer
// .ts), AltGr included (E13): an extension's own in-place editor (a floating
// grid's type-to-edit) must start an entry on exactly the keys the grid does,
// or "@" typed with AltGr on sv-SE opens a cell editor on the sheet but not on
// a floating grid.
export { isTypedCharacterKey } from "../core/lib/editOpenBuffer";
export type { TypedKeyLike } from "../core/lib/editOpenBuffer";

// The R1C1 swap the grid's own formula bar and editor make (core/lib/r1c1.ts):
// an external cell (a floating grid's) is SHOWN relative to itself in R1C1
// when the workbook uses that style, and converted back to A1 when stored
// (E3) -- one conversion, so the two cannot disagree about a reference.
export { formulaA1ToR1C1, formulaR1C1ToA1 } from "../core/lib/r1c1";

// The ONE spelling of a sheet name before `!` in text handed to an external
// edit (core/lib/formulaEditTarget.ts, the backend's `is_bare_sheet_name`):
// Core's header and GETPIVOTDATA picks and a floating grid's own cell picks
// build the SAME edit's text, so they must quote a sheet the same way -- and
// the way the parser reads it ("Q1-2026", "2024Budget", "TRUE" are quoted).
export { quoteSheetNameForFormula } from "../core/lib/formulaEditTarget";
