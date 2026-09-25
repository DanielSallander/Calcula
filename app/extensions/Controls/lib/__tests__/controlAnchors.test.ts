//! FILENAME: app/extensions/Controls/lib/__tests__/controlAnchors.test.ts
// PURPOSE: The free-anchor allocator and the creation queue, on their own.
// CONTEXT: Moved out of controlClipboard.ts so paste, duplicate and the three
//          create seams share ONE rule for "which cell is free". The provider
//          tests (controlPlacement.test.ts) prove the rule end to end; these pin
//          the two properties that are easy to lose in a refactor: the
//          historical choice (row 0, right of the right-most anchor), and a
//          queue that is FIFO and survives a rejected task.

import { describe, it, expect, vi } from "vitest";

vi.mock("../controlApi", () => ({
  getAllControls: vi.fn(async () => []),
}));

import {
  ANCHOR_COLUMN_COUNT,
  pickFreeAnchorCell,
  requestedAnchor,
  requestedPosition,
  runControlCreation,
} from "../controlAnchors";

describe("pickFreeAnchorCell", () => {
  it("an empty sheet gets A1", () => {
    expect(pickFreeAnchorCell([])).toEqual({ row: 0, col: 0 });
  });

  it("row 0, one column right of the right-most anchor (the paste rule)", () => {
    expect(
      pickFreeAnchorCell([
        { row: 9, col: 3 },
        { row: 0, col: 1 },
      ]),
    ).toEqual({ row: 0, col: 4 });
  });

  it("falls back to the first free cell when the last column is taken", () => {
    const occupied = [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: ANCHOR_COLUMN_COUNT - 1 },
    ];
    const cell = pickFreeAnchorCell(occupied);
    expect(cell).toEqual({ row: 0, col: 2 });
    expect(occupied.some((o) => o.row === cell.row && o.col === cell.col)).toBe(false);
  });
});

describe("request validation", () => {
  it("a position needs both coordinates", () => {
    expect(requestedPosition({ sheetIndex: 0 })).toBeNull();
    expect(requestedPosition({ sheetIndex: 0, x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(() => requestedPosition({ sheetIndex: 0, y: 4 })).toThrow(/both x and y/);
  });

  it("an anchor needs both halves, as whole non-negative numbers", () => {
    expect(requestedAnchor({ sheetIndex: 0 })).toBeNull();
    expect(requestedAnchor({ sheetIndex: 0, row: 3, col: 2 })).toEqual({ row: 3, col: 2 });
    expect(() => requestedAnchor({ sheetIndex: 0, row: 3 })).toThrow(/both row and col/);
    expect(() => requestedAnchor({ sheetIndex: 0, row: 1.5, col: 2 })).toThrow(/whole row/);
  });
});

describe("runControlCreation", () => {
  it("runs tasks one at a time, in order", async () => {
    const log: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}:end`);
      return name;
    };
    const results = await Promise.all([
      runControlCreation(slow("a", 20)),
      runControlCreation(slow("b", 0)),
    ]);
    expect(results).toEqual(["a", "b"]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("a rejected task does not poison the queue", async () => {
    await expect(
      runControlCreation(async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    await expect(runControlCreation(async () => 42)).resolves.toBe(42);
  });
});
