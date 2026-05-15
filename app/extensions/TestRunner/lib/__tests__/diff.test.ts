//! FILENAME: app/extensions/TestRunner/lib/__tests__/diff.test.ts
// PURPOSE: Tests for the cell map diff utility.

import { describe, it, expect, vi } from "vitest";

vi.mock("@api/types", () => ({}));

import { diffCellMaps } from "../diff";
import type { CellData } from "@api/types";

function makeCell(overrides: Partial<CellData> = {}): CellData {
  return {
    row: 0,
    col: 0,
    display: "",
    formula: null,
    styleIndex: 0,
    ...overrides,
  } as CellData;
}

describe("diffCellMaps", () => {
  it("reports no changes for identical maps", () => {
    const map = new Map<string, CellData>([
      ["A1", makeCell({ display: "10" })],
    ]);
    const result = diffCellMaps(map, map);
    expect(result).toContain("(no changes)");
  });

  it("reports added cells", () => {
    const a = new Map<string, CellData>();
    const b = new Map<string, CellData>([
      ["A1", makeCell({ display: "Hello" })],
    ]);
    const result = diffCellMaps(a, b);
    expect(result).toContain("Added:");
    expect(result).toContain("+ A1");
    expect(result).toContain('display="Hello"');
  });

  it("reports removed cells", () => {
    const a = new Map<string, CellData>([
      ["B2", makeCell({ display: "gone" })],
    ]);
    const b = new Map<string, CellData>();
    const result = diffCellMaps(a, b);
    expect(result).toContain("Removed:");
    expect(result).toContain("- B2");
  });

  it("reports changed display values", () => {
    const a = new Map<string, CellData>([
      ["A1", makeCell({ display: "old" })],
    ]);
    const b = new Map<string, CellData>([
      ["A1", makeCell({ display: "new" })],
    ]);
    const result = diffCellMaps(a, b);
    expect(result).toContain("Changed:");
    expect(result).toContain('display: "old" -> "new"');
  });

  it("reports changed formula", () => {
    const a = new Map<string, CellData>([
      ["A1", makeCell({ display: "5", formula: "=A2+A3" } as any)],
    ]);
    const b = new Map<string, CellData>([
      ["A1", makeCell({ display: "5", formula: "=B1" } as any)],
    ]);
    const result = diffCellMaps(a, b);
    expect(result).toContain("formula: =A2+A3 -> =B1");
  });

  it("reports changed style index", () => {
    const a = new Map<string, CellData>([
      ["A1", makeCell({ display: "x", styleIndex: 0 })],
    ]);
    const b = new Map<string, CellData>([
      ["A1", makeCell({ display: "x", styleIndex: 3 })],
    ]);
    const result = diffCellMaps(a, b);
    expect(result).toContain("style: 0 -> 3");
  });

  it("includes cell count header", () => {
    const a = new Map<string, CellData>([
      ["A1", makeCell({ display: "a" })],
      ["A2", makeCell({ display: "b" })],
    ]);
    const b = new Map<string, CellData>([
      ["A1", makeCell({ display: "a" })],
    ]);
    const result = diffCellMaps(a, b);
    expect(result).toContain("2 cells -> 1 cells");
  });

  it("describes cell with formula and style in added output", () => {
    const a = new Map<string, CellData>();
    const b = new Map<string, CellData>([
      ["C3", makeCell({ display: "100", formula: "=SUM(A1:A10)", styleIndex: 2 } as any)],
    ]);
    const result = diffCellMaps(a, b);
    expect(result).toContain("formula==SUM(A1:A10)");
    expect(result).toContain("style=2");
  });
});
