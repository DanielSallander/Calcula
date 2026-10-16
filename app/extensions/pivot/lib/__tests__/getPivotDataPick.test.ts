//! FILENAME: app/extensions/Pivot/lib/__tests__/getPivotDataPick.test.ts
// PURPOSE: The GETPIVOTDATA a formula-mode pick inserts. Found live 2026-09-29
//          (e2e fixall-edit W14): a pick on a pivot on ANOTHER sheet inserted
//          `=Pivots!E4`, never GETPIVOTDATA. The interceptor gated on the
//          cached pivot regions, which belong to the sheet the EDIT lives on --
//          a point-mode switch emits no SHEET_CHANGED -- so on the sheet the
//          grid actually showed it never asked the backend at all.
//          The pivot_table argument is the pivot's ANCHOR (definition.destination,
//          transported as pivotAnchorRow/Col), never the clicked cell: Excel's
//          spelling, on a worksheet and on a canvas alike (D-PICK).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  foreign: false,
  cachedRegion: null as null | { pivotId: number },
  backend: vi.fn(),
  enabled: true,
}));

vi.mock("@api", () => ({
  // The real bijective base-26 spelling (a canvas block starts at column 1024 = AMK).
  columnToLetter: (col: number) => {
    let out = "";
    for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    return out;
  },
}));
vi.mock("@api/gridOverlays", () => ({ isPointModeOnForeignSheet: () => h.foreign }));
vi.mock("@api/locale", () => ({ getLocaleSettings: async () => ({ listSeparator: "," }) }));
vi.mock("../../handlers/selectionHandler", () => ({ findPivotRegionAtCell: () => h.cachedRegion }));
vi.mock("../pivot-api", () => ({ getPivotDataFormula: h.backend }));
vi.mock("../getPivotDataToggle", () => ({ isGenerateGetPivotDataEnabled: () => h.enabled }));

import { getPivotDataPick } from "../getPivotDataPick";

/** The pivot is anchored at D2 (row 1, col 3); the picks below land elsewhere in it. */
const ANSWER = {
  dataField: "Sum of Sales",
  fieldItemPairs: [["Region", "North"]] as Array<[string, string]>,
  pivotAnchorRow: 1,
  pivotAnchorCol: 3,
};

beforeEach(() => {
  h.foreign = false;
  h.cachedRegion = null;
  h.enabled = true;
  h.backend.mockReset();
  h.backend.mockResolvedValue(ANSWER);
});

describe("getPivotDataPick", () => {
  it("on the edit's own sheet, a cell in no cached pivot region is a plain reference (no backend round trip)", async () => {
    expect(await getPivotDataPick(3, 4)).toBeNull();
    expect(h.backend).not.toHaveBeenCalled();
  });

  it("on the edit's own sheet, a cached pivot cell asks the backend and builds the call on the pivot's ANCHOR", async () => {
    h.cachedRegion = { pivotId: 1 };
    const out = await getPivotDataPick(3, 4);
    expect(h.backend).toHaveBeenCalledWith(3, 4);
    expect(out).toEqual({
      text: 'GETPIVOTDATA("Sum of Sales",$D$2,"Region","North")',
      highlightRow: 1,
      highlightCol: 3,
    });
  });

  it("the clicked cell is never the pivot_table argument: two picks in one pivot name the same anchor", async () => {
    h.cachedRegion = { pivotId: 1 };
    const a = await getPivotDataPick(3, 4); // E4
    const b = await getPivotDataPick(7, 5); // F8
    expect(a?.text).toContain(",$D$2,");
    expect(b?.text).toContain(",$D$2,");
    expect(a?.text, "the clicked cell E4 leaked into the call").not.toContain("$E$4");
    expect(b?.text, "the clicked cell F8 leaked into the call").not.toContain("$F$8");
    // The highlight follows the text's reference, so Core can find and qualify it.
    expect([b?.highlightRow, b?.highlightCol]).toEqual([1, 3]);
  });

  it("a canvas pivot in column block 1 is anchored at its own block (row 0, col 1024 = AMK1)", async () => {
    h.cachedRegion = { pivotId: 2 };
    h.backend.mockResolvedValue({ ...ANSWER, pivotAnchorRow: 0, pivotAnchorCol: 1024 });
    const out = await getPivotDataPick(5, 1026);
    expect(out?.text).toBe('GETPIVOTDATA("Sum of Sales",$AMK$1,"Region","North")');
    expect([out?.highlightRow, out?.highlightCol]).toEqual([0, 1024]);
  });

  it("pointing at ANOTHER sheet, the cache (the edit's sheet) is not consulted: the backend decides", async () => {
    h.foreign = true;
    h.cachedRegion = null;
    const out = await getPivotDataPick(3, 4);
    expect(h.backend, "a pick on another sheet's pivot never asked the backend").toHaveBeenCalledWith(3, 4);
    expect(out?.text).toBe('GETPIVOTDATA("Sum of Sales",$D$2,"Region","North")');
  });

  it("pointing at another sheet, a cell the backend finds no pivot at is a plain reference", async () => {
    h.foreign = true;
    h.backend.mockResolvedValue(null);
    expect(await getPivotDataPick(3, 4)).toBeNull();
  });

  it("the toggle off is a plain reference everywhere", async () => {
    h.enabled = false;
    h.foreign = true;
    expect(await getPivotDataPick(3, 4)).toBeNull();
    expect(h.backend).not.toHaveBeenCalled();
  });

  it("a quote inside a field or item name is doubled, so the call still parses", async () => {
    h.cachedRegion = { pivotId: 1 };
    h.backend.mockResolvedValue({
      dataField: 'Sum of "Net"',
      fieldItemPairs: [["Size", '12" pipe']],
      pivotAnchorRow: 0,
      pivotAnchorCol: 0,
    });
    expect((await getPivotDataPick(0, 0))?.text).toBe('GETPIVOTDATA("Sum of ""Net""",$A$1,"Size","12"" pipe")');
  });
});
