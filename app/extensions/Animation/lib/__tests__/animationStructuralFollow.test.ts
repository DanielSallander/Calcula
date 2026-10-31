//! FILENAME: app/extensions/Animation/lib/__tests__/animationStructuralFollow.test.ts
// PURPOSE: BUG-0614 -- a saved animation's driver cell (a clock cell, a Monte
//          Carlo outcome cell) follows inserted and deleted rows and columns,
//          and their Undo / Redo, as a formula reference does; a deleted cell
//          is #REF! (`refDeleted`) until that edit is undone. The follow is
//          persisted WITHOUT an undo entry of its own (the structural edit is
//          the undo step). Driven through the real @api/structuralFollow journal.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api/extensionData", () => ({
  getExtensionData: vi.fn(),
  setExtensionData: vi.fn().mockResolvedValue(undefined),
  setExtensionDataUndoable: vi.fn().mockResolvedValue(undefined),
  clearExtensionData: vi.fn().mockResolvedValue(undefined),
}));

import { getExtensionData, setExtensionData, setExtensionDataUndoable } from "@api/extensionData";
import { AppEvents } from "@api/events";
import { followStructuralEdits } from "@api/structuralFollow";
import { applyStructuralStepToAnimations, getAnimation, loadAnimations } from "../animationStore";
import type { AnimationSpec } from "../../types";

const clock: AnimationSpec = {
  id: "clock",
  name: "Clock",
  sheetIndex: 0,
  driver: "clockCell",
  playback: { fps: 12, loop: false },
  clockCell: { row: 4, col: 1, from: 0, to: 10, step: 1 },
};
const mc: AnimationSpec = {
  id: "mc",
  name: "MC",
  sheetIndex: 1,
  driver: "monteCarlo",
  playback: { fps: 12, loop: false },
  monteCarlo: { sheetIndex: 1, outcomeRow: 7, outcomeCol: 3, trials: 100 },
};

async function wiredBus(active: number) {
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const subscribe = (name: string, cb: (d: unknown) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(cb);
    listeners.set(name, set);
    return () => {
      set.delete(cb);
    };
  };
  let chain: Promise<unknown> = Promise.resolve();
  followStructuralEdits(
    (step) => {
      chain = chain.then(() => applyStructuralStepToAnimations(step));
    },
    { subscribe, activeSheet: () => active },
  );
  return async (name: string, detail?: unknown) => {
    for (const cb of listeners.get(name) ?? []) cb(detail);
    await chain;
  };
}

beforeEach(async () => {
  vi.mocked(getExtensionData).mockResolvedValue({ animations: [clock, mc] });
  vi.mocked(setExtensionData).mockClear();
  vi.mocked(setExtensionDataUndoable).mockClear();
  await loadAnimations();
});

describe("animation driver cells follow structural edits (BUG-0614)", () => {
  it("a clock cell moves with an inserted row and back on Undo, persisted with no undo entry of its own", async () => {
    const emit = await wiredBus(0);
    await emit(AppEvents.ROWS_INSERTED, { startRow: 2, count: 3 });
    expect(getAnimation("clock")?.clockCell).toMatchObject({ row: 7, col: 1 });
    expect(getAnimation("mc")?.monteCarlo).toMatchObject({ outcomeRow: 7, outcomeCol: 3 });
    expect(setExtensionData).toHaveBeenCalledTimes(1);
    expect(setExtensionDataUndoable).not.toHaveBeenCalled();
    await emit(AppEvents.STRUCTURAL_UNDO, { description: "Insert 3 row(s)", source: "undo", deltas: [{ kind: "rowDelete", sheetIndex: 0, at: 2, count: 3, band: null }] });
    expect(getAnimation("clock")?.clockCell).toMatchObject({ row: 4, col: 1 });
  });

  it("a Monte Carlo outcome cell on another sheet follows that sheet's column edit", async () => {
    const emit = await wiredBus(0);
    await emit(AppEvents.STRUCTURAL_EDIT_ELSEWHERE, {
      descriptions: ["Delete Columns"],
      edits: [{ sheetIndex: 1, kind: "colDelete", at: 0, count: 2 }],
    });
    expect(getAnimation("mc")?.monteCarlo).toMatchObject({ outcomeRow: 7, outcomeCol: 1 });
    expect(getAnimation("clock")?.clockCell).toMatchObject({ row: 4, col: 1 });
  });

  it("a deleted driver cell is #REF! (refDeleted) and its Undo clears it at the old address", async () => {
    const emit = await wiredBus(0);
    await emit(AppEvents.ROWS_DELETED, { startRow: 4, count: 1 });
    expect(getAnimation("clock")?.refDeleted).toBe(true);
    expect(getAnimation("clock")?.clockCell).toMatchObject({ row: 4, col: 1 });
    await emit(AppEvents.STRUCTURAL_UNDO, { description: "Delete 1 row(s)", source: "undo", deltas: [{ kind: "rowInsert", sheetIndex: 0, at: 4, count: 1, band: null }] });
    expect(getAnimation("clock")?.refDeleted).toBeUndefined();
    expect(getAnimation("clock")?.clockCell).toMatchObject({ row: 4, col: 1 });
  });
});
