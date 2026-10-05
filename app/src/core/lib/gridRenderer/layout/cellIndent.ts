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
//   - Each level is one fixed step (AutoFit width of "x" in Aptos Narrow 11:
//     8.625 / 14.25 / 19.875 / 25.5pt for levels 0..3 -- 7.5px a level). The
//     OOXML spec defines a level as three spaces of the Normal font; Calcula's
//     step is the 8px it has always used, kept so existing documents do not
//     move.

/** Pixels one indent level moves a value, at zoom 1. */
export const INDENT_PX_PER_LEVEL = 8;

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
