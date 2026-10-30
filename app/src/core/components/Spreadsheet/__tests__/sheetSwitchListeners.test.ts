//! FILENAME: app/src/core/components/Spreadsheet/__tests__/sheetSwitchListeners.test.ts
// PURPOSE: What Core does on the three sheet-switch events, through the SAME
//          listeners Spreadsheet.tsx installs (`listenForSheetSwitches`):
//            - the per-sheet view memory, re-keyed by every renumbering;
//            - a removal DROPS the removed sheet's view, and an insertion
//              leaves the new index empty (review rev3C#5);
//            - an ordinary switch to a sheet outside the sheet group ends the
//              group, a switch to a member keeps it, point mode never touches
//              it (review revG#4, BUG-0350);
//            - the grid takes the keyboard after a switch, unless the switch
//              said `keepFocus` (the command line, review rev3C#3).
// CONTEXT: Before round 5 the memory lived inside Spreadsheet's effect, and a
//          removal was read as a plain rotate to the far index: the deleted
//          sheet's view was PARKED there, and the next insertion -- a rotate
//          from that same far index -- handed it to the new sheet, which
//          opened at the deleted sheet's J400 and scroll.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SheetViewMemory,
  listenForSheetSwitches,
} from "../sheetSwitchListeners";
import {
  BEYOND_EVERY_SHEET,
  renumberedSheetIndex,
} from "../../../state/sheetRenumbering";
import {
  clearSheetGrouping,
  getSelectedSheetIndices,
  setSelectedSheetIndices,
  subscribeToSheetGrouping,
} from "../../../state/sheetGrouping";

const FAR = BEYOND_EVERY_SHEET;

// ---------------------------------------------------------------------------
// The renumbering rule
// ---------------------------------------------------------------------------

