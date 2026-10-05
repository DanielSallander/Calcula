//! FILENAME: app/src/shell/SheetTabs/__tests__/sheetTabFlows.test.ts
// PURPOSE: The backend call SEQUENCES behind Insert Sheet (before the active
//          sheet) and Move or Copy Sheet..., run against a model of the
//          backend: what the user sees afterwards (the order, the active sheet)
//          and what Core's per-sheet view cache is told on the way (every
//          sheet's remembered selection must still belong to that sheet).
// CONTEXT: The strip (SheetTabs.tsx) only APPLIES the result these flows
//          return, through the same commit-before-switch steps every switch
//          takes. Keeping the sequence here, with the backend passed in, is
//          what lets it be tested without rendering the strip (which means
//          mocking ~25 symbols -- sheetTabContextIdentity.test.ts).

import { describe, it, expect } from "vitest";
import { insertSheetBefore, moveOrCopySheet, type SheetFlowBackend } from "../sheetTabFlows";
import type { PlacedSheet } from "../sheetPlacement";

interface SheetsResult {
  sheets: PlacedSheet[];
  activeIndex: number;
}

/**
 * The backend, by its own definitions (sheets.rs): `add_sheet` appends and
 * activates; `copy_sheet` inserts "<name> (2)" right after the source and
 * activates it; `move_sheet` is `rotate_element` and the active sheet FOLLOWS
 * its sheet. The view cache is Core's `handleSheetReorder` (Spreadsheet.tsx).
 */
class Model implements SheetFlowBackend {
  names: string[];
  active: number;
  /** Core's per-sheet view cache: TRUE index -> the sheet whose view it is. */
  cache = new Map<number, string>();
  calls: string[] = [];
  failMove = false;

  constructor(names: string[], active: number) {
    this.names = [...names];
    this.active = active;
    names.forEach((n, i) => this.cache.set(i, n));
  }

  private result(): SheetsResult {
    return {
      sheets: this.names.map((name, index) => ({ index, name, sheetId: `id-${name}`, visibility: "visible" })),
      activeIndex: this.active,
    };
  }

  async addSheet(): Promise<SheetsResult> {
    this.calls.push("add");
    this.names.push("New");
    this.active = this.names.length - 1;
    return this.result();
  }

  async copySheet(index: number): Promise<SheetsResult> {
    this.calls.push(`copy ${index}`);
    this.names.splice(index + 1, 0, `${this.names[index]} (2)`);
    this.active = index + 1;
    return this.result();
  }

  async moveSheet(from: number, to: number): Promise<SheetsResult> {
    this.calls.push(`move ${from}->${to}`);
    if (this.failMove) throw new Error("Workbook structure is protected");
    const activeName = this.names[this.active];
    const [moved] = this.names.splice(from, 1);
    this.names.splice(to, 0, moved);
    this.active = this.names.indexOf(activeName);
    return this.result();
  }

  reorder = (detail: { fromIndex: number; toIndex: number }): void => {
    const { fromIndex, toIndex } = detail;
    const next = new Map<number, string>();
    for (const [key, value] of this.cache) {
      let k = key;
      if (key === fromIndex) k = toIndex;
      else if (fromIndex < toIndex) {
        if (key > fromIndex && key <= toIndex) k = key - 1;
      } else if (key >= toIndex && key < fromIndex) k = key + 1;
      next.set(k, value);
    }
    this.cache = next;
  };

  /** Every cached view still sits under the index its own sheet now has. */
  cacheIsAligned(): boolean {
    for (const [key, name] of this.cache) {
      if (key > 1_000_000) continue; // parked out of reach
      if (this.names[key] !== name) return false;
    }
    return true;
  }

  listed(): PlacedSheet[] {
    return this.result().sheets;
  }
}

