//! FILENAME: app/src/core/lib/gridRenderer/layout/textOrientation.ts
// PURPOSE: The geometry of ROTATED and STACKED cell text: what a style's
//          `textRotation` means, where Excel puts such text inside its cell,
//          and how much room it needs.
// CONTEXT: Pure (no canvas, no DOM). Two consumers, and the reason this is a
//          module of its own rather than code inside either of them:
//            - rendering/cells.ts paints with it;
//            - layout/autoFit.ts measures row heights and column widths with it.
//          A painter and a measurer that each carry their own idea of "how tall
//          is 45-degree text" drift on the first change to either, and the
//          symptom is the worst kind -- AutoFit grows the row, and the text is
//          STILL cut, because the painter put it somewhere else. Line breaking
//          already went through that once (see the header of autoFit.ts).
//
//          It lives in layout/ because the dependency edge is rendering ->
//          layout, never the reverse (autoFit.ts explains why).
//
// EXCEL'S RULES, MEASURED (Excel 16 build 20430, 2026-10-04; a fresh hidden
// instance and a new unsaved workbook, the picture sheet exported to PDF and
// read back):
//   - Vertical alignment places the text along the cell's HEIGHT at every
//     angle: Top puts the run's upper end at the top, Bottom its lower end at
//     the bottom, Middle centres it. The old painter pivoted every rotated run
//     on the cell centre and ignored the cell's vertical alignment entirely.
//   - Horizontal alignment places it ACROSS the cell. General is not "text
//     left, numbers right" once text is rotated; it depends on the angle alone
//     (a number and a word land on the same side):
//         +90 (Rotate Text Up)   -> right      -90 (Rotate Text Down) -> left
//         0 < angle < 90         -> left       -90 < angle < 0        -> right
//         stacked (Vertical Text) -> centre
//   - Stacked text puts ONE character per line, a space included (AutoFit of
//     "Ab" = 29.3pt, "A b" = 43.5pt, ten letters = 143.3pt on a 14.3pt
//     default row: one line pitch per character).
//   - Angled text needs |w sin a| + |h cos a| of height (AutoFit of one
//     string: 90deg 60.4pt, 45deg 52.5pt, 30deg 42.4pt, 0deg 14.3pt), which is
//     the height of the axis-aligned box around the rotated line.
//
// WHAT IS DELIBERATELY NOT REPRODUCED (contained, and reported): Excel draws an
// ANGLED cell as a parallelogram -- its left and right borders are slanted
// along the text and the text may run over the next column inside that slant.
// Calcula's cells stay rectangles; the rotated block is placed inside the cell
// rectangle by the alignments above and clipped to it.

/** What a style's `textRotation` asks for. */
export type TextOrientation =
  | { kind: "horizontal" }
  | { kind: "angle"; degrees: number }
  | { kind: "stacked" };

/** Horizontal alignment as a style stores it ("" and "general" are General). */
export type OrientationHAlign = "general" | "left" | "center" | "right" | "";

/** Vertical alignment as a style stores it. */
export type OrientationVAlign = "top" | "middle" | "bottom";

/**
 * Line pitch, as a multiple of the font's pixel size. The SAME factor the wrap
 * painter (rendering/cells.ts) and row AutoFit (`LINE_HEIGHT_FACTOR` in
 * autoFit.ts) use for one line of text, so a stacked character, a rotated
 * line's thickness and a wrapped line are one unit everywhere.
 */
export const ORIENTATION_LINE_HEIGHT_FACTOR = 1.2;

/** A content box: the cell rectangle minus the text padding. */
export interface OrientationBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Read a style's `textRotation` (the backend reports "none", "rotate90",
 * "rotate270", "vertical" and "custom:N", N counter-clockwise in -90..90).
 *
 * The legacy bare spellings the old painter accepted ("90", "270", "-90", "0")
 * are kept, because a style cached before the backend normalised them may
 * still carry one. Anything unreadable paints HORIZONTALLY: an unknown value
 * at a guessed angle would be a rendering nobody asked for.
 */
