//! FILENAME: app/extensions/MacroRecorder/__tests__/a1.test.ts
// PURPOSE: The A1 parsing behind the "place the button at" field, and the
//          anchor-derived control id the button script is bound by.
// CONTEXT: The id is the ONLY thing that makes the control the recorder creates
//          and the object script it saves refer to the same button, so its
//          shape is pinned here.

import { describe, it, expect } from "vitest";
import { formatA1, parseA1 } from "../lib/a1";
import { controlInstanceId } from "../lib/buttonScript";

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

describe("controlInstanceId", () => {
  it("derives the anchor id the object-script host expects", () => {
    expect(controlInstanceId(0, 5, 10)).toBe("control-0-5-10");
    expect(controlInstanceId(2, 0, 0)).toBe("control-2-0-0");
  });
});