describe("insertSheetBefore", () => {
  it("adds a worksheet and lands it immediately before the anchor, which stays put relative to the rest", async () => {
    for (let active = 0; active < 4; active++) {
      const m = new Model(["A", "B", "C", "D"], active);
      const anchor = m.listed()[active];
      const { result, error } = await insertSheetBefore(m, m.reorder, anchor);
      expect(error).toBeUndefined();
      const expected = ["A", "B", "C", "D"];
      expected.splice(active, 0, "New");
      expect(m.names).toEqual(expected);
      // The NEW sheet is active, and the result says so.
      expect(result.activeIndex).toBe(active);
      expect(m.names[result.activeIndex]).toBe("New");
      expect(m.cacheIsAligned(), `cache after inserting before ${anchor.name}`).toBe(true);
    }
  });

  it("before the LAST sheet: the add lands after it, one move fixes that", async () => {
    const m = new Model(["A", "B"], 1);
    await insertSheetBefore(m, m.reorder, m.listed()[1]);
    expect(m.calls).toEqual(["add", "move 2->1"]);
  });

  it("a failed move after a landed add still returns the add (the sheet exists and is active)", async () => {
    const m = new Model(["A", "B"], 0);
    m.failMove = true;
    const { result, error } = await insertSheetBefore(m, m.reorder, m.listed()[0]);
    expect(error).toBeInstanceOf(Error);
    expect(m.names).toEqual(["A", "B", "New"]);
    expect(m.names[result.activeIndex]).toBe("New");
    expect(m.cacheIsAligned()).toBe(true);
  });

  it("with no anchor it is a plain add", async () => {
    const m = new Model(["A"], 0);
    await insertSheetBefore(m, m.reorder, undefined);
    expect(m.calls).toEqual(["add"]);
  });
});

describe("moveOrCopySheet -- move", () => {
  it("every (source, before) pair and (move to end) on four sheets", async () => {
    const NAMES = ["A", "B", "C", "D"];
    for (let source = 0; source < NAMES.length; source++) {
      for (const before of [0, 1, 2, 3, null]) {
        const m = new Model(NAMES, source);
        const { result } = await moveOrCopySheet(m, m.reorder, m.listed(), source, before, false);
        const at = m.names.indexOf(NAMES[source]);
        if (before === null) expect(at).toBe(NAMES.length - 1);
        else if (before !== source) expect(m.names[at + 1]).toBe(NAMES[before]);
        if (result) expect(m.names[result.activeIndex]).toBe(NAMES[source]);
        expect(m.cacheIsAligned(), `move ${NAMES[source]} before ${before}`).toBe(true);
      }
    }
  });

  it("a move that changes nothing calls nothing", async () => {
    const m = new Model(["A", "B", "C"], 1);
    const { result } = await moveOrCopySheet(m, m.reorder, m.listed(), 1, 1, false);
    expect(result).toBeNull();
    const again = await moveOrCopySheet(m, m.reorder, m.listed(), 1, 2, false);
    expect(again.result).toBeNull();
    expect(m.calls).toEqual([]);
  });
});

describe("moveOrCopySheet -- copy", () => {
  it("every (source, before) pair and (move to end): the copy lands there and is active, the original stays", async () => {
    const NAMES = ["A", "B", "C"];
    for (let source = 0; source < NAMES.length; source++) {
      for (const before of [0, 1, 2, null]) {
        const m = new Model(NAMES, source);
        const { result } = await moveOrCopySheet(m, m.reorder, m.listed(), source, before, true);
        const copyName = `${NAMES[source]} (2)`;
        const at = m.names.indexOf(copyName);
        if (before === null) expect(at).toBe(NAMES.length);
        else expect(m.names[at + 1], `${copyName} before ${NAMES[before]}: ${m.names}`).toBe(NAMES[before]);
        expect(m.names.filter((n) => n === NAMES[source]).length).toBe(1);
        expect(result && m.names[result.activeIndex]).toBe(copyName);
        expect(m.cacheIsAligned(), `copy ${NAMES[source]} before ${before}: ${[...m.cache]}`).toBe(true);
      }
    }
  });

  it("SABOTAGE CONTROL: without telling the cache about the copy's insertion, it misaligns", async () => {
    // A copy of A before C: [A, B, A (2), C] -- C's remembered view must follow
    // C to index 3. (A copy to the END happens to restore every position, so
    // it would not show the fault.)
    const m = new Model(["A", "B", "C"], 0);
    // Only the insertion is withheld; the move's own remap still goes through.
    const withoutInsertion = (d: { fromIndex: number; toIndex: number }) => {
      if (d.fromIndex < 1_000_000) m.reorder(d);
    };
    await moveOrCopySheet(m, withoutInsertion, m.listed(), 0, 2, true);
    expect(m.names).toEqual(["A", "B", "A (2)", "C"]);
    expect(m.cacheIsAligned()).toBe(false);
  });

  it("a failed move after a landed copy returns the copy", async () => {
    const m = new Model(["A", "B"], 0);
    m.failMove = true;
    const { result, error } = await moveOrCopySheet(m, m.reorder, m.listed(), 0, null, true);
    expect(error).toBeInstanceOf(Error);
    expect(result && m.names[result.activeIndex]).toBe("A (2)");
    expect(m.cacheIsAligned()).toBe(true);
  });
});
