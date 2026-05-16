import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "../../types";

const cases = Array.from({ length: 6000 }, (_, i) => [i]);

describe("columnToLetter format 0-5999", () => {
  it.each(cases)("col %i", (col) => {
    const result = columnToLetter(col);
    expect(result).toMatch(/^[A-Z]+$/);
  });
});

describe("round-trip 0-5999", () => {
  it.each(cases)("col %i", (col) => {
    expect(letterToColumn(columnToLetter(col))).toBe(col);
  });
});
