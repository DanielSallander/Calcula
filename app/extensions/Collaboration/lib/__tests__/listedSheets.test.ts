import { describe, expect, it } from "vitest";
import { keysAt, listedIndices, sheetKey, tickedSheets } from "../listedSheets";

describe("listedIndices", () => {
  it("drops an index the checkbox list does not show (a floating range's backing sheet)", () => {
    const sheets = [{ index: 0 }, { index: 1 }];
    expect(listedIndices([0, 1, 2], sheets)).toEqual([0, 1]);
  });

  it("sorts, and passes everything through while the list has not loaded", () => {
    expect(listedIndices(new Set([3, 1]), undefined)).toEqual([1, 3]);
  });

  it("an empty list admits nothing", () => {
    expect(listedIndices([0, 2], [])).toEqual([]);
  });
});

// Review round 9: a tick is its sheet's STABLE id, so it follows the sheet
// through a move, a copy and a delete made while the non-modal dialog is open.
describe("ticks by stable id", () => {
  const before = [
    { index: 0, sheetId: "id-summary", name: "Summary" },
    { index: 1, sheetId: "id-private", name: "Private" },
    { index: 2, sheetId: "id-dashboard", name: "Dashboard" },
  ];
  /** The same workbook after Private was dragged to the front. */
  const moved = [
    { index: 0, sheetId: "id-private", name: "Private" },
    { index: 1, sheetId: "id-summary", name: "Summary" },
    { index: 2, sheetId: "id-dashboard", name: "Dashboard" },
  ];

  // SABOTAGE: key by position (`#${index}`) -- the ticks then land on Private.
  it("a tick stays on its sheet when the list is renumbered", () => {
    const ticks = new Set([sheetKey(before[0]), sheetKey(before[2])]);
    expect(tickedSheets(ticks, moved).map((s) => s.name)).toEqual(["Summary", "Dashboard"]);
  });

  it("a ticked sheet that left the list ticks nothing", () => {
    const ticks = new Set(["id-summary", "id-gone"]);
    expect(tickedSheets(ticks, before).map((s) => s.name)).toEqual(["Summary"]);
  });

  it("a row with no id is keyed by its position, the only name it has", () => {
    expect(sheetKey({ index: 3, sheetId: "" })).toBe("#3");
    expect(sheetKey({ index: 3, sheetId: "id-x" })).toBe("id-x");
  });

  it("positions are read against the list from the SAME answer, and an unlisted one has no key", () => {
    expect(keysAt([2, 0, 7], before)).toEqual(["id-summary", "id-dashboard"]);
    expect(keysAt([0], moved)).toEqual(["id-private"]);
  });
});
