//! FILENAME: app/src/core/lib/__tests__/cellsMovedPerStep.test.ts
// PURPOSE: The remembered JOINED moves (cellsMoved.ts) belong to the outer
//          step they joined: a step's close releases only its own, and a
//          take-back hands back only its own step's moves.
// CONTEXT: Bug-ledger fix programme, round 18 (rev16B minor): the release was
//          global, so a granted run whose step closed dropped the move another
//          step's gesture had announced, and that step's take-back then left a
//          bookmark or watch at the destination while the cells went back.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { announceCellsMoved, announceRolledBackRestore, releaseAnnouncedMoves } from "../cellsMoved";
import { onAppEvent, AppEvents } from "../../../api/events";
import type { UndoResult } from "../tauri-api";

/** A take-back whose deltas undo the move A1 -> C1 on sheet 0. */
function takeBackOfA1ToC1(): UndoResult {
  return {
    success: true,
    description: "Paste",
    updatedCells: [],
    structuralDeltas: [
      { kind: "move", fromSheetIndex: 0, fromStartRow: 0, fromStartCol: 2, fromEndRow: 0, fromEndCol: 2, toSheetIndex: 0, toRow: 0, toCol: 0 },
    ],
  } as unknown as UndoResult;
}

let handedBack: unknown[] = [];
let off: (() => void) | null = null;

beforeEach(() => {
  releaseAnnouncedMoves();
  handedBack = [];
  off = onAppEvent(AppEvents.CELLS_MOVED, (p) => {
    if ((p as { source?: string }).source === "rollback") handedBack.push(p);
  });
});

afterEach(() => {
  off?.();
  releaseAnnouncedMoves();
});

describe("remembered joined moves are per step (round 18)", () => {
  it("closing ANOTHER step keeps a step's remembered move, and its own take-back hands it back", () => {
    // A gesture inside step 7 moved A1 -> C1 (joined, tagged 7).
    announceCellsMoved(0, 0, 0, 0, 0, 0, 0, 2, 7);
    // A run whose step is 9 closes: it must not release step 7's move.
    releaseAnnouncedMoves(9);
    announceRolledBackRestore(takeBackOfA1ToC1(), 7);
    expect(handedBack, "another step's close dropped this step's remembered move").toHaveLength(1);
  });

  it("a take-back of ANOTHER step does not consume a step's remembered move", () => {
    announceCellsMoved(0, 0, 0, 0, 0, 0, 0, 2, 7);
    announceRolledBackRestore(takeBackOfA1ToC1(), 8);
    expect(handedBack, "a take-back of step 8 handed back a move step 7 had announced").toEqual([]);
    announceRolledBackRestore(takeBackOfA1ToC1(), 7);
    expect(handedBack).toHaveLength(1);
  });

  it("a step's own close releases its moves (and untagged ones); a reset releases every one", () => {
    announceCellsMoved(0, 0, 0, 0, 0, 0, 0, 2, 7);
    releaseAnnouncedMoves(7);
    announceRolledBackRestore(takeBackOfA1ToC1(), 7);
    expect(handedBack, "a closed step's move was still handed back").toEqual([]);

    announceCellsMoved(0, 0, 0, 0, 0, 0, 0, 2, true);
    releaseAnnouncedMoves(7);
    announceRolledBackRestore(takeBackOfA1ToC1(), 7);
    expect(handedBack, "an untagged move survived the close of the step that was open").toEqual([]);

    announceCellsMoved(0, 0, 0, 0, 0, 0, 0, 2, 3);
    releaseAnnouncedMoves();
    announceRolledBackRestore(takeBackOfA1ToC1(), 3);
    expect(handedBack, "a document reset kept a remembered move").toEqual([]);
  });

  it("a move that did not join an outer step is never remembered", () => {
    announceCellsMoved(0, 0, 0, 0, 0, 0, 0, 2, false);
    announceRolledBackRestore(takeBackOfA1ToC1(), 7);
    expect(handedBack).toEqual([]);
  });
});