describe("renumberedSheetIndex", () => {
  const all = (keys: number[], from: number, to: number) => keys.map((k) => renumberedSheetIndex(k, from, to));

  it("a rotate moves the sheet and shifts the ones between", () => {
    expect(all([0, 1, 2, 3, 4], 1, 3)).toEqual([0, 3, 1, 2, 4]);
    expect(all([0, 1, 2, 3, 4], 3, 1)).toEqual([0, 2, 3, 1, 4]);
  });

  // SABOTAGE (rev3C#5): read a removal as a plain rotate -> the removed key
  // lands at FAR instead of null.
  it("a REMOVAL drops the removed index and moves every later one down", () => {
    expect(all([0, 1, 2, 3], 1, FAR)).toEqual([0, null, 1, 2]);
  });

  it("an INSERTION moves every index at or past it up and leaves its own EMPTY", () => {
    expect(all([0, 1, 2, 3], FAR, 2)).toEqual([0, 1, 3, 4]);
  });

  it("a key parked beyond every sheet (an older reading of a removal) is dropped on sight", () => {
    expect(renumberedSheetIndex(FAR, FAR, 2)).toBeNull();
    expect(renumberedSheetIndex(FAR, 0, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The listeners
// ---------------------------------------------------------------------------

/** The grid as the listeners see it: the view on screen and the focus taken. */
const screen = { view: "A1" as string, focusTaken: 0 };
let memory: SheetViewMemory<string>;
let stop: () => void = () => {};

function fire(type: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

/** A tab-strip switch to `index`: save, (renumber), arrive. */
function switchTo(index: number, opts: { keepFocus?: boolean; before?: () => void } = {}): void {
  fire("sheet:beforeSwitch", { oldSheetIndex: memory.shown ?? -1, newSheetIndex: index });
  opts.before?.();
  fire("sheet:normalSwitch", {
    newSheetIndex: index,
    newSheetName: `S${index}`,
    ...(opts.keepFocus ? { keepFocus: true } : {}),
  });
}

beforeEach(() => {
  screen.view = "A1";
  screen.focusTaken = 0;
  clearSheetGrouping();
  memory = new SheetViewMemory<string>();
  memory.showing(0);
  stop = listenForSheetSwitches(memory, {
    captureView: () => screen.view,
    showView: (_index, view) => {
      screen.view = view ?? "A1";
    },
    focusGrid: () => {
      screen.focusTaken += 1;
    },
  });
});

afterEach(() => {
  stop();
  clearSheetGrouping();
});

describe("the view memory follows its sheets", () => {
  it("leaving and coming back restores each sheet's own view", () => {
    screen.view = "S0@C5";
    switchTo(1);
    expect(screen.view).toBe("A1");
    screen.view = "S1@J400";
    switchTo(0);
    expect(screen.view).toBe("S0@C5");
    switchTo(1);
    expect(screen.view).toBe("S1@J400");
  });

  // SABOTAGE (rev3C#5): read a removal as a plain rotate (the old handler) ->
  // the deleted sheet's J400 is parked at the far index and handed to the
  // sheet the next insertion makes.
  it("a DELETED sheet's view is never handed to the sheet a later insertion makes (review rev3C#5)", () => {
    // Sheets 0..3; Data (2) viewed at J400 and on screen.
    screen.view = "S0@C5";
    switchTo(2);
    screen.view = "Data@J400";
    // The command line's `delete sheet Data` (the seam: save, removal, arrive
    // at the neighbour that slid into index 2).
    switchTo(2, { before: () => fire("sheet:reorder", { fromIndex: 2, toIndex: FAR }) });
    expect(screen.view, "the neighbour opened with the deleted sheet's view").toBe("A1");
    screen.view = "S3@B7";
    // Insert Sheet from the tab strip: the new sheet lands at 3 (the end).
    switchTo(3, { before: () => fire("sheet:reorder", { fromIndex: FAR, toIndex: 3 }) });
    expect(screen.view, "the new sheet opened at the deleted sheet's selection and scroll").toBe("A1");
    // ...and every surviving sheet still has its own.
    switchTo(0);
    expect(screen.view).toBe("S0@C5");
    switchTo(2);
    expect(screen.view).toBe("S3@B7");
  });

  it("a renumbering with no switch after it re-keys the sheet on screen too, so the NEXT save lands on its own index", () => {
    screen.view = "S0@C5";
    switchTo(2);
    screen.view = "S2@J400";
    // A sheet inserted before the one on screen: S2 is now at 3, nothing switched.
    fire("sheet:reorder", { fromIndex: FAR, toIndex: 0 });
    expect(memory.shown).toBe(3);
    switchTo(1); // S0, now at 1
    expect(screen.view).toBe("S0@C5");
    switchTo(3);
    expect(screen.view, "S2's view was saved under another sheet's index").toBe("S2@J400");
  });
});

describe("the grid takes the keyboard after a switch -- unless the switch keeps it (review rev3C#3)", () => {
  // SABOTAGE: ignore `keepFocus` -> the command line's switch focuses the grid.
  it("keepFocus leaves the focus where it is; an ordinary switch gives it to the grid", () => {
    switchTo(1, { keepFocus: true });
    expect(screen.focusTaken, "a command-line switch took the keyboard from the prompt").toBe(0);
    switchTo(2);
    expect(screen.focusTaken).toBe(1);
  });
});

describe("the sheet group ends on an ordinary switch outside it (review revG#4, BUG-0350)", () => {
  // SABOTAGE: drop `endSheetGroupUnlessMember` from the normalSwitch listener
  // -> the group outlives a switch to a sheet outside it.
  it("Sheet1+Sheet3 grouped: a switch to Sheet2 ends the group [LIVE: Application.Goto Sheet2!A1]", () => {
    setSelectedSheetIndices([0, 2]);
    switchTo(1);
    expect(getSelectedSheetIndices()).toEqual([]);
  });

  it("a switch to a MEMBER keeps the group [LIVE: Goto Sheet3!B2]", () => {
    setSelectedSheetIndices([0, 2]);
    switchTo(2);
    expect(getSelectedSheetIndices()).toEqual([0, 2]);
  });

  it("formula point mode (sheet:formulaModeSwitch) never ends it", () => {
    setSelectedSheetIndices([0, 2]);
    fire("sheet:formulaModeSwitch", { newSheetIndex: 1, newSheetName: "S1" });
    expect(getSelectedSheetIndices()).toEqual([0, 2]);
  });

  // SABOTAGE: drop `renumberSheetGroup` from the reorder listener -> the group
  // keeps the old indices and names the wrong sheets.
  it("the group follows its sheets through a renumbering", () => {
    setSelectedSheetIndices([0, 2]);
    fire("sheet:reorder", { fromIndex: 1, toIndex: FAR }); // a sheet between them deleted
    expect(getSelectedSheetIndices()).toEqual([0, 1]);
    fire("sheet:reorder", { fromIndex: FAR, toIndex: 0 }); // one inserted before both
    expect(getSelectedSheetIndices()).toEqual([1, 2]);
    fire("sheet:reorder", { fromIndex: 2, toIndex: FAR }); // a member deleted: one left, no group
    expect(getSelectedSheetIndices()).toEqual([]);
  });

  it("the strip's subscription hears the group end", () => {
    setSelectedSheetIndices([0, 2]);
    let heard = 0;
    const unsubscribe = subscribeToSheetGrouping(() => {
      heard += 1;
    });
    switchTo(2); // a member: no change, nothing announced
    expect(heard).toBe(0);
    switchTo(1);
    expect(heard).toBe(1);
    unsubscribe();
  });
});
