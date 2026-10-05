//! FILENAME: app/src/shell/SheetTabs/__tests__/sheetPlacement.test.ts
// PURPOSE: The arithmetic behind Insert Sheet (BEFORE the active sheet, Excel's
//          Shift+F11) and Move or Copy Sheet..., proved against a model of the
//          backend's own moves rather than against hand-picked answers.
// CONTEXT: The backend can only APPEND a sheet (`add_sheet` -> the end of the
//          user prefix), COPY one to right after its source (`copy_sheet`), and
//          ROTATE one sheet to a new position (`move_sheet`, `rotate_element`:
//          remove at `from`, insert at `to`). Every placement the Home tab
//          offers is one of those followed by a rotate, and the rotate target
//          is where off-by-one errors live: "before C" is `C - 1` when the
//          sheet moves right and `C` when it moves left. So the tests below
//          enumerate EVERY (source, before) pair on a small workbook, run the
//          same steps the strip runs, and check the order that comes out.

import { describe, it, expect } from "vitest";
import {
  findSameSheet,
  moveTargetBefore,
  lastSheetIndex,
  moveTargetFor,
  insertionReorderDetail,
  removalReorderDetail,
  type PlacedSheet,
} from "../sheetPlacement";

// ---------------------------------------------------------------------------
// A model of the backend, by its own definitions
// ---------------------------------------------------------------------------

/** `rotate_element` (sheets.rs): remove at `from`, insert at `to`. */
function rotate<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/** The sheet list as `getSheets()` reports it: each row carries its TRUE index. */
function listed(names: readonly string[]): PlacedSheet[] {
  return names.map((name, index) => ({ index, name, sheetId: `id-${name}`, visibility: "visible" }));
}

