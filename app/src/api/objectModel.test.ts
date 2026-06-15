//! FILENAME: app/src/api/objectModel.test.ts
// PURPOSE: Tests for the canonical shared object model navigation (C3) — that
//          Workbook navigates to Sheets, and a Sheet's range()/cell() produce
//          ranges BOUND to that sheet (step 2), so data ops target the right
//          sheet without activating it first.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./lib", () => ({
  getSheets: vi.fn(),
  setActiveSheet: vi.fn(),
  // range.ts (imported transitively via objectModel) pulls these from ./lib:
  getCell: vi.fn(),
  updateCellsBatch: vi.fn(),
  applyFormatting: vi.fn(),
  applyBorderPreset: vi.fn(),
  getActiveSheet: vi.fn(),
  getWatchCells: vi.fn(),
  updateCellOnSheets: vi.fn(),
}));
vi.mock("./grid", () => ({
  navigateToCell: vi.fn(),
  navigateToRange: vi.fn(),
  borderAround: vi.fn(),
}));

import { Workbook, Sheet } from "./objectModel";
import { getSheets, setActiveSheet } from "./lib";

const mGetSheets = vi.mocked(getSheets);
const mSetActive = vi.mocked(setActiveSheet);

const SHEETS = {
  activeIndex: 1,
  sheets: [
    { index: 0, name: "Intro", visibility: "visible", tabColor: undefined },
    { index: 1, name: "Data", visibility: "visible", tabColor: "#FF0000" },
    { index: 2, name: "Hidden", visibility: "hidden", tabColor: undefined },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mGetSheets.mockResolvedValue(SHEETS as never);
  mSetActive.mockResolvedValue(undefined as never);
});

describe("Sheet — range()/cell() bind the sheet (C3 step 2)", () => {
  it("range() binds the sheet's index onto the CellRange", () => {
    const sheet = new Sheet(2, "Hidden", "hidden");
    const r = sheet.range("A1:B5");
    expect(r.sheetIndex).toBe(2);
    expect(r.address).toBe("A1:B5");
  });

  it("cell() binds the sheet's index", () => {
    const sheet = new Sheet(2, "Hidden", "hidden");
    expect(sheet.cell(3, 4).sheetIndex).toBe(2);
  });

  it("activate() sets the active sheet to this index", async () => {
    const sheet = new Sheet(2, "Hidden", "hidden");
    await sheet.activate();
    expect(mSetActive).toHaveBeenCalledWith(2);
  });
});

describe("Workbook — navigation", () => {
  it("sheets() returns every sheet in tab order", async () => {
    const wb = new Workbook();
    const sheets = await wb.sheets();
    expect(sheets.map((s) => s.name)).toEqual(["Intro", "Data", "Hidden"]);
    expect(sheets[2].visibility).toBe("hidden");
  });

  it("activeSheet() returns the active one", async () => {
    const wb = new Workbook();
    const active = await wb.activeSheet();
    expect(active.index).toBe(1);
    expect(active.name).toBe("Data");
  });

  it("sheet() resolves by name and by index, null when absent", async () => {
    const wb = new Workbook();
    expect((await wb.sheet("Hidden"))?.index).toBe(2);
    expect((await wb.sheet(0))?.name).toBe("Intro");
    expect(await wb.sheet("Nope")).toBeNull();
    expect(await wb.sheet(9)).toBeNull();
  });

  it("a range navigated from a non-active sheet stays bound to it", async () => {
    const wb = new Workbook();
    const hidden = await wb.sheet("Hidden");
    expect(hidden).not.toBeNull();
    // bound to sheet 2 even though the active sheet is 1
    expect(hidden!.range("C3").sheetIndex).toBe(2);
  });
});
