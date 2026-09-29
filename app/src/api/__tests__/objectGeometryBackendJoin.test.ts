//! FILENAME: app/src/api/__tests__/objectGeometryBackendJoin.test.ts
// PURPOSE: The frontend-owned undo transaction (`openUndoTransaction` /
//          `runInUndoTransaction`) commits ONLY a backend transaction its own
//          begin OPENED. The backend keeps ONE open slot: a begin while
//          another caller's transaction is open (a script's `beginBatch`, a
//          Core gesture's own begin) JOINS it and answers `false` (W3,
//          `begin_undo_transaction`), and `commit_undo_transaction` commits
//          WHATEVER is open. The handle used to commit anyway, so a timeline
//          selection, an Arrange, a slicer or a ribbon filter made while a
//          script's batch was open closed that batch half-way: the script's
//          one batch became two Ctrl+Z steps (review of wave C, WC-UNDO).
//
//          Review fix-up (F1): the commit PRESENTS the ticket its begin was
//          handed, so it closes the backend slot only while the slot still
//          holds that transaction. A sheet change ends it behind the handle's
//          back (Excel parity), and a bare commit then closed whatever a
//          stranger had opened since.
//
//          The backend here is a faithful fake of the three commands: begin
//          answers a ticket when it opens and null when it joins (and marks the
//          open step absorbed), a bare commit pushes whatever is open, a
//          ticketed one only the transaction its ticket names; cancel drops.

import { describe, it, expect, beforeEach, vi } from "vitest";

const b = vi.hoisted(() => ({
  open: null as null | { label: string; writes: string[]; absorbed: boolean },
  steps: [] as Array<{ label: string; writes: string[] }>,
  commits: 0,
  /** The ticket the backend issued last (undo_commands.rs), with the clear count then. */
  issued: null as null | { ticket: number; clears: number },
  clears: 0,
  nextTicket: 1,
  record(what: string) {
    if (b.open) b.open.writes.push(what);
    else b.steps.push({ label: `own:${what}`, writes: [what] });
  },
  /** close_undo_transaction: a ticket closes only the transaction it names. */
  closes(ticket: number | null | undefined): boolean {
    const bare = ticket === undefined || ticket === null;
    const closes = bare || (b.open !== null && b.issued?.ticket === ticket && b.issued.clears === b.clears);
    if (b.issued && (closes || ticket === b.issued.ticket)) b.issued = null;
    return closes;
  },
}));

vi.mock("../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/lib/tauri-api")>()),
  beginUndoTransaction: async (label: string) => {
    if (b.open) {
      b.open.absorbed = true;
      return null;
    }
    b.open = { label, writes: [], absorbed: false };
    const ticket = b.nextTicket++;
    b.issued = { ticket, clears: b.clears };
    return ticket;
  },
  commitUndoTransaction: async (ticket?: number | null) => {
    b.commits += 1;
    if (!b.closes(ticket)) return;
    if (b.open) {
      if (b.open.writes.length > 0) b.steps.push({ label: b.open.label, writes: b.open.writes });
      b.open = null;
    }
  },
  cancelUndoTransaction: async (ticket?: number | null) => {
    if (b.closes(ticket)) b.open = null;
  },
}));

import { openUndoTransaction, runInUndoTransaction, joinUndoTransaction, isUndoTransactionOpen } from "../objectGeometry";

/** A macrotask: what an IPC round trip costs. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** What a script's `api.beginBatch` does: the Tauri begin, opened by the script. */
function scriptBeginsBatch(): void {
  b.open = { label: "Script batch", writes: [], absorbed: false };
}

/** What the script's `api.commitBatch` does. */
function scriptCommitsBatch(): void {
  if (b.open && b.open.writes.length > 0) b.steps.push({ label: b.open.label, writes: b.open.writes });
  b.open = null;
}

beforeEach(() => {
  b.open = null;
  b.steps = [];
  b.commits = 0;
  b.issued = null;
  b.clears = 0;
});

/** A sheet add / rename / move / copy (or a document swap): the history ends,
 *  open transaction included (UndoStack::clear). */
function sheetChangeEndsHistory(): void {
  b.steps = [];
  b.open = null;
  b.clears += 1;
}

describe("the frontend transaction inside ANOTHER caller's backend transaction", () => {
  it("runInUndoTransaction joins a script's open batch and never commits it", async () => {
    scriptBeginsBatch();
    b.record("A1");
    await runInUndoTransaction("Arrange", async () => b.record("x"));
    expect(b.open, "runInUndoTransaction committed a transaction it did not open").not.toBeNull();
    expect(b.commits).toBe(0);
    expect(b.open?.absorbed).toBe(true);
    b.record("A2");
    scriptCommitsBatch();
    expect(b.steps).toEqual([{ label: "Script batch", writes: ["A1", "x", "A2"] }]);
  });

  it("frontend joiners of a backend-joined opener still join, and nobody commits the script's batch", async () => {
    scriptBeginsBatch();
    const outer = openUndoTransaction("Move Objects");
    const inner = runInUndoTransaction("Move Slicers", async () => {
      await tick();
      b.record("slicer");
    });
    await outer.run(async () => b.record("chart"));
    void joinUndoTransaction(async () => b.record("late"));
    await outer.commit();
    await inner;
    expect(isUndoTransactionOpen()).toBe(false);
    expect(b.commits).toBe(0);
    expect(b.open?.writes.sort()).toEqual(["chart", "late", "slicer"]);
  });

  it("a gesture after a backend-joined one opens (and commits) a step of its own", async () => {
    scriptBeginsBatch();
    await runInUndoTransaction("Arrange", async () => b.record("x"));
    scriptCommitsBatch();
    await runInUndoTransaction("Nudge", async () => b.record("y"));
    expect(b.open).toBeNull();
    expect(b.steps).toEqual([
      { label: "Script batch", writes: ["x"] },
      { label: "Nudge", writes: ["y"] },
    ]);
  });

  it("a sheet change inside the transaction: its commit does not close the step a backend command opens next", async () => {
    const tx = openUndoTransaction("Move Objects");
    await tx.run(async () => b.record("chart"));
    sheetChangeEndsHistory();
    // A backend command opens a step of its own (not through the begin door).
    b.open = { label: "Create table", writes: ["table"], absorbed: false };
    await tx.commit();
    expect(b.open?.label, "the Arrange's commit closed a step its begin never opened").toBe("Create table");
  });

  it("positive control: with nothing open it opens and commits its own step", async () => {
    await runInUndoTransaction("Arrange", async () => b.record("x"));
    expect(b.open).toBeNull();
    expect(b.commits).toBe(1);
    expect(b.steps).toEqual([{ label: "Arrange", writes: ["x"] }]);
  });

  it("an opener still commits when its work throws", async () => {
    await expect(
      runInUndoTransaction("Resize", async () => {
        b.record("half");
        throw new Error("half-written");
      }),
    ).rejects.toThrow("half-written");
    expect(b.open).toBeNull();
    expect(b.steps).toEqual([{ label: "Resize", writes: ["half"] }]);
  });
});
