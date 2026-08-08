//! FILENAME: app/src/core/components/InlineEditor/expansion.ts
// PURPOSE: Excel-parity geometry for the inline cell editor: while editing, the
//          box grows to the right over ADJACENT EMPTY cells so a long entry is
//          readable instead of scrolling inside one column's width.
// CONTEXT: The editor had no expansion logic at all. At the (correct) 64.29px
//          default column width, typing anything longer than ~7 characters made
//          the text scroll out of sight while the user was still typing it.
//
//          Two rules are non-negotiable and are what the tests pin:
//            1. NEVER expand over a cell that holds data. Obscuring the user's
//               own data to show them a half-typed entry is worse than scrolling.
//            2. NEVER cross the viewport edge. A box that runs off-screen is the
//               same failure with extra steps.
//          A neighbour whose contents are NOT KNOWN counts as occupied — the
//          safe direction when the lookup has not answered yet.

/** Chrome the box needs around its text: padding (4px each side), border (2px
 *  each side) and two pixels of caret slack. Logical pixels, pre-zoom. */
export const EDITOR_CHROME_PX = 4 * 2 + 2 * 2 + 2;

/** Vertical chrome: the 2px border, top and bottom. The editor is
 *  `box-sizing: border-box`, so one line of text occupies
 *  `height - EDITOR_VCHROME_PX`. Logical pixels, pre-zoom. */
export const EDITOR_VCHROME_PX = 2 * 2;

export interface EditorExpansionInput {
  /** Editor left edge in logical px (already clamped to the row header). */
  x: number;
  /** Width of the edited cell itself, logical px (already header-clipped). */
  baseWidth: number;
  /** Width the entry needs to be fully visible, logical px (chrome included). */
  desiredWidth: number;
  /** Widths of successive columns to the right; index 0 is the cell's neighbour. */
  neighbourWidths: readonly number[];
  /**
   * Whether each of those neighbours holds data. An entry past the end of this
   * array is UNKNOWN and treated as occupied, so a pending lookup can never
   * paint the editor over a value.
   */
  neighbourOccupied: readonly boolean[];
  /** Right edge in logical px the editor may not cross (the viewport). */
  maxRight: number;
}

/**
 * The width the inline editor should render at.
 *
 * Never smaller than the cell it is editing, never wider than the text needs,
 * never past an occupied neighbour, never past `maxRight`.
 */
export function computeExpandedEditorWidth(input: EditorExpansionInput): number {
  const {
    x,
    baseWidth,
    desiredWidth,
    neighbourWidths,
    neighbourOccupied,
    maxRight,
  } = input;

  // The entry fits: the editor is exactly its cell. This is also the path that
  // collapses the box again when the user deletes text.
  if (!(desiredWidth > baseWidth)) {
    return baseWidth;
  }

  let width = baseWidth;
  for (let n = 0; n < neighbourWidths.length; n++) {
    if (width >= desiredWidth) break;
    // Unknown counts as occupied.
    const occupied = neighbourOccupied[n] ?? true;
    if (occupied) break;
    width += neighbourWidths[n];
  }

  // Hug the text rather than snapping to whole columns (Excel's behaviour), and
  // stop at the viewport regardless.
  const viewportLimit = Math.max(baseWidth, maxRight - x);
  return Math.max(baseWidth, Math.min(width, desiredWidth, viewportLimit));
}

// ---------------------------------------------------------------------------
// Vertical expansion (Alt+Enter)
// ---------------------------------------------------------------------------

/**
 * Lines in an entry. Alt+Enter is the only way to put a newline in one, and the
 * editor never soft-wraps (`white-space: pre`), so line count is exactly the
 * number of hard breaks plus one.
 */
export function countEditorLines(text: string): number {
  if (text === "") return 1;
  return text.split("\n").length;
}

/** Height of one line of text inside a box of `baseHeight`. */
export function editorLineHeight(baseHeight: number): number {
  return Math.max(1, baseHeight - EDITOR_VCHROME_PX);
}

export interface EditorVerticalExpansionInput {
  /** Editor top edge in logical px (already clamped to the column header). */
  y: number;
  /** Height of the edited cell itself, logical px (already header-clipped). */
  baseHeight: number;
  /** Lines in the entry; 1 for an ordinary single-line edit. */
  lineCount: number;
  /** Bottom edge in logical px the editor may not cross (the viewport). */
  maxBottom: number;
}

/**
 * The height the inline editor should render at.
 *
 * WHY THIS DOES NOT CHECK WHAT IS UNDERNEATH, while the horizontal rule refuses
 * to cover any occupied neighbour: the two are answering different questions.
 * Horizontal expansion mirrors how a long value DISPLAYS when it is not being
 * edited — it spills right only into empty cells — so the editor matching that
 * keeps the entry where the value will end up. A multi-line value has no such
 * display behaviour: it never spills downward, it is clipped inside its own
 * row. So there is nothing for a vertical rule to mirror, and Excel's in-cell
 * editor simply overlays the rows beneath while the edit is open. The viewport
 * is therefore the only bound, which also keeps the newline out of the typing
 * path's IPC budget: no extra lookup is needed to grow downward.
 */
export function computeExpandedEditorHeight(input: EditorVerticalExpansionInput): number {
  const { y, baseHeight, lineCount, maxBottom } = input;

  if (lineCount <= 1) return baseHeight;

  const desired = baseHeight + (lineCount - 1) * editorLineHeight(baseHeight);
  // Never smaller than the cell, even when the cell itself is already past the
  // viewport bottom (a partially scrolled row).
  const viewportLimit = Math.max(baseHeight, maxBottom - y);
  return Math.max(baseHeight, Math.min(desired, viewportLimit));
}

// ---------------------------------------------------------------------------
// Text measurement
// ---------------------------------------------------------------------------

/**
 * `undefined` = not tried yet, `null` = this environment has no 2D context
 * (jsdom under vitest), otherwise the shared measuring context.
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;

/**
 * Width of the widest line of `text` at `font`.
 *
 * Falls back to a character-count estimate where no canvas exists, so callers
 * behave deterministically under test instead of measuring zero and never
 * expanding.
 */
export function measureEditorTextWidth(
  text: string,
  font: string,
  fallbackCharWidth: number,
): number {
  if (text === "") return 0;
  // Alt+Enter puts newlines in the buffer; the box must fit the longest line.
  const lines = text.split("\n");

  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d");
    } catch {
      measureCtx = null;
    }
  }

  if (measureCtx) {
    measureCtx.font = font;
    let widest = 0;
    for (const line of lines) {
      const w = measureCtx.measureText(line).width;
      if (w > widest) widest = w;
    }
    return widest;
  }

  let widest = 0;
  for (const line of lines) {
    const w = line.length * fallbackCharWidth;
    if (w > widest) widest = w;
  }
  return widest;
}
