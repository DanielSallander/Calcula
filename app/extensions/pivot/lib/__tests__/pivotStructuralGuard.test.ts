//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotStructuralGuard.test.ts
// PURPOSE: Insert / Delete Sheet Rows / Columns are refused when they would
//          cut into a PivotTable -- for EVERY Ctrl+click block of the
//          selection, not only the main one.
// CONTEXT: Home tab 2026-10-04 (core-grid defect 2). The four grid commands
//          now act on every block of a multi-area selection (Excel's Insert
//          Sheet Rows over A2 + A5 inserts a row above row 2 AND one above row
//          5), while the Pivot extension's guards still read only the main
//          range: a cell outside the pivot, then Ctrl+click a cell inside it,
//          then Delete Sheet Rows -- and the TS guard let the pivot's row go.
//          Each block is judged by the rule the guard always applied to the
//          main range (insert: only strictly inside; delete: any overlap),
//          unchanged; the blocks are applied bottom-up by Core, so judging
//          each against the regions as they stand now is exact.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { Selection } from "@api/types";
import {
  pivotStructuralGuard,
  registerPivotStructuralGuards,
  PIVOT_STRUCTURAL_GUARDED_COMMANDS,
  type PivotStructuralCommand,
} from "../pivotStructuralGuard";

/** A pivot at C3:F11 (rows 2..10, cols 2..5, 0-based). */
const pivot = { startRow: 2, startCol: 2, endRow: 10, endCol: 5 };
const REFUSAL = "We can't make this change for the selected cells because it will affect a PivotTable.";

type Block = NonNullable<Selection["additionalRanges"]>[number];

function sel(startRow: number, startCol: number, endRow: number, endCol: number, extra?: Block[]): Selection {
  return { startRow, startCol, endRow, endCol, type: "cells", additionalRanges: extra };
}

function block(startRow: number, startCol: number, endRow: number, endCol: number): Block {
  return { startRow, startCol, endRow, endCol };
}

describe("one block: the rules the guards always applied (unchanged)", () => {
  it("insert row: refused strictly inside the pivot, allowed at its first row (that shifts it whole)", () => {
    expect(pivotStructuralGuard("insertRow", sel(5, 0, 5, 0), [pivot], REFUSAL)).toBe(REFUSAL);
    expect(pivotStructuralGuard("insertRow", sel(2, 0, 2, 0), [pivot], REFUSAL)).toBe(true);
    expect(pivotStructuralGuard("insertRow", sel(11, 0, 11, 0), [pivot], REFUSAL)).toBe(true);
  });

  it("delete row: any overlap is refused, the first row included", () => {
    expect(pivotStructuralGuard("deleteRow", sel(2, 0, 2, 0), [pivot], REFUSAL)).toBe(REFUSAL);
    expect(pivotStructuralGuard("deleteRow", sel(10, 0, 12, 0), [pivot], REFUSAL)).toBe(REFUSAL);
    expect(pivotStructuralGuard("deleteRow", sel(11, 0, 12, 0), [pivot], REFUSAL)).toBe(true);
  });

  it("insert column: refused strictly inside, allowed at its first column", () => {
    expect(pivotStructuralGuard("insertColumn", sel(0, 4, 0, 4), [pivot], REFUSAL)).toBe(REFUSAL);
    expect(pivotStructuralGuard("insertColumn", sel(0, 2, 0, 2), [pivot], REFUSAL)).toBe(true);
  });

  it("delete column: any overlap is refused", () => {
    expect(pivotStructuralGuard("deleteColumn", sel(0, 5, 0, 5), [pivot], REFUSAL)).toBe(REFUSAL);
    expect(pivotStructuralGuard("deleteColumn", sel(0, 6, 0, 9), [pivot], REFUSAL)).toBe(true);
  });

  it("a reversed (bottom-up dragged) block is normalised", () => {
    expect(pivotStructuralGuard("deleteRow", sel(12, 0, 9, 0), [pivot], REFUSAL)).toBe(REFUSAL);
    expect(pivotStructuralGuard("deleteColumn", sel(0, 9, 0, 4), [pivot], REFUSAL)).toBe(REFUSAL);
  });

  it("no selection, or no pivot on the sheet, is allowed", () => {
    expect(pivotStructuralGuard("deleteRow", null, [pivot], REFUSAL)).toBe(true);
    expect(pivotStructuralGuard("deleteRow", sel(5, 0, 5, 0), [], REFUSAL)).toBe(true);
  });
});

