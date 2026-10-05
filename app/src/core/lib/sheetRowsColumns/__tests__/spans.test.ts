//! FILENAME: app/src/core/lib/sheetRowsColumns/__tests__/spans.test.ts
// PURPOSE: The rows / columns a selection SPANS, whatever its shape -- the
//          answer Excel's Insert / Delete Sheet Rows / Columns act on.
// CONTEXT: The four grid commands did nothing unless WHOLE rows or columns were
//          selected (`selection.type !== "rows"` returned early), so the Home
//          tab's buttons were dead on an ordinary cell selection and still
//          reported success. Every expectation below is what live Excel did
//          (Microsoft 365 build 20326, 2026-10-04, `EntireRow.Insert` /
//          `EntireRow.Delete` on the selection; see the core-grid report).

import { describe, it, expect } from "vitest";
import type { Selection } from "../../../types";
import { sheetSpans } from "../spans";

function sel(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  extra?: Selection["additionalRanges"],
  type: Selection["type"] = "cells",
): Selection {
  return { startRow, startCol, endRow, endCol, type, additionalRanges: extra };
}

describe("sheetSpans: the rows a selection spans", () => {
  it("a cell range spans its rows (Excel: B3:C4 inserts two rows above row 3)", () => {
    expect(sheetSpans(sel(2, 1, 3, 2), "rows")).toEqual({ ok: true, spans: [{ start: 2, count: 2 }] });
  });

  it("a range drawn upwards is normalised", () => {
    expect(sheetSpans(sel(5, 3, 2, 1), "rows")).toEqual({ ok: true, spans: [{ start: 2, count: 4 }] });
  });

  it("one cell spans one row", () => {
    expect(sheetSpans(sel(7, 4, 7, 4), "rows")).toEqual({ ok: true, spans: [{ start: 7, count: 1 }] });
  });

  it("whole rows (the context-menu path) span exactly those rows", () => {
    expect(sheetSpans(sel(1, 0, 3, 16383, undefined, "rows"), "rows")).toEqual({
      ok: true,
      spans: [{ start: 1, count: 3 }],
    });
  });

  it("each Ctrl+click block is its own span, in sheet order (Excel: A2,A5 -> rows above 2 and 5)", () => {
    expect(sheetSpans(sel(4, 0, 4, 0, [{ startRow: 1, startCol: 0, endRow: 1, endCol: 0 }]), "rows")).toEqual({
      ok: true,
      spans: [
        { start: 1, count: 1 },
        { start: 4, count: 1 },
      ],
    });
  });

  it("blocks of different heights keep their own counts (Excel: B2:B3,D6)", () => {
    expect(sheetSpans(sel(5, 3, 5, 3, [{ startRow: 1, startCol: 1, endRow: 2, endCol: 1 }]), "rows")).toEqual({
      ok: true,
      spans: [
        { start: 1, count: 2 },
        { start: 5, count: 1 },
      ],
    });
  });

  it("two blocks on the SAME row overlap, and Excel refuses (A3,C3)", () => {
    expect(sheetSpans(sel(2, 2, 2, 2, [{ startRow: 2, startCol: 0, endRow: 2, endCol: 0 }]), "rows")).toEqual({
      ok: false,
      reason: "overlap",
    });
  });

  it("blocks whose rows only partly overlap are refused too", () => {
    expect(sheetSpans(sel(2, 2, 4, 2, [{ startRow: 1, startCol: 0, endRow: 2, endCol: 0 }]), "rows")).toEqual({
      ok: false,
      reason: "overlap",
    });
  });

  it("ADJACENT blocks do not overlap: each keeps its own span", () => {
    expect(sheetSpans(sel(2, 0, 2, 0, [{ startRow: 1, startCol: 0, endRow: 1, endCol: 0 }]), "rows")).toEqual({
      ok: true,
      spans: [
        { start: 1, count: 1 },
        { start: 2, count: 1 },
      ],
    });
  });

  it("the same cell Ctrl+clicked twice is one block, not an overlap", () => {
    expect(sheetSpans(sel(3, 1, 3, 1, [{ startRow: 3, startCol: 1, endRow: 3, endCol: 1 }]), "rows")).toEqual({
      ok: true,
      spans: [{ start: 3, count: 1 }],
    });
  });

  it("no selection spans nothing", () => {
    expect(sheetSpans(null, "rows")).toEqual({ ok: true, spans: [] });
  });
});

describe("sheetSpans: the columns a selection spans", () => {
  it("a cell range spans its columns", () => {
    expect(sheetSpans(sel(2, 1, 3, 2), "columns")).toEqual({ ok: true, spans: [{ start: 1, count: 2 }] });
  });

  it("Ctrl+click blocks on one ROW are separate columns (Excel: B2,E2), not an overlap", () => {
    expect(sheetSpans(sel(1, 4, 1, 4, [{ startRow: 1, startCol: 1, endRow: 1, endCol: 1 }]), "columns")).toEqual({
      ok: true,
      spans: [
        { start: 1, count: 1 },
        { start: 4, count: 1 },
      ],
    });
  });

  it("two blocks in the same column overlap for the column commands", () => {
    expect(sheetSpans(sel(5, 2, 5, 2, [{ startRow: 1, startCol: 2, endRow: 1, endCol: 2 }]), "columns")).toEqual({
      ok: false,
      reason: "overlap",
    });
  });
});