const NAMES = ["A", "B", "C", "D", "E"] as const;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("findSameSheet follows a sheet by identity, never by index", () => {
  it("finds the sheet by its stable id after it moved", () => {
    const after = [
      { index: 0, name: "New", sheetId: "id-new" },
      { index: 1, name: "B", sheetId: "id-B" },
    ];
    expect(findSameSheet(after, { index: 0, name: "B", sheetId: "id-B" })?.index).toBe(1);
  });

  it("falls back to the name when the backend sent no id", () => {
    const after = [
      { index: 0, name: "New" },
      { index: 1, name: "B" },
    ];
    expect(findSameSheet(after, { index: 0, name: "B" })?.index).toBe(1);
  });

  it("does NOT fall back to the name when both sides carry ids that differ", () => {
    // A sheet that was deleted and re-created under the same name is not the
    // same sheet; its id says so.
    const after = [{ index: 0, name: "B", sheetId: "id-other" }];
    expect(findSameSheet(after, { index: 0, name: "B", sheetId: "id-B" })).toBeUndefined();
  });

  it("answers nothing for a sheet that is gone", () => {
    expect(findSameSheet(listed(["A"]), { index: 3, name: "Z", sheetId: "id-Z" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The rotate target
// ---------------------------------------------------------------------------

describe("moveTargetBefore lands the sheet IMMEDIATELY before the anchor", () => {
  it("every (from, before) pair on a five-sheet workbook", () => {
    for (let from = 0; from < NAMES.length; from++) {
      for (let before = 0; before < NAMES.length; before++) {
        if (before === from) continue; // "before itself" is a no-op, checked below
        const to = moveTargetBefore(from, before);
        const result = rotate(NAMES, from, to);
        const movedAt = result.indexOf(NAMES[from]);
        expect(
          result[movedAt + 1],
          `moving ${NAMES[from]} before ${NAMES[before]} gave ${result.join("")}`,
        ).toBe(NAMES[before]);
      }
    }
  });

  it("before itself is the identity", () => {
    for (let i = 0; i < NAMES.length; i++) expect(moveTargetBefore(i, i)).toBe(i);
  });

  it("SABOTAGE CONTROL: the naive `to = before` is wrong for a move to the RIGHT", () => {
    // What this test would catch: A(0) "before C(2)" with to = 2 lands A AFTER C.
    expect(rotate(NAMES, 0, 2).join("")).toBe("BCADE");
    expect(rotate(NAMES, 0, moveTargetBefore(0, 2)).join("")).toBe("BACDE");
  });
});

describe("lastSheetIndex / move to end", () => {
  it("is the greatest TRUE index in the list (hidden sheets included)", () => {
    const list: PlacedSheet[] = [
      { index: 0, name: "A" },
      { index: 2, name: "H", visibility: "hidden" },
      { index: 3, name: "B" },
    ];
    expect(lastSheetIndex(list)).toBe(3);
  });

  it("is -1 for an empty list", () => {
    expect(lastSheetIndex([])).toBe(-1);
  });

  it("moveTargetFor(null) moves to the end", () => {
    for (let from = 0; from < NAMES.length; from++) {
      const to = moveTargetFor(from, null, listed(NAMES));
      expect(rotate(NAMES, from, to).at(-1)).toBe(NAMES[from]);
    }
  });
});

// ---------------------------------------------------------------------------
// The two composite flows the strip runs
// ---------------------------------------------------------------------------

describe("Insert Sheet = append, then rotate BEFORE the sheet that was active", () => {
  it("for every active sheet, the new sheet ends up immediately before it", () => {
    for (let active = 0; active < NAMES.length; active++) {
      const anchor = listed(NAMES)[active];
      // add_sheet appends at the end and activates it.
      const afterAdd = [...NAMES, "New"];
      const addedAt = afterAdd.length - 1;
      const to = moveTargetFor(addedAt, anchor, listed(afterAdd));
      const result = rotate(afterAdd, addedAt, to);
      expect(result.indexOf("New") + 1, result.join(",")).toBe(result.indexOf(NAMES[active]));
      // ...and the backend's active index (it follows the moved sheet) is `to`.
      expect(result[to]).toBe("New");
    }
  });

  it("when the append landed BEFORE the anchor (an object sheet in the tail), it still lands right", () => {
    // [A, (obj), B, C] with B active: add_sheet puts the new sheet at the end
    // of the USER PREFIX (index 1), pushing obj, B and C one place right. The
    // anchor must be re-found by identity in the list the add returned.
    const before = { index: 2, name: "B", sheetId: "id-B" };
    const afterAdd: PlacedSheet[] = [
      { index: 0, name: "A", sheetId: "id-A" },
      { index: 1, name: "New", sheetId: "id-New" },
      // index 2 is the object sheet: getSheets() omits it
      { index: 3, name: "B", sheetId: "id-B" },
      { index: 4, name: "C", sheetId: "id-C" },
    ];
    const to = moveTargetFor(1, before, afterAdd);
    const model = rotate(["A", "New", "obj", "B", "C"], 1, to);
    expect(model.indexOf("New") + 1).toBe(model.indexOf("B"));
  });
});

describe("Copy = copy_sheet (lands right after its source), then rotate before the anchor", () => {
  it("every (source, before) pair, and (move to end)", () => {
    for (let source = 0; source < NAMES.length; source++) {
      const anchors: (PlacedSheet | null)[] = [...listed(NAMES), null];
      for (const anchor of anchors) {
        // copy_sheet inserts "X'" at source + 1 and activates it.
        const copyName = `${NAMES[source]}'`;
        const afterCopy = [...NAMES.slice(0, source + 1), copyName, ...NAMES.slice(source + 1)];
        const copyAt = source + 1;
        const to = moveTargetFor(copyAt, anchor, listed(afterCopy));
        const result = rotate(afterCopy, copyAt, to);
        if (anchor === null) {
          expect(result.at(-1), result.join(",")).toBe(copyName);
        } else {
          expect(result.indexOf(copyName) + 1, `${copyName} before ${anchor.name}: ${result.join(",")}`).toBe(
            result.indexOf(anchor.name),
          );
        }
        // The original is still there, once.
        expect(result.filter((n) => n === NAMES[source]).length).toBe(1);
      }
    }
  });
});

describe("Move (no copy) to every position", () => {
  it("every (source, before) pair and (move to end)", () => {
    for (let source = 0; source < NAMES.length; source++) {
      for (const anchor of [...listed(NAMES), null]) {
        const to = moveTargetFor(source, anchor, listed(NAMES));
        const result = rotate(NAMES, source, to);
        if (anchor === null) expect(result.at(-1)).toBe(NAMES[source]);
        else if (anchor.index !== source) {
          expect(result.indexOf(NAMES[source]) + 1).toBe(result.indexOf(anchor.name));
        } else {
          expect(result).toEqual([...NAMES]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The per-sheet view cache (Core's `sheet:reorder` listener)
// ---------------------------------------------------------------------------

/**
 * Core's `handleSheetReorder` (Spreadsheet.tsx), verbatim in effect: the per-
 * sheet selection/scroll cache is keyed by TRUE index and re-keyed by this on
 * every `sheet:reorder`. The test oracle for the two details below.
 */
function remap(keys: number[], fromIndex: number, toIndex: number): number[] {
  return keys.map((key) => {
    if (key === fromIndex) return toIndex;
    if (fromIndex < toIndex) return key > fromIndex && key <= toIndex ? key - 1 : key;
    return key >= toIndex && key < fromIndex ? key + 1 : key;
  });
}

describe("an insertion or a removal, told to the per-sheet view cache", () => {
  it("insertion at `at` shifts every key at or past it up by one", () => {
    const { fromIndex, toIndex } = insertionReorderDetail(2);
    expect(remap([0, 1, 2, 3, 7], fromIndex, toIndex)).toEqual([0, 1, 3, 4, 8]);
  });

  it("removal at `at` shifts every key past it down by one, and parks the removed key out of reach", () => {
    const { fromIndex, toIndex } = removalReorderDetail(1);
    const out = remap([0, 1, 2, 3], fromIndex, toIndex);
    expect(out.slice(0, 1)).toEqual([0]);
    expect(out.slice(2)).toEqual([1, 2]);
    // The deleted sheet's view can never be restored onto a real sheet.
    expect(out[1]).toBeGreaterThan(1_000_000);
  });
});