export function parseTextOrientation(textRotation: string | undefined | null): TextOrientation {
  const value = (textRotation ?? "").trim();
  if (value === "" || value === "none" || value === "0") return { kind: "horizontal" };
  if (value === "vertical") return { kind: "stacked" };
  if (value === "rotate90" || value === "90") return { kind: "angle", degrees: 90 };
  if (value === "rotate270" || value === "270" || value === "-90") return { kind: "angle", degrees: -90 };
  if (value.startsWith("custom:")) {
    const n = Number(value.substring(7));
    if (!Number.isFinite(n)) return { kind: "horizontal" };
    const degrees = Math.max(-90, Math.min(90, Math.round(n)));
    return degrees === 0 ? { kind: "horizontal" } : { kind: "angle", degrees };
  }
  return { kind: "horizontal" };
}

/**
 * The axis-aligned box a single rotated line occupies: `textWidth` along the
 * text, `lineHeight` across it, turned by `degrees`.
 */
export function rotatedTextExtent(
  textWidth: number,
  lineHeight: number,
  degrees: number,
): { width: number; height: number } {
  // Exact at 90: Math.cos(PI / 2) is 6e-17, not 0, and an extent that is a
  // hair over a whole pixel would make AutoFit ceil the row one pixel taller.
  const quarterTurn = Math.abs(degrees) === 90;
  const radians = (Math.abs(degrees) * Math.PI) / 180;
  const sin = quarterTurn ? 1 : Math.sin(radians);
  const cos = quarterTurn ? 0 : Math.cos(radians);
  return {
    width: textWidth * cos + lineHeight * sin,
    height: textWidth * sin + lineHeight * cos,
  };
}

/**
 * Which side of the cell a rotated run sits on. An explicit alignment is kept;
 * General resolves by the ANGLE, as measured (see the header).
 */
export function rotatedHorizontalSide(
  hAlign: OrientationHAlign | string,
  degrees: number,
): "left" | "center" | "right" {
  if (hAlign === "left" || hAlign === "center" || hAlign === "right") return hAlign;
  if (degrees === 90) return "right";
  if (degrees === -90) return "left";
  return degrees > 0 ? "left" : "right";
}

/** Where to put a rotated run: translate to (cx, cy), rotate, draw centred. */
export interface RotatedTextPlacement {
  /** Centre of the rotated run's box, in canvas coordinates. */
  cx: number;
  cy: number;
  /**
   * Canvas rotation. Canvas angles run CLOCKWISE on screen and Excel's run
   * counter-clockwise, so Rotate Text Up (+90) is -PI/2 here.
   */
  radians: number;
  /** The run's axis-aligned box. */
  width: number;
  height: number;
}

/**
 * Place a rotated run inside a content box by its two alignments.
 *
 * The run is never shortened to fit: one that is longer than the box is
 * ANCHORED by its alignment (bottom-aligned Rotate Text Up shows its start)
 * and the caller's clip cuts the rest, exactly as horizontal text is clipped.
 * The old painter sized the run to `cell height - padding` and centred it, so
 * a long value lost both ends.
 */
export function layoutRotatedText(args: {
  degrees: number;
  textWidth: number;
  lineHeight: number;
  box: OrientationBox;
  hAlign: OrientationHAlign | string;
  vAlign: OrientationVAlign | string;
}): RotatedTextPlacement {
  const { degrees, textWidth, lineHeight, box } = args;
  const { width, height } = rotatedTextExtent(textWidth, lineHeight, degrees);

  const side = rotatedHorizontalSide(args.hAlign, degrees);
  const cx =
    side === "left"
      ? box.left + width / 2
      : side === "right"
        ? box.right - width / 2
        : (box.left + box.right) / 2;

  const cy =
    args.vAlign === "top"
      ? box.top + height / 2
      : args.vAlign === "middle"
        ? (box.top + box.bottom) / 2
        : box.bottom - height / 2;

  return { cx, cy, radians: (-degrees * Math.PI) / 180, width, height };
}

