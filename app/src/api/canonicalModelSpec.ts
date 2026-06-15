//! FILENAME: app/src/api/canonicalModelSpec.ts
// PURPOSE: The SINGLE SOURCE OF TRUTH for the canonical shared object model's
//          member set (C3 step 4) — Workbook -> Sheet -> Range -> Cell. Every
//          runtime surface must expose at least these members:
//            - extensions:     CellRange (range.ts), Sheet/Workbook (objectModel.ts)
//            - object scripts:  ScriptRange/ScriptSheet/ScriptWorkbook
//                               (scriptableObjects.ts) + objectContexts.d.ts (Monaco)
//                               + the worker impl (scriptHost/worker/canonicalModel.ts)
//            - notebooks:       the Rust-QuickJS objects (C3 step 5 — not yet bound)
// CONTEXT: canonicalModelCoverage.test.ts reads each surface and asserts it
//          covers these manifests, so a method added to the canonical model
//          cannot be "half-added" to one runtime: it must be added to the
//          manifest here (the single source), which then fails the coverage test
//          for every surface still missing it. The only sanctioned per-runtime
//          variation is the VALUE shape / async-ness (e.g. extension getValues
//          returns CellData; object-script getValues returns display strings) —
//          the MEMBER SET is unified here.

/** Members every `Range`/`Cell` facet must expose (a Cell is a single-cell Range). */
export const CANONICAL_RANGE_MEMBERS = [
  "address",
  "rowCount",
  "colCount",
  "isSingleCell",
  "offset",
  "resize",
  "getCell",
  "getValue",
  "getValues",
  "setValue",
  "setValues",
] as const;

/** Members every `Sheet` facet must expose. */
export const CANONICAL_SHEET_MEMBERS = [
  "index",
  "name",
  "range",
  "cell",
  "activate",
] as const;

/** Members every `Workbook` facet must expose. */
export const CANONICAL_WORKBOOK_MEMBERS = [
  "sheets",
  "activeSheet",
  "sheet",
] as const;

export type CanonicalRangeMember = (typeof CANONICAL_RANGE_MEMBERS)[number];
export type CanonicalSheetMember = (typeof CANONICAL_SHEET_MEMBERS)[number];
export type CanonicalWorkbookMember = (typeof CANONICAL_WORKBOOK_MEMBERS)[number];