describe("a Ctrl+click block is judged too (the defect)", () => {
  // Main block outside the pivot (row 20), a second block inside it.
  const inside = (r: number, c: number): Selection => sel(20, 0, 20, 0, [block(r, c, r, c)]);

  it("Delete Sheet Rows: a second block on a pivot row is refused", () => {
    expect(pivotStructuralGuard("deleteRow", inside(5, 3), [pivot], REFUSAL)).toBe(REFUSAL);
  });

  it("Insert Sheet Rows: a second block strictly inside the pivot is refused", () => {
    expect(pivotStructuralGuard("insertRow", inside(5, 3), [pivot], REFUSAL)).toBe(REFUSAL);
  });

  it("Delete Sheet Columns: a second block on a pivot column is refused", () => {
    expect(pivotStructuralGuard("deleteColumn", sel(0, 20, 0, 20, [block(4, 4, 4, 4)]), [pivot], REFUSAL)).toBe(REFUSAL);
  });

  it("Insert Sheet Columns: a second block strictly inside the pivot is refused", () => {
    expect(pivotStructuralGuard("insertColumn", sel(0, 20, 0, 20, [block(4, 4, 4, 4)]), [pivot], REFUSAL)).toBe(REFUSAL);
  });

  it("the MAIN block inside and a second block outside is still refused (order does not matter)", () => {
    expect(pivotStructuralGuard("deleteRow", sel(5, 3, 5, 3, [block(20, 0, 20, 0)]), [pivot], REFUSAL)).toBe(REFUSAL);
  });

  it("every block outside every pivot is allowed (positive control)", () => {
    expect(
      pivotStructuralGuard("deleteRow", sel(20, 0, 20, 0, [block(30, 0, 31, 0), block(0, 0, 1, 0)]), [pivot], REFUSAL),
    ).toBe(true);
    // A second block at the pivot's first row: an insertion there shifts it whole.
    expect(pivotStructuralGuard("insertRow", sel(20, 0, 20, 0, [block(2, 3, 2, 3)]), [pivot], REFUSAL)).toBe(true);
  });

  it("a second pivot is reached by a second block", () => {
    const other = { startRow: 40, startCol: 0, endRow: 45, endCol: 3 };
    expect(pivotStructuralGuard("deleteRow", sel(20, 0, 20, 0, [block(42, 1, 42, 1)]), [pivot, other], REFUSAL)).toBe(
      REFUSAL,
    );
  });
});

describe("registerPivotStructuralGuards", () => {
  it("sits on exactly the four sheet row/column commands", () => {
    expect([...PIVOT_STRUCTURAL_GUARDED_COMMANDS].sort()).toEqual(["deleteColumn", "deleteRow", "insertColumn", "insertRow"]);
  });

  it("registers ONE guard per command, each judging its own command over every block, and releases them all", () => {
    const registered = new Map<string, (s: Selection | null) => true | string>();
    const released: string[] = [];
    const door = {
      registerGuard(commands: PivotStructuralCommand[], guard: (s: Selection | null) => true | string) {
        for (const c of commands) registered.set(c, guard);
        return () => {
          for (const c of commands) released.push(c);
        };
      },
    };
    const release = registerPivotStructuralGuards(door, () => [pivot], REFUSAL);
    expect([...registered.keys()].sort()).toEqual(["deleteColumn", "deleteRow", "insertColumn", "insertRow"]);

    // Each guard applies ITS command's rule: the pivot's first row may take an
    // insertion but not a deletion.
    const firstRowInSecondBlock = sel(20, 0, 20, 0, [block(2, 9, 2, 9)]);
    expect(registered.get("insertRow")!(firstRowInSecondBlock)).toBe(true);
    expect(registered.get("deleteRow")!(firstRowInSecondBlock)).toBe(REFUSAL);
    expect(registered.get("deleteColumn")!(sel(20, 20, 20, 20, [block(30, 3, 30, 3)]))).toBe(REFUSAL);

    release();
    expect(released.sort()).toEqual(["deleteColumn", "deleteRow", "insertColumn", "insertRow"]);
  });

  it("reads the regions when the guard RUNS (a pivot created after activation is seen)", () => {
    let regions: Array<typeof pivot> = [];
    let guard: ((s: Selection | null) => true | string) | null = null;
    registerPivotStructuralGuards(
      {
        registerGuard: (commands, g) => {
          if (commands.includes("deleteRow")) guard = g;
          return () => {};
        },
      },
      () => regions,
      REFUSAL,
    );
    expect(guard!(sel(5, 3, 5, 3))).toBe(true);
    regions = [pivot];
    expect(guard!(sel(5, 3, 5, 3))).toBe(REFUSAL);
  });
});

describe("the Pivot extension registers these guards (not its old main-range-only copies)", () => {
  const index = fs
    .readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("calls registerPivotStructuralGuards with the grid command door", () => {
    expect(index).toMatch(/registerPivotStructuralGuards\(\s*gridCommands,/);
  });

  it("no guard on a row/column command reads the selection's main range by hand any more", () => {
    expect(index).not.toMatch(/registerGuard\(\["(insertRow|deleteRow|insertColumn|deleteColumn)"\]/);
  });
});
