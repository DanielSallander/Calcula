//! FILENAME: app/src/api/__tests__/cellTargetReadBands.test.ts
// PURPOSE: A floating grid's styled and typed reads join their bands with a
//          LOOP, never `out.push(...part)`.
// CONTEXT: Bug-ledger fix programme, round 4 (BUG-0346, the revE#5 spread
//          pattern outside Paste Special). A band is up to CELL_TARGET_READ_BAND
//          (100,000) cells, and spreading one call argument per cell is at the
//          edge of V8's call stack: node throws RangeError at about 125,000
//          arguments at the top level, fewer in a deep stack. The answer of one
//          band is the backend's to size, so the join must not care how large
//          it is: here one band answers 150,000 cells.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ invokeBackend: vi.fn() }));

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: (...a: unknown[]) => h.invokeBackend(...a),
}));

import { getCellTargetCells, getCellTargetCellsTyped } from "../cellTarget";

const REF = { kind: "floatingRange" as const, id: "fr-1" };
const BIG = 150_000;

function many<T>(make: (i: number) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < BIG; i++) out.push(make(i));
  return out;
}

beforeEach(() => {
  h.invokeBackend.mockReset();
});

describe("a band answering more cells than a spread argument list", () => {
  it("the styled read keeps every cell and every conditional format", async () => {
    h.invokeBackend.mockImplementation(async () => ({
      cells: many((i) => ({ row: i, col: 0, display: String(i), formula: null, styleIndex: 0 })),
      conditional: many((i) => ({ row: i, col: 0 })),
      merges: [],
      styles: [],
      rules: [],
    }));
    const read = await getCellTargetCells(REF, { startRow: 0, startCol: 0, endRow: 9, endCol: 0 });
    expect(h.invokeBackend).toHaveBeenCalledTimes(1);
    expect(read.cells).toHaveLength(BIG);
    expect(read.conditional).toHaveLength(BIG);
  });

  it("the typed read keeps every cell", async () => {
    h.invokeBackend.mockImplementation(async () =>
      many((i) => ({ row: i, col: 0, value: i, display: String(i), formula: null, type: "number" })),
    );
    const read = await getCellTargetCellsTyped(REF, { startRow: 0, startCol: 0, endRow: 9, endCol: 0 });
    expect(h.invokeBackend).toHaveBeenCalledTimes(1);
    expect(read).toHaveLength(BIG);
    expect(read[BIG - 1].value).toBe(BIG - 1);
  });
});
