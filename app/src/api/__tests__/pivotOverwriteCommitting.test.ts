//! FILENAME: app/src/api/__tests__/pivotOverwriteCommitting.test.ts
// PURPOSE: BUG-0200 (S2, "falsely joined"). While the frontend's last undo
//          transaction is still COMMITTING, the backend reports it open. A
//          gesture that asked "is a transaction open anywhere?" in that window
//          was told it had JOINED one -- so it was never asked about the cells
//          it overwrote. `isAnyUndoTransactionOpen` now waits for the commit
//          in flight first. The REAL objectGeometry transaction runs here over
//          a Tauri-shaped backend double whose commit lands only when the
//          test lets it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  backendOpen: false,
  releaseCommit: null as null | (() => void),
}));

vi.mock("../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/lib/tauri-api")>()),
  beginUndoTransaction: async () => {
    h.backendOpen = true;
  },
  commitUndoTransaction: () =>
    new Promise<void>((resolve) => {
      h.releaseCommit = () => {
        h.backendOpen = false;
        resolve();
      };
    }),
  getUndoState: async () => ({ undoSeqs: [], transactionOpen: h.backendOpen }),
}));

import { openUndoTransaction, resetObjectGeometryProviders } from "../objectGeometry";
import { isAnyUndoTransactionOpen } from "../pivotOverwrite";

beforeEach(() => {
  resetObjectGeometryProviders();
  h.backendOpen = false;
  h.releaseCommit = null;
});

describe("a gesture made while the last transaction is still committing", () => {
  it("is not falsely 'joined': it waits for the commit, then reads the backend", async () => {
    const tx = openUndoTransaction("Move slicers");
    await tx.run(async () => undefined);
    const committing = tx.commit();
    // Let the commit reach the backend (the begin landed, the work settled).
    for (let i = 0; i < 5 && !h.releaseCommit; i++) await new Promise((r) => setTimeout(r, 0));
    expect(h.releaseCommit, "fixture: the commit is in flight").not.toBeNull();
    expect(h.backendOpen, "fixture: the backend still reports the transaction open").toBe(true);

    const answer = isAnyUndoTransactionOpen();
    h.releaseCommit!();
    await committing;

    expect(await answer).toBe(false);
  });

  it("a transaction that is OPEN (not committing) still counts as joined, without waiting", async () => {
    const tx = openUndoTransaction("Group drag");
    await tx.run(async () => undefined);
    await expect(isAnyUndoTransactionOpen()).resolves.toBe(true);
    const committing = tx.commit();
    for (let i = 0; i < 5 && !h.releaseCommit; i++) await new Promise((r) => setTimeout(r, 0));
    h.releaseCommit!();
    await committing;
  });
});
