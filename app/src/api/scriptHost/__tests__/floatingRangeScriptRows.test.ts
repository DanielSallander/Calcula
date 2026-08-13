//! FILENAME: app/src/api/scriptHost/__tests__/floatingRangeScriptRows.test.ts
// PURPOSE: The five floating-range rows sit at the same bar as every other
//          workbook-object row (unlocked, no capability, honest undo language)
//          — and the setState aspect door REFUSES the kind by name, so these
//          rows are provably the object's entire script surface.
// CONTEXT: `vSetState`'s ladder ends in `return true` (the shape.setProperty
//          lesson): any enumerable kind whose aspects are not explicitly gated
//          is open at restricted tier with no capability. "floatingRange" is
//          enumerable (SCRIPT_OBJECT_KINDS), so the refusal below is
//          load-bearing, not defensive.

import { describe, it, expect } from "vitest";
import {
  vCreateFloatingRange,
  vFloatingRangeResize,
  vFloatingRangeSetCells,
  vObjectId,
  vSetState,
} from "../validators";
import { ALLOWLIST } from "../allowlist";
import { SCRIPT_OBJECT_KINDS, floatingRangeToRef } from "../objectInventory";

// ============================================================================
// 1. The allowlist rows
// ============================================================================

describe("the floating range rows are ordinary workbook-object rows", () => {
  it("puts all five at unlocked tier with NO capability, like the shape rows", () => {
    for (const key of [
      "api.createFloatingRange",
      "api.deleteFloatingRange",
      "api.floatingRangeSetCells",
      "api.floatingRangeGetCells",
      "api.floatingRangeResize",
    ] as const) {
      const row = ALLOWLIST[key];
      expect(row, key).toBeDefined();
      expect(row.tier, key).toBe("unlocked");
      expect(row.capability, key).toBeUndefined();
    }
    expect(ALLOWLIST["api.floatingRangeGetCells"].class).toBe("read");
    expect(ALLOWLIST["api.createFloatingRange"].class).toBe("mutate");
    expect(ALLOWLIST["api.deleteFloatingRange"].validate).toBe(vObjectId);
  });

  it("tells the truth about undo in the consent text", () => {
    // Create keeps the history but is itself not undoable; delete ENDS the
    // history (sheet-delete doctrine). Cell writes are ordinary undoable
    // edits, and the setCells row says so.
    expect(ALLOWLIST["api.createFloatingRange"].desc).toMatch(/not undoable/i);
    expect(ALLOWLIST["api.deleteFloatingRange"].desc).toMatch(/ends the undo history/i);
    expect(ALLOWLIST["api.floatingRangeSetCells"].desc).toMatch(/undoable/i);
  });

  it("is an enumerable kind", () => {
    expect(SCRIPT_OBJECT_KINDS.has("floatingRange")).toBe(true);
  });
});

// ============================================================================
// 2. The aspect door is CLOSED for this kind
// ============================================================================

describe("the setState doors refuse floatingRange aspects by name", () => {
  it("refuses every floatingRange.* aspect with a pointer at the real rows", () => {
    for (const aspect of [
      "floatingRange.resize",
      "floatingRange.setCells",
      "floatingRange.rename",
      "floatingRange.setGeometry",
      "floatingRange.anythingAtAll",
    ]) {
      const verdict = vSetState([aspect, []]);
      expect(typeof verdict, aspect).toBe("string");
      expect(String(verdict)).toMatch(/api\.createFloatingRange/);
    }
  });
});

// ============================================================================
// 3. The validators
// ============================================================================

describe("vCreateFloatingRange", () => {
  it("accepts no options, and a full options object", () => {
    expect(vCreateFloatingRange([undefined])).toBe(true);
    expect(
      vCreateFloatingRange([{ name: "Rates", x: 100, y: 50, rows: 5, cols: 3 }]),
    ).toBe(true);
  });
  it("refuses unknown keys — no sheet argument exists by design", () => {
    expect(typeof vCreateFloatingRange([{ sheetIndex: 2 }])).toBe("string");
  });
  it("bounds the window and the position", () => {
    expect(typeof vCreateFloatingRange([{ rows: 0 }])).toBe("string");
    expect(typeof vCreateFloatingRange([{ rows: 1001 }])).toBe("string");
    expect(typeof vCreateFloatingRange([{ cols: 257 }])).toBe("string");
    expect(typeof vCreateFloatingRange([{ x: -1 }])).toBe("string");
    expect(typeof vCreateFloatingRange([{ x: Number.NaN }])).toBe("string");
  });
  it("bounds the name to the sheet-name length", () => {
    expect(typeof vCreateFloatingRange([{ name: "" }])).toBe("string");
    expect(typeof vCreateFloatingRange([{ name: "x".repeat(32) }])).toBe("string");
  });
});

describe("vFloatingRangeSetCells", () => {
  const ID = "11111111-1111-7111-8111-111111111111";
  it("accepts a rectangular block of primitives", () => {
    expect(
      vFloatingRangeSetCells([ID, 0, 0, [["=A1*2", 42], [true, null]]]),
    ).toBe(true);
  });
  it("refuses a ragged block", () => {
    expect(typeof vFloatingRangeSetCells([ID, 0, 0, [[1, 2], [3]]])).toBe("string");
  });
  it("refuses non-primitive cells — nothing object-shaped can ride in", () => {
    expect(typeof vFloatingRangeSetCells([ID, 0, 0, [[{ evil: 1 }]]])).toBe("string");
  });
  it("caps the total cell count", () => {
    const tooMany = Array.from({ length: 101 }, () => Array.from({ length: 100 }, () => 1));
    expect(typeof vFloatingRangeSetCells([ID, 0, 0, tooMany])).toBe("string");
  });
});

describe("vFloatingRangeResize", () => {
  it("bounds both axes", () => {
    expect(vFloatingRangeResize(["id-1", 10, 4])).toBe(true);
    expect(typeof vFloatingRangeResize(["id-1", 0, 4])).toBe("string");
    expect(typeof vFloatingRangeResize(["id-1", 10, 257])).toBe("string");
    expect(typeof vFloatingRangeResize(["", 10, 4])).toBe("string");
  });
});

// ============================================================================
// 4. The mapper
// ============================================================================

describe("floatingRangeToRef", () => {
  it("reports the HOST sheet and the window as an A1 rect", () => {
    const ref = floatingRangeToRef({
      id: "fr-1",
      name: "Rates",
      hostSheetIndex: 2,
      rowCount: 4,
      colCount: 2,
    });
    expect(ref.kind).toBe("floatingRange");
    expect(ref.sheetIndex).toBe(2);
    expect(ref.range).toBe("A1:B4");
    expect(ref.rowCount).toBe(4);
    expect(ref.columnCount).toBe(2);
  });
});
