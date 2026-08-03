//! FILENAME: app/extensions/MacroRecorder/__tests__/a1.test.ts
// PURPOSE: The A1 parsing behind the "place the button at" field.
// CONTEXT: The control id the button script binds to used to be derived HERE,
//          from the anchor. It no longer is: the Controls extension owns the
//          control and hands its instanceId back through the
//          @api/buttonControlService seam, because a recorder that re-derives
//          another extension's id format is one rename away from a button and a
//          script that never meet. That contract lives in buttonScript.test.ts.

import { describe, it, expect } from "vitest";
import { formatA1, parseA1 } from "../lib/a1";

describe("parseA1", () => {
  it("parses plain references", () => {
    expect(parseA1("A1")).toEqual({ row: 0, col: 0 });
    expect(parseA1("B3")).toEqual({ row: 2, col: 1 });
    expect(parseA1("AA10")).toEqual({ row: 9, col: 26 });
  });

  it("tolerates absolute markers, whitespace and lower case", () => {
    expect(parseA1(" $b$7 ")).toEqual({ row: 6, col: 1 });
    expect(parseA1("aa1")).toEqual({ row: 0, col: 26 });
  });

  it("rejects anything that is not a single cell", () => {
    expect(parseA1("A1:B2")).toBeNull();
    expect(parseA1("A0")).toBeNull();
    expect(parseA1("1A")).toBeNull();
    expect(parseA1("")).toBeNull();
    expect(parseA1("Sheet1!A1")).toBeNull();
  });

  it("round-trips with formatA1", () => {
    for (const [row, col] of [
      [0, 0],
      [9, 25],
      [99, 26],
      [1048575, 16383],
    ]) {
      expect(parseA1(formatA1(row, col))).toEqual({ row, col });
    }
  });
});
