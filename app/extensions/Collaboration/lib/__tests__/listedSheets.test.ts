import { describe, expect, it } from "vitest";
import { listedIndices } from "../listedSheets";

describe("listedIndices", () => {
  it("drops an index the checkbox list does not show (a floating range's backing sheet)", () => {
    const sheets = [{ index: 0 }, { index: 1 }];
    expect(listedIndices([0, 1, 2], sheets)).toEqual([0, 1]);
  });

  it("sorts, and passes everything through while the list has not loaded", () => {
    expect(listedIndices(new Set([3, 1]), undefined)).toEqual([1, 3]);
  });

  it("an empty list admits nothing", () => {
    expect(listedIndices([0, 2], [])).toEqual([]);
  });
});