// ---------------------------------------------------------------------------
// Rotated text on SEVERAL lines: Wrap Text and hard breaks (BUG-0363)
// ---------------------------------------------------------------------------
//
// EXCEL WRAPS ROTATED TEXT ALONG ITS OWN DIRECTION, measured [LIVE] 2026-11-04
// (Excel 16, fresh hidden instance, new unsaved workbook, Calibri 11, "one two
// three four five six seven eight" -- 175.5pt on one line):
//   - Rotate Text Up/Down with Wrap Text: the lines break at the ROW HEIGHT and
//     stack ACROSS the cell -- column AutoFit gave 117.75pt in a 30pt row and
//     60.75pt in a 60pt row (one line, wrap off: 18pt whatever the row).
//   - At 45 degrees the same: 193.5pt in a 30pt row, 90.4pt in a 60pt row, so
//     the line length is bounded by the row height, along the slant.
//   - With wrap off the value stays on one line (18pt column at +-90).
// The painter wraps there now; before, a wrapped rotated value was painted as
// one long run and cut by the cell.
//
// A HARD BREAK breaks a rotated value with Wrap Text off as well. Excel shows
// such a value on one line, but only because typing Alt+Enter switches Wrap Text
// ON in Excel; Calcula's editor does not (see the long note in
// rendering/cells.ts at `breakWithoutWrap`), so the horizontal painter breaks on
// a hard break either way and rotated text follows the same rule rather than
// hiding the user's line break in one orientation only.

/**
 * How long a rotated line may run before Wrap Text breaks it: the content box's
 * height along the text direction. At +-90 that is the height itself; at an
 * angle the slant through the height (`height / sin a`).
 */
export function rotatedWrapLength(degrees: number, box: OrientationBox): number {
  const height = box.bottom - box.top;
  if (Math.abs(degrees) === 90) return height;
  const sin = Math.sin((Math.abs(degrees) * Math.PI) / 180);
  return sin > 0 ? height / sin : Number.POSITIVE_INFINITY;
}

/** One line of a rotated block, in the block's ROTATED frame. */
export interface RotatedLine {
  text: string;
  /** Left end of the line along the text direction (draw with textAlign "left"). */
  x: number;
  /** Centre of the line across it (draw with textBaseline "middle"). */
  y: number;
}

/** A rotated block: where to translate and rotate, and each line inside it. */
export interface RotatedBlockPlacement extends RotatedTextPlacement {
  lines: RotatedLine[];
}

/**
 * Where a line sits ALONG the text direction inside its block, from the cell's
 * vertical alignment: rotated text reads upward at a positive angle, so Bottom
 * is where a line STARTS; at a negative angle it reads downward and Top is.
 * Excel anchors every line of the block to the same end (one line: the whole
 * block, which is what `layoutRotatedText` does).
 */
function alongTextAnchor(degrees: number, vAlign: OrientationVAlign | string): "start" | "center" | "end" {
  if (vAlign === "middle") return "center";
  const bottom = vAlign !== "top";
  if (degrees > 0) return bottom ? "start" : "end";
  return bottom ? "end" : "start";
}

/**
 * Place a rotated value of one or more LINES. The block is the widest line by
 * `lines.length` line pitches, placed in the cell exactly as a single rotated
 * run is (`layoutRotatedText`: both alignments, anchored, never pre-shortened).
 * Inside it the first line is the one nearest the text's top -- the LEFT at
 * Rotate Text Up, the right at Rotate Text Down -- and each line is anchored
 * along the text by the vertical alignment.
 *
 * One line gives exactly the single-run placement: `x = -width / 2, y = 0`.
 */
