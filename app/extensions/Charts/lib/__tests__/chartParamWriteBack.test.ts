//! FILENAME: app/extensions/Charts/lib/__tests__/chartParamWriteBack.test.ts
// PURPOSE: A chart param's write-back (S7c) with NO placed chart named writes
//          the ACTIVE sheet. On a canvas sheet there are no cells and the
//          backend refuses every cell write -- so the write is not attempted
//          and the reader is told, once per burst, through the AWAITED async
//          dialog (never window.alert). (A PLACED chart writes the sheet it
//          reads -- its own, or on a canvas its data sheet: see
//          chartParamCanvasSheet.test.ts.)

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  updateCell: vi.fn(async () => ({})),
  alertAsync: vi.fn<(m: string, o?: unknown) => Promise<void>>(() => Promise.resolve()),
  surface: "grid" as "grid" | "canvas",
}));

vi.mock("@api/lib", () => ({ updateCell: h.updateCell }));
vi.mock("@api/range", () => ({ CellRange: { fromCell: vi.fn() } }));
vi.mock("@api/dialogs", () => ({ alertAsync: (m: string, o?: unknown) => h.alertAsync(m, o) }));
vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => ({ surface: h.surface, sheetContext: { activeSheetIndex: 0, activeSheetName: "S" } }),
}));
vi.mock("@api", () => ({ getSheets: vi.fn(), getNamedRange: vi.fn() }));

import { writeParamValueToCell, canvasParamWriteBackMessage } from "../chartParamWriteBack";

beforeEach(() => {
  h.updateCell.mockClear();
  h.alertAsync.mockReset();
  h.alertAsync.mockImplementation(() => Promise.resolve());
  h.surface = "grid";
});

describe("chart param write-back (no placed chart: the active sheet)", () => {
  it("writes the active sheet's cell on a worksheet", async () => {
    expect(await writeParamValueToCell("=B2", "North", "Region")).toBe("written");
    expect(h.updateCell).toHaveBeenCalledWith(1, 1, "North");
    expect(h.alertAsync).not.toHaveBeenCalled();
  });

  it("skips a target that is not one unqualified cell (unchanged S7c rule)", async () => {
    expect(await writeParamValueToCell("Sheet2!B2", "x")).toBe("skipped");
    expect(await writeParamValueToCell("B2:C3", "x")).toBe("skipped");
    expect(h.updateCell).not.toHaveBeenCalled();
  });

  it("on a canvas: refuses WITHOUT attempting the write, and says why", async () => {
    h.surface = "canvas";
    expect(await writeParamValueToCell("=B2", "North", "Region")).toBe("refused");
    expect(h.updateCell).not.toHaveBeenCalled();
    expect(h.alertAsync).toHaveBeenCalledTimes(1);
    expect(h.alertAsync.mock.calls[0][0]).toBe(canvasParamWriteBackMessage("=B2", "Region"));
    expect(h.alertAsync.mock.calls[0][0]).toMatch(/canvas sheet, which has no cells/);
  });

  it("shows ONE box for a burst of clicks while it is open", async () => {
    h.surface = "canvas";
    let close!: () => void;
    h.alertAsync.mockImplementation(() => new Promise<void>((res) => { close = res; }));
    await writeParamValueToCell("=B2", "a");
    await writeParamValueToCell("=B2", "b");
    await writeParamValueToCell("=B2", "c");
    expect(h.alertAsync).toHaveBeenCalledTimes(1);
    close();
    await new Promise((r) => setTimeout(r, 0));
    await writeParamValueToCell("=B2", "d");
    expect(h.alertAsync).toHaveBeenCalledTimes(2);
  });
});
