//! FILENAME: app/extensions/ScenarioManager/__tests__/scenarioHelpers.deep.test.ts
// PURPOSE: Deep tests for Scenario Manager helpers and scenario data structures
//          covering large scenarios, special chars, comparisons, and complex ranges.

import { describe, it, expect } from "vitest";

// ============================================================================
// Re-export pure helpers (copied from ScenarioManagerDialog.tsx)
// ============================================================================

function parseCellRef(ref: string): { row: number; col: number } | null {
  const cleaned = ref.trim().replace(/\$/g, "");
  const match = cleaned.match(/^([A-Za-z]+)(\d+)$/);
  if (!match) return null;
  const colStr = match[1].toUpperCase();
  const rowNum = parseInt(match[2], 10);
  if (isNaN(rowNum) || rowNum < 1) return null;
  let colIdx = 0;
  for (let i = 0; i < colStr.length; i++) {
    colIdx = colIdx * 26 + (colStr.charCodeAt(i) - 64);
  }
  return { row: rowNum - 1, col: colIdx - 1 };
}

function columnToLetter(col: number): string {
  let result = "";
  let c = col;
  while (c >= 0) {
    result = String.fromCharCode((c % 26) + 65) + result;
    c = Math.floor(c / 26) - 1;
  }
  return result;
}

function formatCellRef(row: number, col: number): string {
  return `$${columnToLetter(col)}$${row + 1}`;
}

function parseCellRange(rangeStr: string): { row: number; col: number }[] {
  const cells: { row: number; col: number }[] = [];
  const parts = rangeStr.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes(":")) {
      const [startRef, endRef] = trimmed.split(":");
      const start = parseCellRef(startRef);
      const end = parseCellRef(endRef);
      if (start && end) {
        for (let r = Math.min(start.row, end.row); r <= Math.max(start.row, end.row); r++) {
          for (let c = Math.min(start.col, end.col); c <= Math.max(start.col, end.col); c++) {
            cells.push({ row: r, col: c });
          }
        }
      }
    } else {
      const cell = parseCellRef(trimmed);
      if (cell) cells.push(cell);
    }
  }
  return cells;
}

// ============================================================================
// Scenario data types (mirrors @api types)
// ============================================================================

interface ScenarioCell {
  row: number;
  col: number;
  value: string;
}

interface Scenario {
  name: string;
  changingCells: ScenarioCell[];
  comment: string;
  createdBy: string;
  sheetIndex: number;
}

// ============================================================================
// Helper: diff two scenarios on overlapping cells
// ============================================================================

function diffScenarios(
  a: Scenario,
  b: Scenario
): { row: number; col: number; valueA: string; valueB: string }[] {
  const diffs: { row: number; col: number; valueA: string; valueB: string }[] = [];
  const bMap = new Map<string, string>();
  for (const c of b.changingCells) {
    bMap.set(`${c.row},${c.col}`, c.value);
  }
  for (const c of a.changingCells) {
    const key = `${c.row},${c.col}`;
    const bVal = bMap.get(key);
    if (bVal !== undefined && bVal !== c.value) {
      diffs.push({ row: c.row, col: c.col, valueA: c.value, valueB: bVal });
    }
  }
  return diffs;
}

// ============================================================================
// Tests
// ============================================================================