export function layoutRotatedLines(args: {
  degrees: number;
  lines: Array<{ text: string; width: number }>;
  lineHeight: number;
  box: OrientationBox;
  hAlign: OrientationHAlign | string;
  vAlign: OrientationVAlign | string;
}): RotatedBlockPlacement {
  const { degrees, lines, lineHeight } = args;
  const blockWidth = lines.reduce((w, l) => Math.max(w, l.width), 0);
  const blockHeight = Math.max(1, lines.length) * lineHeight;
  const block = layoutRotatedText({
    degrees,
    textWidth: blockWidth,
    lineHeight: blockHeight,
    box: args.box,
    hAlign: args.hAlign,
    vAlign: args.vAlign,
  });
  const anchor = alongTextAnchor(degrees, args.vAlign);
  const placed = lines.map((line, i) => ({
    text: line.text,
    x:
      anchor === "start"
        ? -blockWidth / 2
        : anchor === "end"
          ? blockWidth / 2 - line.width
          : -line.width / 2,
    y: -blockHeight / 2 + lineHeight * (i + 0.5),
  }));
  return { ...block, lines: placed };
}

/** The columns of a stacked value: one per hard-break segment, split on code points. */
function stackedColumns(text: string): string[][] {
  // A hard break in stacked text starts a new column to the right. Splitting
  // here rather than importing autoFit's `splitHardBreaks` keeps this module a
  // leaf (autoFit imports IT); the spelling set is the same: CRLF, CR, LF.
  return text.split(/\r\n|\r|\n/).map((segment) => Array.from(segment));
}

/** Gap between two stacked columns, as a fraction of the line height. */
const STACKED_COLUMN_GAP = 0.25;

/**
 * The room stacked text needs: one line height per character (a space
 * included) for the longest column, and the widest glyph of each column side
 * by side.
 */
export function stackedTextExtent(
  text: string,
  measure: (text: string) => number,
  lineHeight: number,
): { width: number; height: number } {
  const columns = stackedColumns(text);
  let width = 0;
  let lines = 0;
  columns.forEach((chars, i) => {
    let widest = 0;
    for (const ch of chars) widest = Math.max(widest, measure(ch));
    width += widest + (i > 0 ? lineHeight * STACKED_COLUMN_GAP : 0);
    lines = Math.max(lines, chars.length);
  });
  return { width, height: lines * lineHeight };
}

/** One glyph of stacked text: draw `text` at (x, y) with textBaseline "middle". */
export interface StackedGlyph {
  text: string;
  /** Left edge of the glyph (draw with textAlign "left"). */
  x: number;
  /** Vertical centre of the glyph's line. */
  y: number;
}

/**
 * Lay stacked text out inside a content box. Every character of a column is
 * centred on ONE vertical line (the widest glyph decides the column's width),
 * a space keeps its line but paints nothing, General centres the stack.
 */
export function layoutStackedText(args: {
  text: string;
  measure: (text: string) => number;
  lineHeight: number;
  box: OrientationBox;
  hAlign: OrientationHAlign | string;
  vAlign: OrientationVAlign | string;
}): StackedGlyph[] {
  const { measure, lineHeight, box } = args;
  const columns = stackedColumns(args.text);
  const widths = columns.map((chars) => chars.reduce((w, ch) => Math.max(w, measure(ch)), 0));
  const { width: blockWidth, height: blockHeight } = stackedTextExtent(args.text, measure, lineHeight);

  const hAlign = args.hAlign;
  const blockLeft =
    hAlign === "left"
      ? box.left
      : hAlign === "right"
        ? box.right - blockWidth
        : (box.left + box.right - blockWidth) / 2;
  const blockTop =
    args.vAlign === "top"
      ? box.top
      : args.vAlign === "middle"
        ? (box.top + box.bottom - blockHeight) / 2
        : box.bottom - blockHeight;

  const glyphs: StackedGlyph[] = [];
  let columnLeft = blockLeft;
  columns.forEach((chars, c) => {
    if (c > 0) columnLeft += lineHeight * STACKED_COLUMN_GAP;
    const columnCentre = columnLeft + widths[c] / 2;
    chars.forEach((ch, i) => {
      if (ch.trim() === "") return; // a space keeps its line, paints nothing
      glyphs.push({
        text: ch,
        x: columnCentre - measure(ch) / 2,
        y: blockTop + i * lineHeight + lineHeight / 2,
      });
    });
    columnLeft += widths[c];
  });
  return glyphs;
}
