//! FILENAME: app/extensions/Pivot/lib/__tests__/getPivotDataPick.test.ts
// PURPOSE: The GETPIVOTDATA a formula-mode pick inserts. Found live 2026-09-29
//          (e2e fixall-edit W14): a pick on a pivot on ANOTHER sheet inserted
//          `=Pivots!E4`, never GETPIVOTDATA. The interceptor gated on the
//          cached pivot regions, which belong to the sheet the EDIT lives on --
//          a point-mode switch emits no SHEET_CHANGED -- so on the sheet the
//          grid actually showed it never asked the backend at all.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  foreign: false,
  cachedRegion: null as null | { pivotId: number },
  backend: vi.fn(),
  enabled: true,
}));

vi.mock("@api", () => ({
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
}));
vi.mock("@api/gridOverlays", () => ({ isPointModeOnForeignSheet: () => h.foreign }));
vi.mock("@api/locale", () => ({ getLocaleSettings: async () => ({ listSeparator: "," }) }));
vi.mock("../../handlers/selectionHandler", () => ({ findPivotRegionAtCell: () => h.cachedRegion }));
vi.mock("../pivot-api", () => ({ getPivotDataFormula: h.backend }));
vi.mock("../getPivotDataToggle", () => ({ isGenerateGetPivotDataEnabled: () => h.enabled }));

import { getPivotDataPick } from "../getPivotDataPick";

const ANSWER = { dataField: "Sum of Sales", fieldItemPairs: [["Region", "North"]] as Array<[string, string]> };

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

  it("on the edit's own sheet, a cached pivot cell asks the backend and builds the call", async () => {
    h.cachedRegion = { pivotId: 1 };
    const out = await getPivotDataPick(3, 4);
    expect(h.backend).toHaveBeenCalledWith(3, 4);
    expect(out).toEqual({
      text: 'GETPIVOTDATA("Sum of Sales",$E$4,"Region","North")',
      highlightRow: 3,
      highlightCol: 4,
    });
  });

  it("pointing at ANOTHER sheet, the cache (the edit's sheet) is not consulted: the backend decides", async () => {
    h.foreign = true;
    h.cachedRegion = null;
    const out = await getPivotDataPick(3, 4);
    expect(h.backend, "a pick on another sheet's pivot never asked the backend").toHaveBeenCalledWith(3, 4);
    expect(out?.text).toBe('GETPIVOTDATA("Sum of Sales",$E$4,"Region","North")');
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
    h.backend.mockResolvedValue({ dataField: 'Sum of "Net"', fieldItemPairs: [["Size", '12" pipe']] });
    expect((await getPivotDataPick(0, 0))?.text).toBe('GETPIVOTDATA("Sum of ""Net""",$A$1,"Size","12"" pipe")');
  });
});
