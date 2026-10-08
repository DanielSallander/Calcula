//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerClearProvider.test.ts
// PURPOSE: The Slicer extension's half of "Clear all slicers" (Canvas contract
//          §4.4, @api/slicerClearService): on ONE sheet, every slicer that
//          carries a filter is cleared through the same queued user click the
//          slicer's own Clear button makes (one landed undo step each, an
//          overwrite question when a pivot would be overwritten); a slicer
//          that is already unfiltered, or on another sheet, is left alone; the
//          answer is how many were cleared.

import { describe, it, expect } from "vitest";
import { createSlicerClearProvider } from "../slicerClearProvider";

type S = { id: string; sheetIndex: number; selectedItems: string[] | null };

function provider(slicers: S[]) {
  const clicked: string[] = [];
  const p = createSlicerClearProvider({
    getSlicersForSheet: (sheetIndex: number) => slicers.filter((s) => s.sheetIndex === sheetIndex),
    clickSlicerClearFilter: async (id: string) => {
      clicked.push(id);
    },
  });
  return { p, clicked };
}

describe("the slicer clear provider", () => {
  // SABOTAGE: drop the isSlicerFiltered filter -> unfiltered slicers are
  // "cleared" too (an undo step each that changes nothing).
  it("clears every FILTERED slicer on the sheet, and counts them", async () => {
    const { p, clicked } = provider([
      { id: "region", sheetIndex: 2, selectedItems: ["North"] },
      { id: "year", sheetIndex: 2, selectedItems: null },
      { id: "product", sheetIndex: 2, selectedItems: [] },
      { id: "elsewhere", sheetIndex: 0, selectedItems: ["A"] },
    ]);
    expect(await p.clearSlicersOnSheet(2)).toBe(2);
    expect(clicked).toEqual(["region", "product"]);
  });

  it("clears nothing on a sheet without filtered slicers", async () => {
    const { p, clicked } = provider([{ id: "year", sheetIndex: 1, selectedItems: null }]);
    expect(await p.clearSlicersOnSheet(1)).toBe(0);
    expect(clicked).toEqual([]);
  });

  // One click at a time: the store's click queue already serialises them, but
  // the provider awaits each so its count is a count of LANDED clears.
  it("waits for each clear before the next", async () => {
    const order: string[] = [];
    const p = createSlicerClearProvider({
      getSlicersForSheet: () => [
        { id: "a", sheetIndex: 0, selectedItems: ["x"] },
        { id: "b", sheetIndex: 0, selectedItems: ["y"] },
      ],
      clickSlicerClearFilter: async (id: string) => {
        order.push(`start:${id}`);
        await new Promise((r) => setTimeout(r, 0));
        order.push(`end:${id}`);
      },
    });
    await p.clearSlicersOnSheet(0);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });
});
