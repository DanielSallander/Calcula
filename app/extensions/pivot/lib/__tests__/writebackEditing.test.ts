//! FILENAME: app/extensions/Pivot/lib/__tests__/writebackEditing.test.ts
// PURPOSE: A value typed into a BI pivot's writeback column is read in the APP
//          locale (P2 S9, map C8). A NUMBER column's input is parsed strictly
//          there and sent as the invariant number Rust parses; the foreign
//          spelling is refused instead of reaching the backend's lenient
//          reader; a TEXT column's input goes exactly as typed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const setValue = vi.fn<(c: string, w: string, k: string[], v: string | null) => Promise<void>>();

vi.mock("@api", () => ({
  biWritebackListColumns: vi.fn(async () => []),
  biWritebackSetValue: (c: string, w: string, k: string[], v: string | null) => setValue(c, w, k, v),
}));
vi.mock("../pivot-api", () => ({ getPivotAtCell: vi.fn() }));
vi.mock("../pivotViewStore", () => ({ getCachedPivotView: vi.fn(), getCellWindowCache: vi.fn() }));

import { useAppLocale, useInvariantLocale } from "../../../Charts/lib/__tests__/appLocaleTestKit";
import { submitWritebackValue, type WritebackCellTarget } from "../writebackEditing";

const NUMBER_TARGET: WritebackCellTarget = {
  connectionId: "c1",
  writebackId: "wb1",
  key: ["42"],
  columnName: "Forecast",
  dataType: "Float64",
};

const TEXT_TARGET: WritebackCellTarget = { ...NUMBER_TARGET, columnName: "Note", dataType: "String" };

beforeEach(() => {
  setValue.mockReset();
  setValue.mockResolvedValue(undefined);
});

afterEach(async () => {
  await useInvariantLocale();
});

describe("writeback input in the app locale", () => {
  it('de-DE: "1.234,5" in a number column is sent as 1234.5', async () => {
    await useAppLocale("de-DE");
    await submitWritebackValue(NUMBER_TARGET, "1.234,5");
    expect(setValue).toHaveBeenCalledWith("c1", "wb1", ["42"], "1234.5");
  });

  it('de-DE: the foreign "1.5" is refused, never sent to be read as 1.5', async () => {
    await useAppLocale("de-DE");
    await expect(submitWritebackValue(NUMBER_TARGET, "1.5")).rejects.toThrow("'Forecast' expects a number, got '1.5'");
    expect(setValue).not.toHaveBeenCalled();
  });

  it("sv-SE: a grouped number with a decimal comma is sent invariantly", async () => {
    await useAppLocale("sv-SE");
    await submitWritebackValue(NUMBER_TARGET, "-1 234,75");
    expect(setValue).toHaveBeenCalledWith("c1", "wb1", ["42"], "-1234.75");
  });

  it("a text column's input goes exactly as typed, even when it looks like a number", async () => {
    await useAppLocale("de-DE");
    await submitWritebackValue(TEXT_TARGET, "1.000");
    expect(setValue).toHaveBeenCalledWith("c1", "wb1", ["42"], "1.000");
  });

  it("blank clears the entry; a formula is refused", async () => {
    await submitWritebackValue(NUMBER_TARGET, "   ");
    expect(setValue).toHaveBeenCalledWith("c1", "wb1", ["42"], null);
    await expect(submitWritebackValue(NUMBER_TARGET, "=1+1")).rejects.toThrow("Formulas can't be entered");
  });
});
