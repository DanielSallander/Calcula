//! FILENAME: app/src/core/components/InlineEditor/expansion.ts
// PURPOSE: Excel-parity geometry for the inline cell editor.
// CONTEXT: Excel's in-cell editor is an OVERLAY, and that one word decides
//          every rule in this file. While an edit is open the box floats above
//          the grid: it grows RIGHT over whatever is beside it and DOWN over
//          whatever is beneath it, covers both regardless of content, and
//          everything it covered repaints untouched the moment the edit ends.
//          Nothing underneath is read, and nothing underneath is changed.
//
//          This file used to refuse to grow over a neighbour that held data,
//          on the reasoning that horizontal growth should mirror how a long
//          value DISPLAYS when it is not being edited (spilling right only into
//          empty cells). That is a real Excel rule, but it governs DISPLAY, not
//          EDITING, and applying it here produced the opposite of parity: an
//          entry with a neighbour to its right had nowhere to go and scrolled
//          inside one column — which is precisely the failure the file's own
//          header called out. Excel never does that, so neither do we.
//
//          Three rules, and all three are stated as failures in the tests:
//            1. Grow right to fit the entry, over occupied cells and all.
//            2. Out of horizontal room, WRAP and grow down. Never scroll, and
//               never clip text that could have been shown on another line.
//            3. Never cross the grid's edge. The bound is the GRID — the canvas
//               layer, already inset by the scrollbar gutters — not the window,
//               which would put the box under the scrollbar or a task pane.
//
//          UNITS: every number here is DEVICE px (post-zoom CSS px), because
//          the box's chrome is what makes the arithmetic exact and the chrome
//          does not scale uniformly — the border is a flat 2px at any zoom
//          while the padding scales. Callers convert their logical grid
//          coordinates once, at the boundary, and never mix the two.

/** The accent frame, in CSS px. Flat at every zoom, exactly as Excel's is. */
export const EDITOR_BORDER_PX = 2;
/** Text inset either side, in LOGICAL px; scaled by zoom to match the canvas. */
export const EDITOR_PADDING_X_PX = 4;
/** A sliver past the text so the caret at end-of-entry is never half-clipped. */
export const EDITOR_CARET_SLACK_PX = 2;

/**
 * Horizontal chrome the box needs around its text, in device px.
 *
 * A function of zoom rather than a constant because the two contributions
 * disagree: padding scales with zoom (it mirrors the canvas cell's text inset)
 * and the border does not. Treating the pair as one constant is what made the
 * box a few pixels wrong at every zoom other than 100%.
 */
export function editorChromePx(zoom: number): number {
  return EDITOR_PADDING_X_PX * 2 * zoom + EDITOR_BORDER_PX * 2 + EDITOR_CARET_SLACK_PX;
}

/**
 * Vertical chrome: the border, top and bottom, in device px. The editor is
 * `box-sizing: border-box`, so the text occupies `height - EDITOR_VCHROME_PX`.
 * Unscaled, because the border is.
 */
export const EDITOR_VCHROME_PX = EDITOR_BORDER_PX * 2;

// ---------------------------------------------------------------------------
// Horizontal growth
// ---------------------------------------------------------------------------

export interface EditorWidthInput {
  /** Editor left edge, device px, relative to the grid layer. */
  x: number;
  /** Width of the edited cell itself, device px (already header-clipped). */
  baseWidth: number;
  /** Width the entry needs to be fully visible, device px (chrome included). */
  desiredWidth: number;
  /** Right edge, device px, the editor may not cross: the GRID's, not the window's. */
  maxRight: number;
}

/**
 * The width the inline editor should render at.
 *
 * Never narrower than the cell it is editing, never wider than the entry needs,
 * never past the grid's right edge — and, deliberately, with no opinion at all
 * about what is in the columns it covers. See the header: the box is an overlay.
 *
 * Hugs the text rather than snapping to whole columns, which is also Excel's
 * behaviour and is what lets the box collapse smoothly as the entry shrinks.
 */
export function computeExpandedEditorWidth(input: EditorWidthInput): number {
  const { x, baseWidth, desiredWidth, maxRight } = input;
  // Never negative, and never smaller than the cell, even when the cell itself
  // already starts past the edge (a partially scrolled column).
  const room = Math.max(baseWidth, maxRight - x);
  return Math.max(baseWidth, Math.min(desiredWidth, room));
}

