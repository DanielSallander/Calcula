import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppEvents, onAppEvent, emitAppEvent } from "../events";
import { CoreCommands } from "../commands";
import { columnToLetter, letterToColumn } from "../types";
import { CellRange } from "../range";
import { getSetting, setSetting, removeSetting } from "../settings";

// ============================================================================
// AppEvents uniqueness
// ============================================================================

describe("AppEvents", () => {
  it("all values are strings", () => {
    for (const [key, value] of Object.entries(AppEvents)) {
      expect(typeof value).toBe("string");
    }
  });

  it("all values are unique (no duplicates)", () => {
    const values = Object.values(AppEvents);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("all values follow the 'app:' prefix convention", () => {
    for (const value of Object.values(AppEvents)) {
      expect(value).toMatch(/^app:/);
    }
  });
});

// ============================================================================
// CoreCommands uniqueness
// ============================================================================

describe("CoreCommands", () => {
  it("all values are strings", () => {
    for (const value of Object.values(CoreCommands)) {
      expect(typeof value).toBe("string");
    }
  });

  it("all values are unique (no duplicates)", () => {
    const values = Object.values(CoreCommands);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it("all values follow the 'core.' prefix convention", () => {
    for (const value of Object.values(CoreCommands)) {
      expect(value).toMatch(/^core\./);
    }
  });
});

// ============================================================================
// columnToLetter / letterToColumn
// ============================================================================

describe("columnToLetter", () => {
  it("returns 'A' for column 0", () => {
    expect(columnToLetter(0)).toBe("A");
  });

  it("returns 'Z' for column 25", () => {
    expect(columnToLetter(25)).toBe("Z");
  });

  it("returns 'AA' for column 26", () => {
    expect(columnToLetter(26)).toBe("AA");
  });

  it("returns only uppercase A-Z strings for the valid range 0-16383", () => {
    // Check a sample across the full range
    const sampleIndices = [0, 1, 25, 26, 51, 100, 701, 702, 16383];
    for (const i of sampleIndices) {
      const result = columnToLetter(i);
      expect(result).toMatch(/^[A-Z]+$/);
    }
  });

  it("produces unique results for columns 0-702", () => {
    const seen = new Set<string>();
    for (let i = 0; i <= 702; i++) {
      const letter = columnToLetter(i);
      expect(seen.has(letter)).toBe(false);
      seen.add(letter);
    }
  });
});

describe("letterToColumn", () => {
  it("returns 0 for 'A'", () => {
    expect(letterToColumn("A")).toBe(0);
  });

  it("returns 25 for 'Z'", () => {
    expect(letterToColumn("Z")).toBe(25);
  });

  it("returns 26 for 'AA'", () => {
    expect(letterToColumn("AA")).toBe(26);
  });

  it("returns non-negative integers for valid inputs", () => {
    const inputs = ["A", "B", "Z", "AA", "AZ", "BA", "XFD"];
    for (const input of inputs) {
      const result = letterToColumn(input);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result)).toBe(true);
    }
  });

  it("round-trips with columnToLetter", () => {
    for (let i = 0; i <= 100; i++) {
      expect(letterToColumn(columnToLetter(i))).toBe(i);
    }
  });
});

// ============================================================================
// CellRange invariants
// ============================================================================

describe("CellRange", () => {
  it("rowCount is always >= 1 for valid ranges", () => {
    const range = new CellRange(0, 0, 0, 0);
    expect(range.rowCount).toBeGreaterThanOrEqual(1);
  });

  it("colCount is always >= 1 for valid ranges", () => {
    const range = new CellRange(0, 0, 0, 0);
    expect(range.colCount).toBeGreaterThanOrEqual(1);
  });

  it("cellCount equals rowCount * colCount", () => {
    const range = new CellRange(2, 3, 5, 7);
    expect(range.cellCount).toBe(range.rowCount * range.colCount);
  });

  it("fromCell creates a single-cell range", () => {
    const range = CellRange.fromCell(5, 10);
    expect(range.isSingleCell).toBe(true);
    expect(range.rowCount).toBe(1);
    expect(range.colCount).toBe(1);
  });

  it("fromAddress parses A1 notation correctly", () => {
    const range = CellRange.fromAddress("B3:D5");
    expect(range.startRow).toBe(2);
    expect(range.startCol).toBe(1);
    expect(range.endRow).toBe(4);
    expect(range.endCol).toBe(3);
  });

  it("address property round-trips through fromAddress", () => {
    const range = new CellRange(0, 0, 4, 2);
    const roundTripped = CellRange.fromAddress(range.address);
    expect(roundTripped.equals(range)).toBe(true);
  });

  it("offset preserves shape", () => {
    const range = new CellRange(0, 0, 3, 3);
    const shifted = range.offset(5, 5);
    expect(shifted.rowCount).toBe(range.rowCount);
    expect(shifted.colCount).toBe(range.colCount);
  });

  it("resize produces correct dimensions", () => {
    const range = new CellRange(0, 0, 9, 9);
    const resized = range.resize(3, 2);
    expect(resized.rowCount).toBe(3);
    expect(resized.colCount).toBe(2);
    expect(resized.startRow).toBe(range.startRow);
    expect(resized.startCol).toBe(range.startCol);
  });

  it("cells generator yields exactly cellCount items", () => {
    const range = new CellRange(0, 0, 2, 3);
    const cells = [...range.cells()];
    expect(cells.length).toBe(range.cellCount);
  });
});

// ============================================================================
// Event subscribe returns callable unsubscribe
// ============================================================================

describe("onAppEvent contract", () => {
  it("returns a function", () => {
    const unsub = onAppEvent(AppEvents.GRID_REFRESH, () => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("unsubscribe is idempotent (calling twice does not throw)", () => {
    const unsub = onAppEvent(AppEvents.GRID_REFRESH, () => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});

// ============================================================================
// Settings type preservation
// ============================================================================

describe("settings type preservation", () => {
  const EXT_ID = "__test_contracts__";

  beforeEach(() => {
    removeSetting(EXT_ID, "boolKey");
    removeSetting(EXT_ID, "numKey");
    removeSetting(EXT_ID, "strKey");
  });

  it("boolean stays boolean after set/get", () => {
    setSetting(EXT_ID, "boolKey", true);
    const result = getSetting(EXT_ID, "boolKey", false);
    expect(typeof result).toBe("boolean");
    expect(result).toBe(true);
  });

  it("number stays number after set/get", () => {
    setSetting(EXT_ID, "numKey", 42);
    const result = getSetting(EXT_ID, "numKey", 0);
    expect(typeof result).toBe("number");
    expect(result).toBe(42);
  });

  it("string stays string after set/get", () => {
    setSetting(EXT_ID, "strKey", "hello");
    const result = getSetting(EXT_ID, "strKey", "");
    expect(typeof result).toBe("string");
    expect(result).toBe("hello");
  });

  it("returns default when key not set", () => {
    const result = getSetting(EXT_ID, "missingKey", "default");
    expect(result).toBe("default");
  });
});
