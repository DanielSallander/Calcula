import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "./types";

// ---------------------------------------------------------------------------
// columnToLetter
// ---------------------------------------------------------------------------
describe("columnToLetter", () => {
  it("converts 0 to A", () => {
    expect(columnToLetter(0)).toBe("A");
  });

  it("converts 1 to B", () => {
    expect(columnToLetter(1)).toBe("B");
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

  it("converts 703 to AAB", () => {
    expect(columnToLetter(703)).toBe("AAB");
  });

  it("converts 18277 to AAAA", () => {
    // 26 + 26^2 + 26^3 = 18278, so index 18278 = AAAA
    expect(columnToLetter(18278)).toBe("AAAA");
  });

  it("converts sequential columns correctly around single-to-double boundary", () => {
    expect(columnToLetter(24)).toBe("Y");
    expect(columnToLetter(25)).toBe("Z");
    expect(columnToLetter(26)).toBe("AA");
    expect(columnToLetter(27)).toBe("AB");
  });
});

// ---------------------------------------------------------------------------
// letterToColumn
// ---------------------------------------------------------------------------
describe("letterToColumn", () => {
  it("converts A to 0", () => {
    expect(letterToColumn("A")).toBe(0);
  });

  it("converts B to 1", () => {
    expect(letterToColumn("B")).toBe(1);
  });

  it("converts Z to 25", () => {
    expect(letterToColumn("Z")).toBe(25);
  });

  it("converts AA to 26", () => {
    expect(letterToColumn("AA")).toBe(26);
  });

  it("converts AB to 27", () => {
    expect(letterToColumn("AB")).toBe(27);
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

  it("converts AAB to 703", () => {
    expect(letterToColumn("AAB")).toBe(703);
  });

  describe("edge cases", () => {
    it("handles single letter at end of alphabet", () => {
      expect(letterToColumn("Z")).toBe(25);
    });

    it("handles three-letter column", () => {
      expect(letterToColumn("AAA")).toBe(702);
    });
  });
});

// ---------------------------------------------------------------------------
// Round-trip: columnToLetter(letterToColumn(x)) === x
// ---------------------------------------------------------------------------
describe("round-trip conversions", () => {
  it("round-trips single-letter columns A-Z", () => {
    for (let i = 0; i < 26; i++) {
      const letter = columnToLetter(i);
      expect(letterToColumn(letter)).toBe(i);
    }
  });

  it("round-trips double-letter columns AA-AZ", () => {
    for (let i = 26; i <= 51; i++) {
      const letter = columnToLetter(i);
      expect(letterToColumn(letter)).toBe(i);
    }
  });

  it("round-trips double-letter columns BA-BZ", () => {
    for (let i = 52; i <= 77; i++) {
      const letter = columnToLetter(i);
      expect(letterToColumn(letter)).toBe(i);
    }
  });

  it("round-trips ZZ boundary", () => {
    const letter = columnToLetter(701);
    expect(letter).toBe("ZZ");
    expect(letterToColumn(letter)).toBe(701);
  });

  it("round-trips triple-letter columns AAA-AAZ", () => {
    for (let i = 702; i <= 727; i++) {
      const letter = columnToLetter(i);
      expect(letterToColumn(letter)).toBe(i);
    }
  });

  it("round-trips letterToColumn(columnToLetter(n)) for first 1000 columns", () => {
    for (let i = 0; i < 1000; i++) {
      const letter = columnToLetter(i);
      expect(letterToColumn(letter)).toBe(i);
    }
  });

  it("round-trips columnToLetter(letterToColumn(x)) for known values", () => {
    const values = ["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA", "AAB"];
    for (const v of values) {
      expect(columnToLetter(letterToColumn(v))).toBe(v);
    }
  });
});