// ---------------------------------------------------------------------------
// Vertical growth
// ---------------------------------------------------------------------------

/** Height of one line of text inside a box of `baseHeight`, device px. */
export function editorLineHeight(baseHeight: number): number {
  return Math.max(1, baseHeight - EDITOR_VCHROME_PX);
}

export interface EditorHeightClampInput {
  /** Editor top edge, device px, relative to the grid layer. */
  y: number;
  /** Height of the edited cell itself, device px (already header-clipped). */
  baseHeight: number;
  /** Height the box wants, device px, chrome included. */
  desiredHeight: number;
  /** Bottom edge, device px, the editor may not cross: the GRID's. */
  maxBottom: number;
}

/**
 * The clamp both height paths share.
 *
 * WHY THERE IS NO OCCUPANCY TEST HERE EITHER, and why the grid edge is the only
 * bound: a multi-line value has no downward display behaviour to mirror — it is
 * clipped inside its own row — so there is nothing for a vertical rule to be
 * consistent with. Excel simply overlays the rows beneath while the edit is
 * open. That was already this file's vertical rule; the horizontal rule has now
 * been brought into line with it rather than the other way round.
 */
export function clampEditorHeight(input: EditorHeightClampInput): number {
  const { y, baseHeight, desiredHeight, maxBottom } = input;
  const room = Math.max(baseHeight, maxBottom - y);
  return Math.max(baseHeight, Math.min(desiredHeight, room));
}

/**
 * Height for a content box the browser has already laid out and measured.
 *
 * THIS IS THE PRODUCT'S PATH. `contentHeight` comes from the element's own
 * `scrollHeight`, so the box height is derived from the browser's actual line
 * breaking rather than from a JavaScript imitation of it. That matters because
 * the box now soft-wraps: any hand-rolled wrap that disagreed with Chromium by
 * one line would either clip the entry's last line or leave a dead strip under
 * it, and it would disagree eventually — over a break opportunity after a comma
 * or a bracket, exactly the characters formulas are made of.
 */
export function heightForMeasuredContent(input: {
  y: number;
  baseHeight: number;
  contentHeight: number;
  maxBottom: number;
}): number {
  return clampEditorHeight({
    y: input.y,
    baseHeight: input.baseHeight,
    desiredHeight: input.contentHeight + EDITOR_VCHROME_PX,
    maxBottom: input.maxBottom,
  });
}

/**
 * Lines an entry occupies counting HARD breaks only (Alt+Enter), never soft
 * wraps — soft wraps are the browser's business and are measured, not counted.
 */
export function countEditorLines(text: string): number {
  if (text === "") return 1;
  return text.split("\n").length;
}

export interface EditorVerticalExpansionInput {
  y: number;
  baseHeight: number;
  /** Lines in the entry; 1 for an ordinary single-line edit. */
  lineCount: number;
  maxBottom: number;
}

/**
 * Height from a line COUNT, for the two moments when no measurement exists: the
 * first render of a freshly mounted editor (the layout effect has not run yet,
 * so this is what paints for one frame) and an environment with no layout
 * engine at all (jsdom under vitest, where `scrollHeight` is always 0).
 *
 * It agrees with `heightForMeasuredContent` exactly whenever the entry does not
 * soft-wrap, because one rendered line is `editorLineHeight(baseHeight)` tall by
 * construction: N lines measure `N * (baseHeight - 4)`, and
 * `N * (baseHeight - 4) + 4` is this function's `baseHeight + (N-1) * (baseHeight - 4)`.
 * `the two height paths agree` in expansion.test.ts pins that identity, so the
 * first painted frame cannot jump when the measurement lands.
 */
export function computeExpandedEditorHeight(input: EditorVerticalExpansionInput): number {
  const { y, baseHeight, lineCount, maxBottom } = input;
  const lines = Math.max(1, lineCount);
  return clampEditorHeight({
    y,
    baseHeight,
    desiredHeight: baseHeight + (lines - 1) * editorLineHeight(baseHeight),
    maxBottom,
  });
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
 * Width of the widest line of `text` at `font`, device px.
 *
 * Only WIDTH is measured this way; height comes from real layout. A width that
 * is a subpixel too small merely wraps a line early, and the caret slack in
 * `editorChromePx` covers that — whereas a height computed this way would be
 * wrong by a whole line.
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
