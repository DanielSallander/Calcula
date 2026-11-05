//! FILENAME: app/src/api/scriptHost/__tests__/cellShiftScript.test.ts
// PURPOSE: BUG-0358 -- the macro recorder did not record Insert Cells / Delete
//          Cells, because a script had no way to replay one. A script now has
//          Excel's Range.Insert Shift / Range.Delete Shift (api.insertCells /
//          api.deleteCells): one broker row each, the same wrappers Home >
//          Insert Cells... runs, refused with Excel's own question when the
//          shift would cut a merged block (a script cannot be asked) unless the
//          call says to unmerge.
// CONTEXT: host.ts executeCellShift over a recording lib double; allowlist.ts
//          rows; the broker's decision (an application macro's granted run
//          never reaches structure).

import { describe, it, expect, vi } from "vitest";

vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
  convertFormulaStyle: vi.fn(async (f: string) => f),
}));

import { executeCellShift } from "../host";
import { ALLOWLIST } from "../allowlist";
import { decidePolicy, type PolicyIdentity } from "../brokerPolicy";
import { vDeleteCells, vInsertCells } from "../validators";

function makeLib(answer: { applied: boolean; confirm: string | null } = { applied: true, confirm: null }) {
  return {
    insertCellsRange: vi.fn(async () => ({ ...answer, wholeLines: false })),
    deleteCellsRange: vi.fn(async () => ({ ...answer, wholeLines: false })),
  };
}

const none = new Set<never>();
const unlocked: PolicyIdentity = { tier: "unlocked", grants: none, declaredCapabilities: none };

describe("api.insertCells / api.deleteCells (BUG-0358)", () => {
  it("are unlocked-tier structure rows with no capability, and validate the shift", () => {
    for (const m of ["api.insertCells", "api.deleteCells"]) {
      expect(ALLOWLIST[m]?.tier, m).toBe("unlocked");
      expect(ALLOWLIST[m]?.capability, m).toBeUndefined();
      expect(ALLOWLIST[m]?.class, m).toBe("mutate");
    }
    expect(ALLOWLIST["api.insertCells"].validate).toBe(vInsertCells);
    expect(ALLOWLIST["api.deleteCells"].validate).toBe(vDeleteCells);
    expect(decidePolicy(unlocked, "api.insertCells", [1, 1, 2, 2, "down"]).admitted).toBe(true);
    expect(decidePolicy(unlocked, "api.deleteCells", [1, 1, 2, 2, "up", { unmergeCutMerges: true }]).admitted).toBe(true);
    // An insert cannot shift left, a delete cannot shift down; inverted blocks and stray options refuse.
    expect(decidePolicy(unlocked, "api.insertCells", [1, 1, 2, 2, "up"]).admitted).toBe(false);
    expect(decidePolicy(unlocked, "api.deleteCells", [1, 1, 2, 2, "down"]).admitted).toBe(false);
    expect(decidePolicy(unlocked, "api.insertCells", [2, 1, 1, 2, "down"]).admitted).toBe(false);
    expect(decidePolicy(unlocked, "api.insertCells", [1, 1, 2, 2, "down", { sheet: 1 }]).admitted).toBe(false);
  });

  it("an application macro's run you start gets cell access and formatting, never structure", () => {
    const granted: PolicyIdentity = { ...unlocked, tier: "restricted", explicitRun: { cells: true, formatting: true } };
    expect(decidePolicy(granted, "api.insertCells", [1, 1, 2, 2, "down"]).admitted).toBe(false);
    expect(decidePolicy(granted, "api.deleteCells", [1, 1, 2, 2, "left"]).admitted).toBe(false);
  });

  // SABOTAGE: drop the `{ unmergeCutMerges }` options from the executor's
  // wrapper call -> the person's recorded answer never reaches the backend.
  it("runs the Insert / Delete Cells wrappers with the shift and the merge answer", async () => {
    const lib = makeLib();
    await executeCellShift(lib as never, "insert", 1, 1, 2, 2, "down");
    await executeCellShift(lib as never, "delete", 4, 3, 4, 5, "left", { unmergeCutMerges: true });
    expect(lib.insertCellsRange).toHaveBeenCalledWith(1, 1, 2, 2, "down", { unmergeCutMerges: false });
    expect(lib.deleteCellsRange).toHaveBeenCalledWith(4, 3, 4, 5, "left", { unmergeCutMerges: true });
  });

  it("a shift that would cut a merged block is refused with Excel's question -- nothing changed", async () => {
    const question = "This operation will cause some merged cells to unmerge. Do you wish to continue?";
    const lib = makeLib({ applied: false, confirm: question });
    await expect(executeCellShift(lib as never, "insert", 1, 1, 2, 2, "right")).rejects.toThrow(
      new RegExp(`insertCells: ${question.replace(/[.?]/g, "\\$&")} Nothing was changed; pass \\{ unmergeCutMerges: true \\}`),
    );
  });
});
