//! FILENAME: app/src/core/types/columnConversion.test.ts
// PURPOSE: Tests for column letter <-> index conversion functions

import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "./types";

// ============================================================================
// columnToLetter
// ============================================================================

describe("columnToLetter", () => {
  it("converts 0 to A", () => {
    expect(columnToLetter(0)).toBe("A");
  });

  it("converts 25 to Z", () => {
    expect(columnToLetter(25)).toBe("Z");
  });

  it("converts 26 to AA", () => {
    expect(columnToLetter(26)).toBe("AA");
  });

  it("converts 27 to AB", () => {
    expect(columnToLetter(27)).toBe("AB");
  });

  it("converts 51 to AZ", () => {
    expect(columnToLetter(51)).toBe("AZ");
  });

  it("converts 52 to BA", () => {
    expect(columnToLetter(52)).toBe("BA");
  });

  it("converts 701 to ZZ", () => {
    expect(columnToLetter(701)).toBe("ZZ");
  });

  it("converts 702 to AAA", () => {
    expect(columnToLetter(702)).toBe("AAA");
  });

  it("handles Excel max column 16383 (XFD)", () => {
    expect(columnToLetter(16383)).toBe("XFD");
  });
});

// ============================================================================
// letterToColumn
// ============================================================================

describe("letterToColumn", () => {
  it("converts A to 0", () => {
    expect(letterToColumn("A")).toBe(0);
  });

  it("converts Z to 25", () => {
    expect(letterToColumn("Z")).toBe(25);
  });

  it("converts AA to 26", () => {
    expect(letterToColumn("AA")).toBe(26);
  });

  it("converts AZ to 51", () => {
    expect(letterToColumn("AZ")).toBe(51);
  });

  it("converts BA to 52", () => {
    expect(letterToColumn("BA")).toBe(52);
  });

  it("converts ZZ to 701", () => {
    expect(letterToColumn("ZZ")).toBe(701);
  });

  it("converts AAA to 702", () => {
    expect(letterToColumn("AAA")).toBe(702);
  });

  it("converts XFD to 16383", () => {
    expect(letterToColumn("XFD")).toBe(16383);
  });
});

// ============================================================================
// Round-trip consistency
// ============================================================================

describe("columnToLetter <-> letterToColumn round-trip", () => {
  it("round-trips for first 100 columns", () => {
    for (let i = 0; i < 100; i++) {
      expect(letterToColumn(columnToLetter(i))).toBe(i);
    }
  });

  it("round-trips for boundary values", () => {
    for (const i of [0, 25, 26, 51, 52, 701, 702, 16383]) {
      expect(letterToColumn(columnToLetter(i))).toBe(i);
    }
  });
});
