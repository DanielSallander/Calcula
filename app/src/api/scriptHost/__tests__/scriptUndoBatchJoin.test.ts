//! FILENAME: app/src/api/scriptHost/__tests__/scriptUndoBatchJoin.test.ts
// PURPOSE: W3 (wave C; wb-slicer needs 4). `withScriptUndoBatch` used to JOIN
//          an already-open undo transaction SILENTLY: it ran its writes and
//          skipped the begin. The backend's `begin_undo_transaction` is the one
//          door that MARKS a transaction as having absorbed another caller's
//          begin (`Transaction::absorbed_begin`), and a user gesture's
//          "overwrite existing data?" Cancel refuses to take back a marked step
//          (`OVERWRITE_STEP_SHARED`) -- it would take the script's writes back
//          with it. Skipping the begin left the step unmarked, so a user's
//          Cancel undid the script's cells too.
//
//          The rule pinned here: with a transaction open, the batch still
//          AWAITS its begin (the Tauri door marks the joined step) and never
//          commits (the opener owns the step); with none open it opens,
//          commits, and cancels on a throw -- unchanged.
// CONTEXT: Driven through `fillRangeFromScript`, an exported executor that
//          takes its `lib` facade as a parameter (the fillRange.test.ts
//          harness), so the stub records exactly which undo doors it used.

import { describe, it, expect, vi } from "vitest";

vi.mock("../../grid", () => ({
  refreshGridData: vi.fn(),
  refreshGridDimensions: vi.fn(),
}));

vi.mock("../writebackWriteGuard", () => ({
  captureWritebackWrite: vi.fn(async () => false),
  captureWritebackWrites: vi.fn(async (_id: string, writes: unknown[]) => ({
    plain: [...(writes as Array<{ sheetIndex: number; row: number; col: number; value: string }>)],
    drafted: [],
  })),
  workbookHasWritebackRegions: vi.fn(async () => false),
}));

vi.mock("../../../core/lib/tauri-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../core/lib/tauri-api")>();
  return {
    ...actual,
    shiftFormulasBatch: vi.fn(async (inputs: Array<{ formula: string }>) => inputs.map((i) => i.formula)),
    getMergedRegions: vi.fn(async () => []),
    mergeCells: vi.fn(async () => ({ success: true, mergedRegions: [], updatedCells: [] })),
  };
});

import { fillRangeFromScript } from "../host";

/** A recording stand-in for the @api/lib facade; `open` = a transaction is
 *  already open on the backend (a user's gesture, another batch). */
function makeLib(open: boolean, failWrite = false, beginAnswer?: boolean) {
  const undo: string[] = [];
  const lib = {
    getActiveSheet: vi.fn(async () => 0),
    getSheets: vi.fn(async () => ({ sheets: [{ index: 0, name: "Sheet1" }], activeIndex: 0 })),
    getViewportCells: vi.fn(async () => [{ row: 0, col: 0, display: "5" }]),
    getUndoState: vi.fn(async () => ({ transactionOpen: open })),
    beginUndoTransaction: vi.fn(async (description: string) => {
      undo.push(`begin:${description}`);
      // The backend's answer: whether THIS begin opened the transaction --
      // as the real one answers it (joined while one is open), unless a test
      // makes the slot change between the probe and the begin.
      return beginAnswer ?? !open;
    }),
    commitUndoTransaction: vi.fn(async () => {
      undo.push("commit");
    }),
    cancelUndoTransaction: vi.fn(async () => {
      undo.push("cancel");
    }),
    updateCellsBatch: vi.fn(async () => {
      undo.push("write");
      if (failWrite) throw new Error("the backend refused the write");
      return [];
    }),
    updateCell: vi.fn(async () => null),
  };
  return { lib: lib as unknown as Parameters<typeof fillRangeFromScript>[0], undo };
}

describe("withScriptUndoBatch marks a transaction it joins (W3)", () => {
  it("with a transaction already open, it still AWAITS its begin (the marking door) and does not commit", async () => {
    const { lib, undo } = makeLib(true);

    await fillRangeFromScript(lib, "script-w3", 0, 0, 2, 0, {}, undefined);

    expect(
      undo,
      "joining an open transaction without its begin leaves the step unmarked, so a user's Cancel takes the script's writes back",
    ).toEqual(["begin:Fill 2 cells", "write"]);
  });

  it("a joined batch whose write throws neither commits nor cancels the opener's transaction", async () => {
    const { lib, undo } = makeLib(true, true);

    await expect(fillRangeFromScript(lib, "script-w3", 0, 0, 2, 0, {}, undefined)).rejects.toThrow(
      "the backend refused the write",
    );

    expect(undo, "a cancel here would throw away the opener's own writes").toEqual(["begin:Fill 2 cells", "write"]);
  });

  it("with none open it opens, commits, and cancels on a throw (unchanged)", async () => {
    const ok = makeLib(false);
    await fillRangeFromScript(ok.lib, "script-w3", 0, 0, 2, 0, {}, undefined);
    expect(ok.undo).toEqual(["begin:Fill 2 cells", "write", "commit"]);

    const failing = makeLib(false, true);
    await expect(fillRangeFromScript(failing.lib, "script-w3", 0, 0, 2, 0, {}, undefined)).rejects.toThrow();
    expect(failing.undo).toEqual(["begin:Fill 2 cells", "write", "cancel"]);
  });

  it("the backend's answer decides, whatever the slot looked like before the begin", async () => {
    // Seen open, but the opener committed before the begin landed: this begin
    // OPENED a fresh transaction, and nobody else will commit it.
    const reopened = makeLib(true, false, true);
    await fillRangeFromScript(reopened.lib, "script-w3", 0, 0, 2, 0, {}, undefined);
    expect(reopened.undo, "a begin that opened must be committed").toEqual(["begin:Fill 2 cells", "write", "commit"]);

    // Seen closed, but someone opened one before the begin landed: JOINED --
    // committing here would close the stranger's transaction halfway.
    const joined = makeLib(false, false, false);
    await fillRangeFromScript(joined.lib, "script-w3", 0, 0, 2, 0, {}, undefined);
    expect(joined.undo, "a begin that joined must not commit").toEqual(["begin:Fill 2 cells", "write"]);
  });
});
