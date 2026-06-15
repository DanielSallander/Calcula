// PURPOSE: Cover the C3 first increment — the Workbook/Sheet object model
//          (api/objectModel.ts) over the CellRange seed.

import { describe, it, expect, vi, beforeEach } from "vitest";

// objectModel + CellRange reach the backend through ./lib and ./grid; stub them
// so the navigation logic is tested in isolation (no Tauri).
vi.mock("../lib", () => ({
  getSheets: vi.fn(),
  setActiveSheet: vi.fn().mockResolvedValue(undefined),
  getCell: vi.fn(),
  updateCellsBatch: vi.fn(),
  applyFormatting: vi.fn(),
  applyBorderPreset: vi.fn(),
}));
vi.mock("../grid", () => ({
  navigateToCell: vi.fn(),
  navigateToRange: vi.fn(),
  borderAround: vi.fn(),
}));

import { getSheets, setActiveSheet } from "../lib";
import { Workbook, Sheet } from "../objectModel";
import { CellRange } from "../range";

const SHEETS = {
  sheets: [
    { index: 0, name: "Sheet1", visibility: "visible" as const },
    { index: 1, name: "Data", visibility: "visible" as const, tabColor: "#ff0000" },
    { index: 2, name: "Hidden", visibility: "hidden" as const },
  ],
  activeIndex: 1,
};

beforeEach(() => {
  vi.mocked(getSheets).mockResolvedValue(SHEETS);
  vi.mocked(setActiveSheet).mockClear();
});

describe("Workbook (C3 object model)", () => {
  const wb = new Workbook();

  it("sheets() maps the sheet list in tab order", async () => {
    const sheets = await wb.sheets();
    expect(sheets.map((s) => s.name)).toEqual(["Sheet1", "Data", "Hidden"]);
    expect(sheets[1]).toBeInstanceOf(Sheet);
    expect(sheets[1].index).toBe(1);
    expect(sheets[1].tabColor).toBe("#ff0000");
    expect(sheets[2].visibility).toBe("hidden");
  });

  it("activeSheet() returns the sheet at activeIndex", async () => {
    const active = await wb.activeSheet();
    expect(active.name).toBe("Data");
    expect(active.index).toBe(1);
  });

  it("sheet(name) and sheet(index) find the right sheet; missing -> null", async () => {
    expect((await wb.sheet("Data"))?.index).toBe(1);
    expect((await wb.sheet(2))?.name).toBe("Hidden");
    expect(await wb.sheet("Nope")).toBeNull();
    expect(await wb.sheet(99)).toBeNull();
  });
});

describe("Sheet (C3 object model)", () => {
  const sheet = new Sheet(1, "Data", "visible");

  it("range() returns a CellRange at the given address", () => {
    const r = sheet.range("A1:B5");
    expect(r).toBeInstanceOf(CellRange);
    expect(r.address).toBe("A1:B5");
  });

  it("cell() returns a single-cell CellRange", () => {
    const c = sheet.cell(2, 3);
    expect(c).toBeInstanceOf(CellRange);
    expect(c.isSingleCell).toBe(true);
    expect(c.address).toBe("D3");
  });

  it("activate() sets this sheet active by index", async () => {
    await sheet.activate();
    expect(setActiveSheet).toHaveBeenCalledWith(1);
  });
});
