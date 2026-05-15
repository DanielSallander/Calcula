//! FILENAME: app/extensions/TestRunner/lib/__tests__/assertions.test.ts
// PURPOSE: Tests for TestRunner assertion helpers.

import { describe, it, expect } from "vitest";

// Mock @api/types - assertions only use the CellData type
vi.mock("@api/types", () => ({}));

import {
  expectCellValue,
  expectCellEmpty,
  expectCellFormula,
  expectSelection,
  assertEqual,
  assertTrue,
  expectNotNull,
  expectCellNotEmpty,
  expectCellContains,
  expectArrayLength,
  expectThrows,
} from "../assertions";
import { vi } from "vitest";
import type { CellData } from "@api/types";

function makeCell(overrides: Partial<CellData> = {}): CellData {
  return {
    row: 0,
    col: 0,
    display: "",
    formula: null,
    styleIndex: 0,
    ...overrides,
  } as CellData;
}

describe("TestRunner assertions", () => {
  describe("expectCellValue", () => {
    it("passes when display matches", () => {
      expect(() => expectCellValue(makeCell({ display: "Hello" }), "Hello", "A1")).not.toThrow();
    });

    it("throws when display differs", () => {
      expect(() => expectCellValue(makeCell({ display: "Foo" }), "Bar", "A1")).toThrow(
        'Cell A1: expected display "Bar", got "Foo"'
      );
    });

    it("treats null cell as null display", () => {
      expect(() => expectCellValue(null, "X", "B2")).toThrow('got "null"');
    });
  });

  describe("expectCellEmpty", () => {
    it("passes for null cell", () => {
      expect(() => expectCellEmpty(null, "A1")).not.toThrow();
    });

    it("passes for empty display", () => {
      expect(() => expectCellEmpty(makeCell({ display: "" }), "A1")).not.toThrow();
    });

    it("throws for non-empty cell", () => {
      expect(() => expectCellEmpty(makeCell({ display: "data" }), "C3")).toThrow(
        'Cell C3: expected empty, got "data"'
      );
    });
  });

  describe("expectCellFormula", () => {
    it("passes when formula matches", () => {
      expect(() =>
        expectCellFormula(makeCell({ formula: "=SUM(A1:A10)" } as any), "=SUM(A1:A10)", "D1")
      ).not.toThrow();
    });

    it("throws when formula differs", () => {
      expect(() =>
        expectCellFormula(makeCell({ formula: "=A1" } as any), "=B1", "D1")
      ).toThrow('expected formula "=B1", got "=A1"');
    });

    it("treats null cell as null formula", () => {
      expect(() => expectCellFormula(null, "=A1", "E1")).toThrow('got "null"');
    });
  });

  describe("expectSelection", () => {
    const sel = { startRow: 0, startCol: 0, endRow: 5, endCol: 3 };

    it("passes on exact match", () => {
      expect(() => expectSelection(sel, sel)).not.toThrow();
    });

    it("throws on null actual", () => {
      expect(() => expectSelection(null, sel)).toThrow("got null");
    });

    it("throws on mismatch", () => {
      expect(() =>
        expectSelection({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, sel)
      ).toThrow("Selection mismatch");
    });
  });

  describe("assertEqual", () => {
    it("passes for equal values", () => {
      expect(() => assertEqual(42, 42)).not.toThrow();
    });

    it("throws with custom message", () => {
      expect(() => assertEqual(1, 2, "count")).toThrow("count: expected 2, got 1");
    });
  });

  describe("assertTrue", () => {
    it("passes for truthy", () => {
      expect(() => assertTrue(true, "should be true")).not.toThrow();
      expect(() => assertTrue(1, "nonzero")).not.toThrow();
    });

    it("throws for falsy", () => {
      expect(() => assertTrue(false, "nope")).toThrow("Assertion failed: nope");
      expect(() => assertTrue(0, "zero")).toThrow("Assertion failed: zero");
      expect(() => assertTrue(null, "null")).toThrow("Assertion failed: null");
    });
  });

  describe("expectNotNull", () => {
    it("passes for non-null", () => {
      expect(() => expectNotNull("hello", "val")).not.toThrow();
      expect(() => expectNotNull(0, "zero is ok")).not.toThrow();
    });

    it("throws for null/undefined", () => {
      expect(() => expectNotNull(null, "was null")).toThrow("Expected non-null: was null");
      expect(() => expectNotNull(undefined, "was undef")).toThrow("Expected non-null: was undef");
    });
  });

  describe("expectCellNotEmpty", () => {
    it("passes for cell with content", () => {
      expect(() => expectCellNotEmpty(makeCell({ display: "data" }), "A1")).not.toThrow();
    });

    it("throws for null cell", () => {
      expect(() => expectCellNotEmpty(null, "A1")).toThrow('expected non-empty, got "null"');
    });

    it("throws for empty display", () => {
      expect(() => expectCellNotEmpty(makeCell({ display: "" }), "A1")).toThrow(
        'expected non-empty, got ""'
      );
    });
  });

  describe("expectCellContains", () => {
    it("passes when substring found", () => {
      expect(() =>
        expectCellContains(makeCell({ display: "Hello World" }), "World", "A1")
      ).not.toThrow();
    });

    it("throws when substring missing", () => {
      expect(() =>
        expectCellContains(makeCell({ display: "Hello" }), "World", "A1")
      ).toThrow('expected display to contain "World", got "Hello"');
    });
  });

  describe("expectArrayLength", () => {
    it("passes on correct length", () => {
      expect(() => expectArrayLength([1, 2, 3], 3)).not.toThrow();
    });

    it("throws on wrong length", () => {
      expect(() => expectArrayLength([], 1, "items")).toThrow(
        "items: expected array length 1, got 0"
      );
    });
  });

  describe("expectThrows", () => {
    it("passes when function throws", async () => {
      await expect(
        expectThrows(async () => {
          throw new Error("boom");
        }, "should throw")
      ).resolves.toBeUndefined();
    });

    it("throws when function does not throw", async () => {
      await expect(
        expectThrows(async () => {
          /* no-op */
        }, "should throw")
      ).rejects.toThrow("Expected to throw: should throw");
    });
  });
});
