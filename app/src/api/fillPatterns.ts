//! FILENAME: app/src/api/fillPatterns.ts
// PURPOSE: The fill handle's series machinery, for an extension that fills the
//          way the handle does: pattern inference (1, 3 -> 5, 7; "Item 1" ->
//          "Item 2"; Mon -> Tue; the custom fill lists) and the batched write
//          preparation that shifts formulas and carries each source cell's
//          style.
// CONTEXT: Home tab 2026-10-04. Fill > Series...'s AutoFill type is, in Excel's
//          own words, "like dragging the fill handle". The machinery lives in
//          core/lib/fillEngine.ts, ONE implementation shared by the drag and the
//          script host (api.fillRange) so the two cannot disagree about what a
//          fill means; the Series dialog is a third caller. Without this door an
//          extension could only re-implement the inference -- a second answer to
//          "what comes after Mon" that drifts on the engine's first change.
//          A pure re-export: nothing here may decide anything the engine does
//          not.

//
//          `planFillLine` (review finding (j), 2026-10-04) is the per-line plan
//          itself -- source cells, the formula-filtered pattern, the fill index,
//          the cycling source -- so a door that fills "like the handle" calls
//          the handle's own loop instead of a copy of it (the Series copy had
//          dropped the formula filter).

export {
  detectPattern,
  generateFillValue,
  processPendingFills,
  planFillLine,
  fillPatternFor,
} from "../core/lib/fillEngine";
export type { PatternResult, PendingFill, FillLine, FillLineCell } from "../core/lib/fillEngine";
