//! FILENAME: app/src/api/externalEdit.ts
// PURPOSE: The external edit seam for the shell and extensions: one edit
//          session with two views (an extension's in-place editor and the
//          formula bar), a selected external cell, the Name Box address
//          resolver, and the point-mode sheet switch.
// CONTEXT: A PURE re-export of Core's modules (core/lib/formulaEditTarget.ts
//          and core/lib/pointModeSheetSwitch.ts) -- one binding each, so the
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
  focusFormulaBar,
  focusExternalSessionView,
} from "../core/lib/pointModeSheetSwitch";
export type { GridDispatch } from "../core/lib/pointModeSheetSwitch";
