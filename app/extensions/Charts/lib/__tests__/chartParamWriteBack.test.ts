//! FILENAME: app/extensions/Charts/lib/__tests__/chartParamWriteBack.test.ts
// PURPOSE: A chart param's write-back (S7c) writes the ACTIVE sheet. On a
//          canvas sheet there are no cells and the backend refuses every cell
//          write -- so the write is not attempted and the reader is told, once
//          per burst, through the AWAITED async dialog (never window.alert).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  updateCell: vi.fn(async () => ({})),
  alertAsync: vi.fn<(m: string, o?: unknown) => Promise<void>>(() => Promise.resolve()),
  surface: "grid" as "grid" | "canvas",
}));

vi.mock("@api/lib", () => ({ updateCell: h.updateCell }));
vi.mock("@api/dialogs", () => ({ alertAsync: (m: string, o?: unknown) => h.alertAsync(m, o) }));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => ({ surface: h.surface }) }));
vi.mock("@api", () => ({ getSheets: vi.fn(), getNamedRange: vi.fn() }));

import { writeParamValueToCell, canvasParamWriteBackMessage } from "../chartParamWriteBack";

beforeEach(() => {
  h.updateCell.mockClear();
  h.alertAsync.mockReset();
  h.alertAsync.mockImplementation(() => Promise.resolve());
  h.surface = "grid";
});

describe("chart param write-back", () => {
  it("writes the active sheet's cell on a worksheet", () => {
    expect(writeParamValueToCell("=B2", "North", "Region")).toBe("written");
    expect(h.updateCell).toHaveBeenCalledWith(1, 1, "North");
    expect(h.alertAsync).not.toHaveBeenCalled();
  });

  it("skips a target that is not one same-sheet cell (unchanged S7c rule)", () => {
    expect(writeParamValueToCell("Sheet2!B2", "x")).toBe("skipped");
    expect(writeParamValueToCell("B2:C3", "x")).toBe("skipped");
    expect(h.updateCell).not.toHaveBeenCalled();
  });

  it("on a canvas: refuses WITHOUT attempting the write, and says why", () => {
    h.surface = "canvas";
    expect(writeParamValueToCell("=B2", "North", "Region")).toBe("refused");
    expect(h.updateCell).not.toHaveBeenCalled();
    expect(h.alertAsync).toHaveBeenCalledTimes(1);
    expect(h.alertAsync.mock.calls[0][0]).toBe(canvasParamWriteBackMessage("=B2", "Region"));
    expect(h.alertAsync.mock.calls[0][0]).toMatch(/canvas sheet, which has no cells/);
  });

  it("shows ONE box for a burst of clicks while it is open", async () => {
    h.surface = "canvas";
    let close!: () => void;
    h.alertAsync.mockImplementation(() => new Promise<void>((res) => { close = res; }));
    writeParamValueToCell("=B2", "a");
    writeParamValueToCell("=B2", "b");
    writeParamValueToCell("=B2", "c");
    expect(h.alertAsync).toHaveBeenCalledTimes(1);
    close();
    await new Promise((r) => setTimeout(r, 0));
    writeParamValueToCell("=B2", "d");
    expect(h.alertAsync).toHaveBeenCalledTimes(2);
  });
});
