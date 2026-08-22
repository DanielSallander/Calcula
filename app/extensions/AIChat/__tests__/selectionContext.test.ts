//! FILENAME: app/extensions/AIChat/__tests__/selectionContext.test.ts
// PURPOSE: "Format each selected cell" must reach the model as coordinates.
// CONTEXT: The reported failure had the model inventing `["A1","B3","C5"]`
//          because nothing in the tool surface or the prompt exposed the
//          selection. These pin the shape the Shell actually emits.

import { describe, it, expect, beforeEach } from "vitest";
import {
  readSelectionPayload, describeSelection, withSelection,
  __setSelectionForTest, currentSelection,
} from "../lib/selectionContext";

/** The payload shape `ExtensionRegistry` emits on AppEvents.SELECTION_CHANGED. */
const payload = (areas: Array<[number, number, number, number]>, sheetIndex = 0) => ({
  row: areas[0]?.[2], col: areas[0]?.[3],
  startRow: areas[0]?.[0], startCol: areas[0]?.[1],
  endRow: areas[0]?.[2], endCol: areas[0]?.[3],
  sheetIndex,
  areas: areas.map(([startRow, startCol, endRow, endCol]) => ({ startRow, startCol, endRow, endCol })),
});

beforeEach(() => __setSelectionForTest(null));

describe("readSelectionPayload", () => {
  it("reads a single-area selection", () => {
    const snap = readSelectionPayload(payload([[2, 1, 5, 1]]));
    expect(snap).toEqual({ sheetIndex: 0, areas: [{ startRow: 2, startCol: 1, endRow: 5, endCol: 1 }] });
  });

  it("reads every area of a multi-area (Ctrl+Click) selection", () => {
    const snap = readSelectionPayload(payload([[2, 1, 5, 1], [8, 0, 8, 2]], 3));
    expect(snap?.sheetIndex).toBe(3);
    expect(snap?.areas).toHaveLength(2);
  });

  it("normalizes a selection dragged upward or leftward", () => {
    // start > end reaches the model as "rows 9 to 2", and the loop it writes
    // runs zero times.
    const snap = readSelectionPayload(payload([[9, 4, 2, 1]]));
    expect(snap?.areas[0]).toEqual({ startRow: 2, startCol: 1, endRow: 9, endCol: 4 });
  });

  it("treats a cleared selection as none", () => {
    expect(readSelectionPayload(null)).toBeNull();
    expect(readSelectionPayload(undefined)).toBeNull();
  });

  it("treats a malformed or partial payload as none rather than guessing", () => {
    expect(readSelectionPayload({})).toBeNull();
    expect(readSelectionPayload({ areas: [] })).toBeNull();
    expect(readSelectionPayload({ areas: [{ startRow: 1 }] })).toBeNull();
    expect(readSelectionPayload({ areas: [{ startRow: NaN, startCol: 0, endRow: 1, endCol: 1 }] })).toBeNull();
    expect(readSelectionPayload("B2:B6")).toBeNull();
  });

  it("defaults a missing sheetIndex to 0 rather than dropping the selection", () => {
    const snap = readSelectionPayload({ areas: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }] });
    expect(snap?.sheetIndex).toBe(0);
  });
});

describe("describeSelection", () => {
  it("gives BOTH A1 and 0-based coordinates", () => {
    // The tools are 0-based; a drafted script is read by a human in A1. Giving
    // one spelling means the model converts, and that conversion is where a
    // small model goes off by one.
    const line = describeSelection({ sheetIndex: 0, areas: [{ startRow: 2, startCol: 1, endRow: 5, endCol: 1 }] });
    expect(line).toContain("B3:B6");
    expect(line).toContain("rows 2-5");
    expect(line).toContain("columns 1-1");
    expect(line).toContain("0-based");
    expect(line).toContain("sheet index 0");
  });

  it("collapses a single cell to one A1 address", () => {
    const line = describeSelection({ sheetIndex: 0, areas: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }] });
    expect(line).toContain("A1");
    expect(line).not.toContain("A1:A1");
  });

  it("names every area when there is more than one", () => {
    const line = describeSelection({
      sheetIndex: 1,
      areas: [{ startRow: 2, startCol: 1, endRow: 5, endCol: 1 }, { startRow: 8, startCol: 0, endRow: 8, endCol: 2 }],
    });
    expect(line).toContain("2 areas");
    expect(line).toContain("B3:B6");
    expect(line).toContain("A9:C9");
  });

  it("is null when there is no selection", () => {
    expect(describeSelection(null)).toBeNull();
    expect(describeSelection({ sheetIndex: 0, areas: [] })).toBeNull();
  });
});

describe("withSelection", () => {
  it("appends the line to the prompt when there is a selection", () => {
    __setSelectionForTest({ sheetIndex: 0, areas: [{ startRow: 0, startCol: 0, endRow: 2, endCol: 0 }] });
    expect(currentSelection()).not.toBeNull();
    const out = withSelection("BASE PROMPT");
    expect(out.startsWith("BASE PROMPT")).toBe(true);
    expect(out).toContain("A1:A3");
  });

  it("returns the prompt unchanged when there is none - never a fabricated range", () => {
    __setSelectionForTest(null);
    expect(withSelection("BASE PROMPT")).toBe("BASE PROMPT");
  });
});
