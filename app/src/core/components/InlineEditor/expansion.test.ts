//! FILENAME: app/src/core/components/InlineEditor/expansion.test.ts
// PURPOSE: The arithmetic of the inline editor's Excel-parity expansion.
// CONTEXT: Exact-pixel assertions live here; the component test next door drives
//          the same rules through the real editor. The two rules that matter are
//          "never over data" and "never past the viewport", and both are stated
//          as failures, not as happy paths.

import { describe, it, expect } from "vitest";
import {
  computeExpandedEditorWidth,
  computeExpandedEditorHeight,
  countEditorLines,
  editorLineHeight,
  measureEditorTextWidth,
} from "./expansion";

/** The real default: 64.29px columns, the width that exposed the gap. */
const W = 64.29;

function base(overrides: Partial<Parameters<typeof computeExpandedEditorWidth>[0]> = {}) {
  return {
    x: 50,
    baseWidth: W,
    desiredWidth: W,
    neighbourWidths: [W, W, W, W],
    neighbourOccupied: [false, false, false, false],
    maxRight: 1000,
    ...overrides,
  };
}

describe("computeExpandedEditorWidth", () => {
  it("does not expand when the entry fits its own cell", () => {
    expect(computeExpandedEditorWidth(base({ desiredWidth: 40 }))).toBe(W);
    expect(computeExpandedEditorWidth(base({ desiredWidth: W }))).toBe(W);
  });

  it("expands over EMPTY neighbours, hugging the text", () => {
    // Needs 150px: one whole neighbour (128.58) is not enough, two are.
    expect(computeExpandedEditorWidth(base({ desiredWidth: 150 }))).toBeCloseTo(150, 6);
  });

  it("stops at the first OCCUPIED neighbour, however much room the text wants", () => {
    const width = computeExpandedEditorWidth(
      base({ desiredWidth: 500, neighbourOccupied: [false, true, false, false] }),
    );
    // One empty neighbour was covered; the second holds data and is not touched.
    expect(width).toBeCloseTo(W * 2, 6);
  });

  it("never covers the IMMEDIATE neighbour when it holds data", () => {
    const width = computeExpandedEditorWidth(
      base({ desiredWidth: 500, neighbourOccupied: [true, false, false, false] }),
    );
    expect(width).toBe(W);
  });

  it("treats an UNKNOWN neighbour as occupied", () => {
    // A lookup that has not answered yet supplies no flags at all.
    const width = computeExpandedEditorWidth(
      base({ desiredWidth: 500, neighbourOccupied: [] }),
    );
    expect(width).toBe(W);
    // ...and one known-empty followed by unknowns stops after the known one.
    expect(
      computeExpandedEditorWidth(base({ desiredWidth: 500, neighbourOccupied: [false] })),
    ).toBeCloseTo(W * 2, 6);
  });

  it("clamps at the viewport edge", () => {
    // Editor starts at x=900 with a 1000px viewport: 100px of room, no more,
    // even though four empty neighbours and a very long entry ask for more.
    const width = computeExpandedEditorWidth(
      base({ x: 900, desiredWidth: 5000, maxRight: 1000 }),
    );
    expect(width).toBe(100);
  });

  it("never shrinks below the edited cell, even hard against the viewport edge", () => {
    const width = computeExpandedEditorWidth(
      base({ x: 990, desiredWidth: 5000, maxRight: 1000 }),
    );
    expect(width).toBe(W);
  });

  it("collapses back to the cell when the entry shrinks again", () => {
    const grown = computeExpandedEditorWidth(base({ desiredWidth: 200 }));
    expect(grown).toBeGreaterThan(W);
    const shrunk = computeExpandedEditorWidth(base({ desiredWidth: 20 }));
    expect(shrunk).toBe(W);
  });

  it("cannot expand past the last neighbour it was given", () => {
    const width = computeExpandedEditorWidth(
      base({ desiredWidth: 5000, neighbourWidths: [W], neighbourOccupied: [false] }),
    );
    expect(width).toBeCloseTo(W * 2, 6);
  });
});

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
// Vertical expansion (Alt+Enter)
// ---------------------------------------------------------------------------

/** The real default row height. */
const H = 20;

describe("countEditorLines", () => {
  it("counts an empty entry as one line", () => {
    expect(countEditorLines("")).toBe(1);
  });

  it("counts a single-line entry as one line", () => {
    expect(countEditorLines("hello")).toBe(1);
  });

  it("counts hard breaks, not soft wraps", () => {
    expect(countEditorLines("a\nb\nc")).toBe(3);
  });

  it("counts a trailing newline as opening a new line", () => {
    // The caret really is on a third line after two Alt+Enters.
    expect(countEditorLines("a\n\n")).toBe(3);
  });
});

describe("computeExpandedEditorHeight", () => {
  function vbase(overrides: Partial<Parameters<typeof computeExpandedEditorHeight>[0]> = {}) {
    return {
      y: 24,
      baseHeight: H,
      lineCount: 1,
      maxBottom: 800,
      ...overrides,
    };
  }

  it("is exactly the cell height for a single-line entry", () => {
    expect(computeExpandedEditorHeight(vbase())).toBe(H);
  });

  it("adds one line height per hard break", () => {
    // 20 + 2 * (20 - 4) = 52
    expect(computeExpandedEditorHeight(vbase({ lineCount: 3 }))).toBeCloseTo(52, 5);
  });

  it("collapses back to the cell height when the breaks are removed", () => {
    expect(computeExpandedEditorHeight(vbase({ lineCount: 4 }))).toBeGreaterThan(H);
    expect(computeExpandedEditorHeight(vbase({ lineCount: 1 }))).toBe(H);
  });

  it("clamps at the viewport bottom rather than running off-screen", () => {
    const h = computeExpandedEditorHeight(vbase({ lineCount: 100, y: 700, maxBottom: 800 }));
    expect(h).toBe(100);
    expect(700 + h).toBeLessThanOrEqual(800);
  });

  it("never shrinks below the edited cell, even hard against the viewport bottom", () => {
    // The row is already past the bottom edge: the box stays cell-sized rather
    // than collapsing to nothing (or going negative).
    expect(computeExpandedEditorHeight(vbase({ lineCount: 5, y: 795, maxBottom: 800 }))).toBe(H);
  });

  it("uses a per-line height that leaves one line filling an unexpanded box", () => {
    // This is the invariant that keeps a single-line edit looking identical to
    // the painted cell: line height + the 2px borders == the row height.
    expect(editorLineHeight(H) + 4).toBe(H);
  });

  it("grows a TALL row by that row's own line height, not a constant", () => {
    // A 40px row: 40 + 1 * 36 = 76. A hardcoded 16 would give 56.
    expect(computeExpandedEditorHeight(vbase({ baseHeight: 40, lineCount: 2 }))).toBeCloseTo(76, 5);
  });
});
