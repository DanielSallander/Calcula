//! FILENAME: app/extensions/Table/lib/tableStyles.test.ts
// PURPOSE: The table style catalogue and the ONE translation between a gallery
//          id (`table-medium-2`) and the style NAME a table stores
//          (`TableStyleMedium2`), plus the write that applies a style.
// CONTEXT: The Table Styles gallery used to keep its choice in local React
//          state and write nothing to the table. It now writes `styleName`
//          through `applyTableStyleAsync` and derives its highlight from the
//          stored name, so the two spellings must round-trip exactly — a name
//          that maps to the wrong id would highlight a style the table does not
//          wear.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  updateTableStyle: vi.fn(),
  refreshCache: vi.fn(() => Promise.resolve()),
}));

vi.mock("@api/backend", () => ({
  updateTableStyle: (...a: unknown[]) => h.updateTableStyle(...a),
}));

vi.mock("./tableStore", () => ({
  refreshCache: () => h.refreshCache(),
}));

import {
  TABLE_STYLES,
  TABLE_STYLES_BY_ID,
  DEFAULT_TABLE_STYLE_ID,
  TABLE_STYLE_NONE_ID,
  tableStyleNameForId,
  tableStyleIdForName,
  tableStyleDisplayName,
  applyTableStyleAsync,
} from "./tableStyles";

describe("the table style catalogue", () => {
  it("holds Excel's gallery: Light 1-28, Medium 1-28, Dark 1-21, in that order", () => {
    const count = (c: string) => TABLE_STYLES.filter((s) => s.category === c).length;
    expect(count("light")).toBe(28);
    expect(count("medium")).toBe(28);
    expect(count("dark")).toBe(21);
    expect(new Set(TABLE_STYLES.map((s) => s.id)).size).toBe(TABLE_STYLES.length);

    expect(TABLE_STYLES[0].id).toBe("table-light-1");
    expect(TABLE_STYLES[28].id).toBe("table-medium-1");
    expect(TABLE_STYLES[TABLE_STYLES.length - 1].id).toBe("table-dark-21");
  });

  it("the default a new table gets is in the catalogue", () => {
    expect(TABLE_STYLES_BY_ID.has(DEFAULT_TABLE_STYLE_ID)).toBe(true);
    expect(tableStyleNameForId(DEFAULT_TABLE_STYLE_ID)).toBe("TableStyleMedium2");
  });

  it("names a style the way a user reads it", () => {
    expect(tableStyleDisplayName(TABLE_STYLES_BY_ID.get("table-medium-2")!)).toBe("Medium 2");
    expect(tableStyleDisplayName(TABLE_STYLES_BY_ID.get("table-dark-11")!)).toBe("Dark 11");
  });
});

describe("gallery id <-> stored style name", () => {
  it("round-trips every built-in style", () => {
    for (const def of TABLE_STYLES) {
      const name = tableStyleNameForId(def.id);
      expect(name).toMatch(/^TableStyle(Light|Medium|Dark)\d+$/);
      expect(tableStyleIdForName(name)).toBe(def.id);
    }
  });

  it("None is an EMPTY name, both ways", () => {
    expect(tableStyleNameForId(TABLE_STYLE_NONE_ID)).toBe("");
    expect(tableStyleIdForName("")).toBe(TABLE_STYLE_NONE_ID);
    expect(tableStyleIdForName("   ")).toBe(TABLE_STYLE_NONE_ID);
  });

  it("reads Excel's names case-insensitively", () => {
    expect(tableStyleIdForName("tablestylelight9")).toBe("table-light-9");
    expect(tableStyleIdForName("TableStyleDark11")).toBe("table-dark-11");
  });

  it("claims NO thumbnail for a style the gallery cannot draw", () => {
    expect(tableStyleIdForName("TableStyleMedium29")).toBeNull();
    expect(tableStyleIdForName("TableStyleDark22")).toBeNull();
    expect(tableStyleIdForName("MyCompanyStyle")).toBeNull();
    expect(tableStyleIdForName(null)).toBeNull();
    expect(tableStyleIdForName(undefined)).toBeNull();
  });
});

describe("applyTableStyleAsync", () => {
  beforeEach(() => {
    h.updateTableStyle.mockReset();
    h.refreshCache.mockClear();
  });

  it("writes the style NAME only — the seven style-option flags are untouched", async () => {
    const table = { id: "t1", styleName: "TableStyleDark3" };
    h.updateTableStyle.mockResolvedValue({ success: true, table });

    const result = await applyTableStyleAsync("t1", "table-dark-3");

    expect(h.updateTableStyle).toHaveBeenCalledTimes(1);
    expect(h.updateTableStyle).toHaveBeenCalledWith({ tableId: "t1", styleName: "TableStyleDark3" });
    expect(Object.keys(h.updateTableStyle.mock.calls[0][0] as object)).not.toContain("styleOptions");
    expect(h.refreshCache).toHaveBeenCalledTimes(1);
    expect(result).toBe(table);
  });

  it("None clears the style (empty name)", async () => {
    h.updateTableStyle.mockResolvedValue({ success: true, table: { id: "t1", styleName: "" } });
    await applyTableStyleAsync("t1", TABLE_STYLE_NONE_ID);
    expect(h.updateTableStyle).toHaveBeenCalledWith({ tableId: "t1", styleName: "" });
  });

  it("a refused write (protected sheet) returns null and leaves the cache alone", async () => {
    h.updateTableStyle.mockResolvedValue({ success: false, error: "protected" });
    await expect(applyTableStyleAsync("t1", "table-light-1")).resolves.toBeNull();
    expect(h.refreshCache).not.toHaveBeenCalled();
  });
});
