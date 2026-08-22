//! FILENAME: app/src/core/components/InlineEditor/expansion.test.ts
// PURPOSE: The arithmetic of the inline editor's Excel-parity geometry.
// CONTEXT: Exact-pixel assertions live here; the component tests next door
//          drive the same rules through the real editor.
//
//          The rules changed shape when the box became a faithful overlay.
//          There is no longer any such thing as a neighbour it will not cover,
//          so the assertions that used to pin "stops at the first occupied
//          cell" are gone — and their absence is the point, not an omission.
//          What replaced them is the pair of properties that make the new
//          model safe: the box is bounded by the GRID, and the two independent
//          ways of arriving at its height agree exactly.

import { describe, it, expect } from "vitest";
import {
  EDITOR_BORDER_PX,
  EDITOR_PADDING_X_PX,
  EDITOR_VCHROME_PX,
  editorChromePx,
  computeExpandedEditorWidth,
  computeExpandedEditorHeight,
  heightForMeasuredContent,
  clampEditorHeight,
  countEditorLines,
  editorLineHeight,
  measureEditorTextWidth,
} from "./expansion";

/** The real default: 64.29px columns, the width that exposed the gap. */
const W = 64.29;
/** The real default row height. */
const H = 20;

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

describe("editorChromePx", () => {
  it("is padding + border + caret slack at 100%", () => {
    expect(editorChromePx(1)).toBe(EDITOR_PADDING_X_PX * 2 + EDITOR_BORDER_PX * 2 + 2);
    expect(editorChromePx(1)).toBe(14);
  });

  it("scales the PADDING with zoom and leaves the border alone", () => {
    // The trap this replaced: one constant for both. At 200% that would give
    // 28 (everything doubled) instead of 22 — padding 16, border 4, slack 2 —
    // and the box would be six pixels wider than the entry it is sizing to.
    expect(editorChromePx(2)).toBe(22);
    expect(editorChromePx(0.5)).toBe(10);
  });

  it("nets the same flat border off the height at any zoom", () => {
    // The border is 2px CSS whatever the zoom, so the vertical chrome is a
    // constant while the horizontal one is not. This asymmetry is real, and
    // pretending otherwise is what made the box wrong away from 100%.
    expect(EDITOR_VCHROME_PX).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Horizontal growth
// ---------------------------------------------------------------------------

function base(overrides: Partial<Parameters<typeof computeExpandedEditorWidth>[0]> = {}) {
  return {
    x: 50,
    baseWidth: W,
    desiredWidth: W,
    maxRight: 1000,
    ...overrides,
  };
}

describe("computeExpandedEditorWidth", () => {
  it("does not expand when the entry fits its own cell", () => {
    expect(computeExpandedEditorWidth(base({ desiredWidth: 40 }))).toBe(W);
    expect(computeExpandedEditorWidth(base({ desiredWidth: W }))).toBe(W);
  });

  it("expands to fit the entry, hugging the text rather than snapping to columns", () => {
    expect(computeExpandedEditorWidth(base({ desiredWidth: 150 }))).toBeCloseTo(150, 6);
  });

  it("covers whatever is beside it — an overlay has no opinion about occupancy", () => {
    // This is the behaviour change stated as an assertion. The old rule stopped
    // at the first neighbour holding data, which left an entry in a dense table
    // with nowhere to go: it scrolled inside one 64px column while the user was
    // still typing it. Excel's editor floats over the data and restores it on
    // exit, so the only inputs here are the box, the text and the grid edge —
    // there is deliberately no parameter through which occupancy could be
    // expressed at all.
    expect(computeExpandedEditorWidth(base({ desiredWidth: 500 }))).toBe(500);
  });

  it("clamps at the GRID edge", () => {
    // Editor starts at x=900 with a 1000px grid: 100px of room, no more.
    expect(computeExpandedEditorWidth(base({ x: 900, desiredWidth: 5000, maxRight: 1000 }))).toBe(100);
  });

  it("never shrinks below the edited cell, even hard against the grid edge", () => {
    expect(computeExpandedEditorWidth(base({ x: 990, desiredWidth: 5000, maxRight: 1000 }))).toBe(W);
    // ...nor when the cell already starts past the edge entirely.
    expect(computeExpandedEditorWidth(base({ x: 1200, desiredWidth: 5000, maxRight: 1000 }))).toBe(W);
  });

  it("collapses back to the cell when the entry shrinks again", () => {
    expect(computeExpandedEditorWidth(base({ desiredWidth: 200 }))).toBeGreaterThan(W);
    expect(computeExpandedEditorWidth(base({ desiredWidth: 20 }))).toBe(W);
  });
});

// ---------------------------------------------------------------------------
// Text measurement
// ---------------------------------------------------------------------------

describe("measureEditorTextWidth", () => {
  it("is zero for an empty entry", () => {
    expect(measureEditorTextWidth("", "12px sans-serif", 8)).toBe(0);
  });

  it("grows with the text", () => {
    const short = measureEditorTextWidth("ab", "12px sans-serif", 8);
    const long = measureEditorTextWidth("abcdefghij", "12px sans-serif", 8);
    expect(long).toBeGreaterThan(short);
  });

  it("measures the WIDEST line of a multi-line entry", () => {
    const w = measureEditorTextWidth("ab\nabcdefgh\nabc", "12px sans-serif", 8);
    expect(w).toBe(measureEditorTextWidth("abcdefgh", "12px sans-serif", 8));
  });
});

// ---------------------------------------------------------------------------
// Vertical growth
// ---------------------------------------------------------------------------

describe("countEditorLines", () => {
  it("counts an empty entry as one line", () => {
    expect(countEditorLines("")).toBe(1);
  });

  it("counts a single-line entry as one line", () => {
    expect(countEditorLines("hello")).toBe(1);
  });

  it("counts hard breaks", () => {
    expect(countEditorLines("a\nb\nc")).toBe(3);
  });

  it("counts a trailing newline as opening a new line", () => {
    // The caret really is on a third line after two Alt+Enters.
    expect(countEditorLines("a\n\n")).toBe(3);
  });

  it("does NOT try to count soft wraps", () => {
    // Soft wraps are the browser's business and are measured, never counted.
    // A long unbroken entry is one line here however wide the box is.
    expect(countEditorLines("x".repeat(500))).toBe(1);
  });
});

describe("computeExpandedEditorHeight", () => {
  function vbase(overrides: Partial<Parameters<typeof computeExpandedEditorHeight>[0]> = {}) {
    return { y: 24, baseHeight: H, lineCount: 1, maxBottom: 800, ...overrides };
  }

  it("is exactly the cell height for a single-line entry", () => {
    expect(computeExpandedEditorHeight(vbase())).toBe(H);
  });

  it("adds one line height per line", () => {
    // 20 + 2 * (20 - 4) = 52
    expect(computeExpandedEditorHeight(vbase({ lineCount: 3 }))).toBeCloseTo(52, 5);
  });

  it("collapses back to the cell height when the lines go away", () => {
    expect(computeExpandedEditorHeight(vbase({ lineCount: 4 }))).toBeGreaterThan(H);
    expect(computeExpandedEditorHeight(vbase({ lineCount: 1 }))).toBe(H);
  });

  it("clamps at the grid bottom rather than running off-screen", () => {
    const h = computeExpandedEditorHeight(vbase({ lineCount: 100, y: 700, maxBottom: 800 }));
    expect(h).toBe(100);
    expect(700 + h).toBeLessThanOrEqual(800);
  });

  it("never shrinks below the edited cell, even hard against the grid bottom", () => {
    expect(computeExpandedEditorHeight(vbase({ lineCount: 5, y: 795, maxBottom: 800 }))).toBe(H);
  });

  it("treats a nonsense line count as one line rather than collapsing", () => {
    expect(computeExpandedEditorHeight(vbase({ lineCount: 0 }))).toBe(H);
  });

  it("uses a per-line height that leaves one line filling an unexpanded box", () => {
    // The invariant that keeps a single-line edit looking identical to the
    // painted cell: line height + the 2px borders == the row height.
    expect(editorLineHeight(H) + EDITOR_VCHROME_PX).toBe(H);
  });

  it("grows a TALL row by that row's own line height, not a constant", () => {
    // A 40px row: 40 + 1 * 36 = 76. A hardcoded 16 would give 56.
    expect(computeExpandedEditorHeight(vbase({ baseHeight: 40, lineCount: 2 }))).toBeCloseTo(76, 5);
  });
});

describe("heightForMeasuredContent", () => {
  function mbase(overrides: Partial<Parameters<typeof heightForMeasuredContent>[0]> = {}) {
    return { y: 24, baseHeight: H, contentHeight: H - EDITOR_VCHROME_PX, maxBottom: 800, ...overrides };
  }

  it("adds the border back onto what the browser measured", () => {
    expect(heightForMeasuredContent(mbase({ contentHeight: 48 }))).toBe(52);
  });

  it("is exactly the row height for one measured line", () => {
    expect(heightForMeasuredContent(mbase())).toBe(H);
  });

  it("shrinks again when the measurement shrinks", () => {
    expect(heightForMeasuredContent(mbase({ contentHeight: 160 }))).toBeGreaterThan(H);
    expect(heightForMeasuredContent(mbase({ contentHeight: 16 }))).toBe(H);
  });

  it("clamps at the grid bottom, so even a runaway entry stays on the grid", () => {
    const h = heightForMeasuredContent(mbase({ contentHeight: 5000, y: 700, maxBottom: 800 }));
    expect(h).toBe(100);
  });

  it("never shrinks below the edited cell", () => {
    expect(heightForMeasuredContent(mbase({ contentHeight: 1 }))).toBe(H);
  });
});

describe("the two height paths agree", () => {
  // WHY THIS MATTERS: the counted path is what paints on the first frame of a
  // fresh editor, before the layout effect has measured anything, and it is the
  // only path in an environment with no layout engine. If the two disagreed the
  // box would visibly jump one line height the instant the measurement landed —
  // on every single cell the user starts editing.
  //
  // They agree by construction because one rendered line is
  // `editorLineHeight(baseHeight)` tall: N lines measure N*(baseHeight-4), and
  // N*(baseHeight-4)+4 is baseHeight+(N-1)*(baseHeight-4).
  for (const baseHeight of [20, 20.5, 40, 13]) {
    for (const lines of [1, 2, 3, 7, 40]) {
      it(`match at ${lines} line(s) in a ${baseHeight}px row`, () => {
        const counted = computeExpandedEditorHeight({
          y: 24,
          baseHeight,
          lineCount: lines,
          maxBottom: 100000,
        });
        const measured = heightForMeasuredContent({
          y: 24,
          baseHeight,
          contentHeight: lines * editorLineHeight(baseHeight),
          maxBottom: 100000,
        });
        expect(measured).toBeCloseTo(counted, 9);
      });
    }
  }
});

describe("clampEditorHeight", () => {
  it("is the single clamp both paths run through", () => {
    // Same bound, same floor, whichever way the desired height was arrived at.
    const args = { y: 700, baseHeight: H, maxBottom: 800 };
    expect(clampEditorHeight({ ...args, desiredHeight: 5000 })).toBe(100);
    expect(clampEditorHeight({ ...args, desiredHeight: 1 })).toBe(H);
    expect(clampEditorHeight({ ...args, desiredHeight: 60 })).toBe(60);
  });
});
