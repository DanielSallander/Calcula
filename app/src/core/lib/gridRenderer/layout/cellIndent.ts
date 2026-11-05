//! FILENAME: app/src/core/lib/gridRenderer/layout/cellIndent.ts
// PURPOSE: Where an INDENTED cell value goes, for the painter and for AutoFit.
// CONTEXT: Pure. rendering/cells.ts paints with it and layout/autoFit.ts
//          measures with it (the dependency edge is rendering -> layout; see
//          autoFit.ts). Before this module the painter indented EVERY value from
//          the left edge: a right-aligned value showed no indent at all and a
//          centred one slid right by half of it, while AutoFit added the indent
//          to every column regardless of alignment.
//
// EXCEL'S RULES, MEASURED (Excel 16 build 20430, 2026-10-04, COM on a fresh
// hidden instance and a new unsaved workbook):
//   - IndentLevel on a General or a Center cell turns its alignment into LEFT
//     (HorizontalAlignment read back -4131); on a Right cell it stays RIGHT.
//     So Excel never draws a centred value with an indent, and an indented
//     General value is a Left one -- numbers included.
//   - A Right cell's indent is measured from the RIGHT edge.
//   - Each level is one fixed step of the NORMAL style's font, whatever the
//     cell's own font. Re-measured [LIVE] 2026-11-04 (Excel 16, fresh hidden
//     instance, new unsaved workbook, the Normal style's font set and AutoFit
//     read back on "x" at levels 0..4):
//         Aptos Narrow 11   8.625 / 14.25 / 19.875 / 25.5 / 31.125pt -> 5.625pt
//         Calibri 11        9 / 16.875 / 24.75 / 32.625 / 40.5pt     -> 7.875pt
//         Arial 11          9 / 18 / 27 / 36 / 45pt                  -> 9pt
//     and a 22pt cell under each Normal font stepped by the SAME amount (L2-L0
//     = 2 steps of the Normal font, not of the cell's). Every step is 1.5 x the
//     Normal font's maximum digit width (Aptos Narrow 5px, Calibri 7px, Arial
//     8px at 96 dpi): 7.5 / 10.5 / 12px. (The OOXML spec's "three spaces"
//     does not fit: three Calibri spaces are ~10px.)
//   - Calcula's Normal font is Calibri 11 (DEFAULT_THEME.cellFontFamily /
//     cellFontSize), whose maximum digit width is the 7px every column-width
//     conversion here uses, so a level is 10.5px. It was 8px -- the step of
//     neither font -- so indent 10 started 25px short of Excel's.

/** Excel's step per indent level, in maximum-digit widths of the Normal font. */
export const INDENT_DIGIT_WIDTHS_PER_LEVEL = 1.5;

/** The maximum digit width, in px at 96 dpi, of Calcula's Normal font (Calibri 11). */
export const NORMAL_FONT_MAX_DIGIT_WIDTH_PX = 7;

/** Pixels one indent level moves a value, at zoom 1 (Calibri 11: 10.5px). */
export const INDENT_PX_PER_LEVEL = INDENT_DIGIT_WIDTHS_PER_LEVEL * NORMAL_FONT_MAX_DIGIT_WIDTH_PX;

type Side = "left" | "center" | "right";

/** True for the alignments a style spells as General. */
function isGeneral(styleAlign: string | undefined): boolean {
  return styleAlign === undefined || styleAlign === "" || styleAlign === "general";
}

/**
 * The side an indented value is drawn on. `resolved` is the side the value
 * earned without an indent (General: numbers right, text left, errors centred).
 * An indented General value is Left (Excel converts it); everything else keeps
 * its side.
 */
export function alignmentWithIndent(
  styleAlign: string | undefined,
  resolved: Side,
  indentLevel: number | undefined,
): Side {
  if ((indentLevel ?? 0) > 0 && isGeneral(styleAlign)) return "left";
  return resolved;
}

/**
 * The indent in pixels a style's alignment actually honours: one step per level
 * for Left, Right and General (which is drawn Left), nothing for Center.
 */
export function effectiveIndentPx(styleAlign: string | undefined, indentLevel: number | undefined): number {
  const level = indentLevel ?? 0;
  if (level <= 0 || styleAlign === "center") return 0;
  return level * INDENT_PX_PER_LEVEL;
}

/**
 * The horizontal text box of a cell whose content area runs from `left` to
 * `right`, after the indent: Left loses it at the left, Right at the right (a
 * right-aligned draw inside the box then ends one indent short of the edge),
 * Center ignores it.
 */
export function indentedTextBox(
  side: Side,
  left: number,
  right: number,
  indentPx: number,
): { x: number; width: number } {
  if (side === "left") return { x: left + indentPx, width: right - left - indentPx };
  if (side === "right") return { x: left, width: right - left - indentPx };
  return { x: left, width: right - left };
}