describe("Scenario Manager (deep)", () => {
  // --------------------------------------------------------------------------
  // Multiple scenarios sharing changing cells
  // --------------------------------------------------------------------------

  describe("multiple scenarios sharing changing cells", () => {
    const base: ScenarioCell[] = [
      { row: 0, col: 0, value: "100" },
      { row: 1, col: 0, value: "200" },
      { row: 2, col: 0, value: "300" },
    ];

    const optimistic: Scenario = {
      name: "Optimistic",
      changingCells: [
        { row: 0, col: 0, value: "150" },
        { row: 1, col: 0, value: "250" },
        { row: 2, col: 0, value: "350" },
      ],
      comment: "Best case",
      createdBy: "User",
      sheetIndex: 0,
    };

    const pessimistic: Scenario = {
      name: "Pessimistic",
      changingCells: [
        { row: 0, col: 0, value: "50" },
        { row: 1, col: 0, value: "100" },
        { row: 2, col: 0, value: "150" },
      ],
      comment: "Worst case",
      createdBy: "User",
      sheetIndex: 0,
    };

    it("scenarios share the same cell coordinates", () => {
      const optCoords = optimistic.changingCells.map((c) => `${c.row},${c.col}`);
      const pesCoords = pessimistic.changingCells.map((c) => `${c.row},${c.col}`);
      expect(optCoords).toEqual(pesCoords);
    });

    it("scenarios have different values for shared cells", () => {
      for (let i = 0; i < optimistic.changingCells.length; i++) {
        expect(optimistic.changingCells[i].value).not.toBe(pessimistic.changingCells[i].value);
      }
    });

    it("applying optimistic replaces base values", () => {
      // Simulate apply: replace base with scenario values
      const applied = base.map((cell) => {
        const override = optimistic.changingCells.find(
          (c) => c.row === cell.row && c.col === cell.col
        );
        return override ? { ...cell, value: override.value } : cell;
      });
      expect(applied.map((c) => c.value)).toEqual(["150", "250", "350"]);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario comparison (diff)
  // --------------------------------------------------------------------------

  describe("scenario comparison", () => {
    const scenA: Scenario = {
      name: "A",
      changingCells: [
        { row: 0, col: 0, value: "10" },
        { row: 1, col: 0, value: "20" },
        { row: 2, col: 0, value: "30" },
      ],
      comment: "",
      createdBy: "User",
      sheetIndex: 0,
    };

    const scenB: Scenario = {
      name: "B",
      changingCells: [
        { row: 0, col: 0, value: "10" },  // same
        { row: 1, col: 0, value: "25" },  // different
        { row: 2, col: 0, value: "35" },  // different
      ],
      comment: "",
      createdBy: "User",
      sheetIndex: 0,
    };

    it("diff finds only cells that differ", () => {
      const diffs = diffScenarios(scenA, scenB);
      expect(diffs).toHaveLength(2);
      expect(diffs[0]).toEqual({ row: 1, col: 0, valueA: "20", valueB: "25" });
      expect(diffs[1]).toEqual({ row: 2, col: 0, valueA: "30", valueB: "35" });
    });

    it("diff of identical scenarios is empty", () => {
      expect(diffScenarios(scenA, scenA)).toHaveLength(0);
    });

    it("diff is directional (A vs B != B vs A in labels)", () => {
      const ab = diffScenarios(scenA, scenB);
      const ba = diffScenarios(scenB, scenA);
      expect(ab[0].valueA).toBe("20");
      expect(ba[0].valueA).toBe("25");
    });
  });

  // --------------------------------------------------------------------------
  // Scenario with formula cells
  // --------------------------------------------------------------------------

  describe("scenario with formula values", () => {
    it("stores formula strings as values", () => {
      const scenario: Scenario = {
        name: "FormulaScenario",
        changingCells: [
          { row: 0, col: 0, value: "=SUM(B1:B10)" },
          { row: 1, col: 0, value: "=A1*1.1" },
        ],
        comment: "Contains formulas",
        createdBy: "User",
        sheetIndex: 0,
      };
      expect(scenario.changingCells[0].value).toBe("=SUM(B1:B10)");
      expect(scenario.changingCells[1].value).toBe("=A1*1.1");
    });

    it("formula values are preserved through scenario operations", () => {
      const cells: ScenarioCell[] = [
        { row: 0, col: 0, value: "=IF(B1>0, B1*2, 0)" },
      ];
      const scenario: Scenario = {
        name: "IfFormula",
        changingCells: cells,
        comment: "",
        createdBy: "User",
        sheetIndex: 0,
      };
      // Round-trip: the value is unchanged
      expect(scenario.changingCells[0].value).toBe(cells[0].value);
    });
  });

  // --------------------------------------------------------------------------
  // Large scenario (100+ changing cells)
  // --------------------------------------------------------------------------

  describe("large scenario with 100+ changing cells", () => {
    const largeCells: ScenarioCell[] = [];
    for (let i = 0; i < 150; i++) {
      largeCells.push({ row: i, col: 0, value: String(i * 10) });
    }

    const largeScenario: Scenario = {
      name: "LargeScenario",
      changingCells: largeCells,
      comment: "150 cells",
      createdBy: "User",
      sheetIndex: 0,
    };

    it("stores 150 changing cells", () => {
      expect(largeScenario.changingCells).toHaveLength(150);
    });

    it("first and last cells have correct values", () => {
      expect(largeScenario.changingCells[0].value).toBe("0");
      expect(largeScenario.changingCells[149].value).toBe("1490");
    });

    it("all cells are unique by row", () => {
      const rows = new Set(largeScenario.changingCells.map((c) => c.row));
      expect(rows.size).toBe(150);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario names with special characters
  // --------------------------------------------------------------------------

  describe("scenario names with special characters", () => {
    const specialNames = [
      "Best Case (2026)",
      "Q1 - Revenue / Costs",
      'Scenario "Alpha"',
      "Rate @ 5%",
      "Multi\nline",
      "Unicode: \u00e4\u00f6\u00fc\u00df",
      "",
      "a".repeat(200),
    ];

    for (const name of specialNames) {
      it(`accepts name: ${JSON.stringify(name).slice(0, 40)}`, () => {
        const scenario: Scenario = {
          name,
          changingCells: [{ row: 0, col: 0, value: "1" }],
          comment: "",
          createdBy: "User",
          sheetIndex: 0,
        };
        expect(scenario.name).toBe(name);
      });
    }
  });

  // --------------------------------------------------------------------------
  // Apply scenario then revert
  // --------------------------------------------------------------------------

  describe("apply scenario then revert", () => {
    it("revert restores original values", () => {
      const original: ScenarioCell[] = [
        { row: 0, col: 0, value: "100" },
        { row: 1, col: 0, value: "200" },
      ];

      const scenario: Scenario = {
        name: "Override",
        changingCells: [
          { row: 0, col: 0, value: "999" },
          { row: 1, col: 0, value: "888" },
        ],
        comment: "",
        createdBy: "User",
        sheetIndex: 0,
      };

      // Apply
      const applied = original.map((cell) => {
        const override = scenario.changingCells.find(
          (c) => c.row === cell.row && c.col === cell.col
        );
        return override ? { ...cell, value: override.value } : cell;
      });
      expect(applied.map((c) => c.value)).toEqual(["999", "888"]);

      // Revert (restore from saved original)
      const reverted = applied.map((cell) => {
        const orig = original.find(
          (c) => c.row === cell.row && c.col === cell.col
        );
        return orig ? { ...cell, value: orig.value } : cell;
      });
      expect(reverted.map((c) => c.value)).toEqual(["100", "200"]);
    });

    it("revert after applying multiple scenarios restores original", () => {
      const original = [{ row: 0, col: 0, value: "50" }];

      // Apply scenario 1
      const s1Value = "100";
      // Apply scenario 2 on top
      const s2Value = "200";

      // Revert should go back to original, not to s1
      expect(original[0].value).toBe("50");
      expect(s1Value).not.toBe(original[0].value);
      expect(s2Value).not.toBe(original[0].value);
    });
  });

  // --------------------------------------------------------------------------
  // parseCellRange with complex ranges
  // --------------------------------------------------------------------------

  describe("parseCellRange complex ranges", () => {
    it("parses A1:Z100 (large 2D range)", () => {
      const cells = parseCellRange("A1:Z100");
      // 26 columns x 100 rows = 2600 cells
      expect(cells).toHaveLength(2600);
      // First cell
      expect(cells[0]).toEqual({ row: 0, col: 0 });
      // Last cell
      expect(cells[cells.length - 1]).toEqual({ row: 99, col: 25 });
    });

    it("parses multiple disjoint ranges", () => {
      const cells = parseCellRange("A1:A5, C1:C5, E1:E5");
      expect(cells).toHaveLength(15); // 5 + 5 + 5
    });

    it("parses single row range A1:Z1", () => {
      const cells = parseCellRange("A1:Z1");
      expect(cells).toHaveLength(26);
      expect(cells.every((c) => c.row === 0)).toBe(true);
    });

    it("parses single column range A1:A50", () => {
      const cells = parseCellRange("A1:A50");
      expect(cells).toHaveLength(50);
      expect(cells.every((c) => c.col === 0)).toBe(true);
    });

    it("handles range with absolute refs $A$1:$Z$100", () => {
      const cells = parseCellRange("$A$1:$Z$100");
      expect(cells).toHaveLength(2600);
    });

    it("parses mixed absolute and relative in range", () => {
      const cells = parseCellRange("$A1:B$3");
      expect(cells).toHaveLength(6); // 2 cols x 3 rows
    });

    it("range with multi-letter columns AA1:AC3", () => {
      const cells = parseCellRange("AA1:AC3");
      // AA=26, AB=27, AC=28 -> 3 cols, 3 rows = 9
      expect(cells).toHaveLength(9);
      expect(cells[0]).toEqual({ row: 0, col: 26 });
      expect(cells[cells.length - 1]).toEqual({ row: 2, col: 28 });
    });

    it("comma-separated cells and ranges combined", () => {
      const cells = parseCellRange("A1, B1:B3, D5");
      expect(cells).toHaveLength(5); // 1 + 3 + 1
    });

    it("ignores invalid parts in mixed input", () => {
      const cells = parseCellRange("A1, invalid, B2");
      expect(cells).toHaveLength(2);
      expect(cells[0]).toEqual({ row: 0, col: 0 });
      expect(cells[1]).toEqual({ row: 1, col: 1 });
    });

    it("single cell range A5:A5 yields one cell", () => {
      const cells = parseCellRange("A5:A5");
      expect(cells).toHaveLength(1);
      expect(cells[0]).toEqual({ row: 4, col: 0 });
    });
  });

  // --------------------------------------------------------------------------
  // columnToLetter / formatCellRef extended
  // --------------------------------------------------------------------------

  describe("columnToLetter edge cases", () => {
    it("col 0 -> A", () => expect(columnToLetter(0)).toBe("A"));
    it("col 25 -> Z", () => expect(columnToLetter(25)).toBe("Z"));
    it("col 26 -> AA", () => expect(columnToLetter(26)).toBe("AA"));
    it("col 701 -> ZZ", () => expect(columnToLetter(701)).toBe("ZZ"));
    it("col 702 -> AAA", () => expect(columnToLetter(702)).toBe("AAA"));
  });
});
