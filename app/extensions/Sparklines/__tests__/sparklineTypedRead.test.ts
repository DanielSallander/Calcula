//! FILENAME: app/extensions/Sparklines/__tests__/sparklineTypedRead.test.ts
// PURPOSE: P2 S10 -- a sparkline plots each cell's TYPED value, never its
//          display text re-parsed. The old reader stripped the display to
//          digits, dots and minus and parseFloat'ed the rest, so in sv-SE
//          "1 234,50 kr" plotted 123450 and an ISO date "2024-01-15" plotted
//          2024 (the BUG-0407 class).

import { describe, it, expect, vi, beforeEach } from "vitest";

const typedRead = vi.fn();
vi.mock("@api/lib", () => ({
  getRangeCellsTyped: (...args: unknown[]) => typedRead(...args),
}));

import { fetchGroupData, sparklineCellNumber } from "../rendering";
import type { SparklineGroup } from "../types";

function group(dataRange: SparklineGroup["dataRange"], location: SparklineGroup["location"]): SparklineGroup {
  return { id: 1, dataRange, location } as unknown as SparklineGroup;
}

beforeEach(() => {
  typedRead.mockReset();
});

describe("sparklineCellNumber", () => {
  it("a number cell is its value, whatever it shows", () => {
    expect(sparklineCellNumber({ type: "number", value: 1234.5 })).toBe(1234.5);
    expect(sparklineCellNumber({ type: "number", value: 45306 })).toBe(45306);
  });

  it("text, booleans, errors and empty cells are gaps (NaN)", () => {
    expect(sparklineCellNumber({ type: "text", value: "1 234,50" })).toBeNaN();
    expect(sparklineCellNumber({ type: "boolean", value: true })).toBeNaN();
    expect(sparklineCellNumber({ type: "error", value: "#DIV/0!" })).toBeNaN();
    expect(sparklineCellNumber({ type: "empty", value: null })).toBeNaN();
    expect(sparklineCellNumber(null)).toBeNaN();
  });
});

describe("fetchGroupData reads typed values", () => {
  it('sv-SE "1 234,50 kr" plots 1234.5 (it plotted 123450), an ISO date plots its serial', async () => {
    typedRead.mockResolvedValue([
      { row: 0, col: 0, type: "number", value: 1234.5, display: "1 234,50 kr", formula: null },
      { row: 0, col: 1, type: "number", value: 45306, display: "2024-01-15", formula: null },
      // (0,2) absent: the typed read is sparse, an absent cell is a gap
      { row: 0, col: 3, type: "text", value: "n/a", display: "n/a", formula: null },
      { row: 0, col: 4, type: "number", value: -2.5, display: "-2,5", formula: null },
    ]);
    const slices = await fetchGroupData(
      group({ startRow: 0, startCol: 0, endRow: 0, endCol: 4 }, { startRow: 0, startCol: 6, endRow: 0, endCol: 6 }),
      "byRow",
    );
    expect(typedRead).toHaveBeenCalledTimes(1);
    expect(typedRead).toHaveBeenCalledWith(0, 0, 0, 4);
    expect(slices).toHaveLength(1);
    const [a, b, c, d, e] = slices[0];
    expect(a).toBe(1234.5);
    expect(b).toBe(45306);
    expect(c).toBeNaN();
    expect(d).toBeNaN();
    expect(e).toBe(-2.5);
  });

  it("byCol slices a two-column range per column, offset by the range origin", async () => {
    typedRead.mockResolvedValue([
      { row: 5, col: 2, type: "number", value: 1, display: "1", formula: null },
      { row: 6, col: 2, type: "number", value: 2, display: "2", formula: null },
      { row: 5, col: 3, type: "number", value: 10, display: "10", formula: null },
      { row: 6, col: 3, type: "number", value: 20.5, display: "20,5", formula: null },
    ]);
    const slices = await fetchGroupData(
      group({ startRow: 5, startCol: 2, endRow: 6, endCol: 3 }, { startRow: 8, startCol: 2, endRow: 8, endCol: 3 }),
      "byCol",
    );
    expect(slices).toEqual([[1, 2], [10, 20.5]]);
  });
});
