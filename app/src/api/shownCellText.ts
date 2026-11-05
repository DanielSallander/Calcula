//! FILENAME: app/src/api/shownCellText.ts
// PURPOSE: What a General number cell SHOWS at its column's width, for the
//          features that act on what the user sees (BUG-0355: Increase /
//          Decrease Decimal counts the decimals shown -- 1234.5678 in a default
//          column shows 1234,568, so Increase gives 0.0000, as in Excel).
// CONTEXT: A pure re-export of Core's measurement (core/lib/shownCellText.ts),
//          which uses the grid's own General ladder and paint font, so the
//          answer is the grid's and is computed in one place. Never throws:
//          `null` means "no width-fitted General number here".

export { shownGeneralTextAt } from "../core/lib/shownCellText";
