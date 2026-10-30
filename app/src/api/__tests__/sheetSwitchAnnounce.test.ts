/**
 * FILENAME: app/src/api/__tests__/sheetSwitchAnnounce.test.ts
 * PURPOSE: `announceSheetsChanged` (@api/sheetSwitch) -- the ONE body that makes
 *          Core and every listener FOLLOW a sheet-list answer the backend
 *          already gave -- and `changeSheetsAndFollow`, which runs a change and
 *          follows it with nothing awaited between.
 * CONTEXT: BUG-0464. The script host had this as a private function; the
 *          command line had nothing, so `set sheet <active> visibility=hidden`
 *          left the grid painting the hidden sheet while the backend's active
 *          sheet was its neighbour. Both call this now.
 *
 *          Review revG#3: the first shared version announced the context and
 *          SHEET_CHANGED only. When the active sheet MOVED it fired neither
 *          `sheet:beforeSwitch` nor `sheet:normalSwitch`, so Spreadsheet never
 *          saved the left sheet's selection and scroll, never restored the new
 *          sheet's, kept its "previous sheet" on the hidden one (the next tab
 *          click saved one sheet's view under another's key), and the canvas's
 *          fetch epoch never moved. It now runs the tab strip's own switch for
 *          a change the backend made (SheetTabs `applySheetsResult` /
 *          `executeDeleteSheet`): beforeSwitch, the renumbering, the prime, the
 *          context, normalSwitch, SHEET_CHANGED. A change that leaves the shown
 *          sheet where it is keeps the light announcement (no switch, nobody's
 *          view memory touched).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  backendSwitch: vi.fn(async () => ({ sheets: [], activeIndex: 0 })),
  /** Core's sheet context as the grid shows it; null = nothing mounted. */
  shown: null as null | { activeSheetIndex: number; activeSheetName: string; activeSheetId?: string },
}));

vi.mock("../../core/lib/tauri-api", () => ({
  setActiveSheet: (...a: unknown[]) => h.backendSwitch(...(a as [])),
}));
vi.mock("../../core/lib/sheetSwitchPrefetch", () => ({
  primeSheetSwitch: async (index: number) => {
    h.calls.push(`prime:${index}`);
  },
}));
vi.mock("../../core/state/GridContext", () => ({
  getGridStateSnapshot: () => (h.shown === null ? null : { sheetContext: h.shown }),
}));
vi.mock("../grid", () => ({
  setActiveSheet: (index: number, name: string, surface?: string, sheetId?: string) => ({
    type: "SET_ACTIVE_SHEET",
    payload: { index, name, surface, sheetId },
  }),
  refreshGridDimensions: () => h.calls.push("dimensions"),
  refreshGridData: () => h.calls.push("data"),
}));
vi.mock("../gridDispatch", () => ({
  dispatchGridAction: (action: { payload: unknown }) => h.calls.push(`dispatch:${JSON.stringify(action.payload)}`),
}));
vi.mock("../events", () => ({
  AppEvents: { SHEET_CHANGED: "app:sheet-changed" },
  emitAppEvent: (name: string, detail: unknown) => h.calls.push(`emit:${name}:${JSON.stringify(detail)}`),
}));

import { activateSheet, announceSheetsChanged, changeSheetsAndFollow } from "../sheetSwitch";

const FAR = Number.MAX_SAFE_INTEGER;
const onBefore = (e: Event) => h.calls.push(`before:${JSON.stringify((e as CustomEvent).detail)}`);
const onNormal = (e: Event) => h.calls.push(`normal:${JSON.stringify((e as CustomEvent).detail)}`);
const onReorder = (e: Event) => h.calls.push(`reorder:${JSON.stringify((e as CustomEvent).detail)}`);

beforeEach(() => {
  h.calls.length = 0;
  h.backendSwitch.mockClear();
  h.shown = null;
  window.addEventListener("sheet:beforeSwitch", onBefore);
  window.addEventListener("sheet:normalSwitch", onNormal);
  window.addEventListener("sheet:reorder", onReorder);
});
afterEach(() => {
  window.removeEventListener("sheet:beforeSwitch", onBefore);
  window.removeEventListener("sheet:normalSwitch", onNormal);
  window.removeEventListener("sheet:reorder", onReorder);
});

const kinds = (): string[] => h.calls.map((c) => c.split(":")[0]);

/** Three worksheets with stable ids, as the backend lists them. */
function list(...names: string[]): Array<{ index: number; name: string; sheetId: string }> {
  return names.map((name, index) => ({ index, name, sheetId: `id-${name}` }));
}

describe("announceSheetsChanged", () => {
  it("moves Core to the active sheet the backend reports, tells SHEET_CHANGED, re-reads the grid", async () => {
    await announceSheetsChanged({
      sheets: [
        { index: 0, name: "Sheet1" },
        { index: 1, name: "Board", kind: "canvas", sheetId: "id-board" },
      ],
      activeIndex: 1,
    });
    expect(h.calls).toEqual([
      'dispatch:{"index":1,"name":"Board","surface":"canvas","sheetId":"id-board"}',
      'emit:app:sheet-changed:{"sheetIndex":1,"sheetName":"Board"}',
      "dimensions",
      "data",
    ]);
  });

  it("never asks the backend to switch: the switch is already made", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1" };
    await announceSheetsChanged({ sheets: [{ index: 0, name: "Sheet1" }, { index: 1, name: "Sheet2" }], activeIndex: 1 });
    expect(h.backendSwitch).not.toHaveBeenCalled();
  });

  it("a worksheet with no stable id in the list: the dispatch carries none (it clears the edit's)", async () => {
    await announceSheetsChanged({ sheets: [{ index: 0, name: "Sheet1" }, { index: 1, name: "Sheet2" }], activeIndex: 1 });
    expect(h.calls[0]).toBe('dispatch:{"index":1,"name":"Sheet2","surface":"grid"}');
  });
});

describe("the active sheet MOVED: the tab strip's own switch, step for step (review revG#3)", () => {
  // SABOTAGE: make `activeSheetMoved` answer false -> every case below takes
  // the light announcement, with no beforeSwitch / normalSwitch.
  it("a hide of the active sheet: beforeSwitch for the sheet Core still shows, the prime, the context, normalSwitch, SHEET_CHANGED", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "id-Sheet1" };
    await announceSheetsChanged({ sheets: list("Sheet1", "Sheet2", "Sheet3"), activeIndex: 1 });
    expect(h.calls).toEqual([
      'before:{"oldSheetIndex":0,"newSheetIndex":1}',
      "prime:1",
      'dispatch:{"index":1,"name":"Sheet2","surface":"grid","sheetId":"id-Sheet2"}',
      'normal:{"newSheetIndex":1,"newSheetName":"Sheet2"}',
      'emit:app:sheet-changed:{"sheetIndex":1,"sheetName":"Sheet2"}',
    ]);
    expect(h.backendSwitch).not.toHaveBeenCalled();
  });

  it("an add (the backend makes the new sheet active): switched to it", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "id-Sheet1" };
    await announceSheetsChanged({ sheets: list("Sheet1", "Sheet2", "Report"), activeIndex: 2 });
    expect(kinds()).toEqual(["before", "prime", "dispatch", "normal", "emit"]);
    expect(h.calls[0]).toBe('before:{"oldSheetIndex":0,"newSheetIndex":2}');
  });

  // SABOTAGE: drop the `removedIndex === shown` clause -> by index alone the
  // neighbour that slid into index 0 looks like the sheet that was there.
  it("the ACTIVE sheet deleted at index 0, with no ids: its neighbour slid into the same index, and it is still a switch", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1" };
    await announceSheetsChanged({ sheets: [{ index: 0, name: "Sheet2" }, { index: 1, name: "Sheet3" }], activeIndex: 0 }, {
      removedIndex: 0,
    });
    expect(h.calls).toEqual([
      'before:{"oldSheetIndex":0,"newSheetIndex":0}',
      `reorder:{"fromIndex":0,"toIndex":${FAR}}`,
      "prime:0",
      'dispatch:{"index":0,"name":"Sheet2","surface":"grid"}',
      'normal:{"newSheetIndex":0,"newSheetName":"Sheet2"}',
      'emit:app:sheet-changed:{"sheetIndex":0,"sheetName":"Sheet2"}',
    ]);
  });

  it("a different sheet at the same index (by stable id) is a switch too", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "id-Sheet1" };
    await announceSheetsChanged({ sheets: list("Sheet2", "Sheet3"), activeIndex: 0 });
    expect(kinds()).toEqual(["before", "prime", "dispatch", "normal", "emit"]);
  });

  it("a sheet deleted BEFORE the active one: the same sheet at a lower index -- saved, re-keyed, restored", async () => {
    h.shown = { activeSheetIndex: 2, activeSheetName: "Sheet3", activeSheetId: "id-Sheet3" };
    await announceSheetsChanged({ sheets: list("Sheet2", "Sheet3"), activeIndex: 1 }, { removedIndex: 0 });
    expect(h.calls.slice(0, 2)).toEqual([
      'before:{"oldSheetIndex":2,"newSheetIndex":1}',
      `reorder:{"fromIndex":0,"toIndex":${FAR}}`,
    ]);
    expect(kinds()).toEqual(["before", "reorder", "prime", "dispatch", "normal", "emit"]);
  });
});

describe("an insertion or a move is told too (review revG#3: the script host's add, copy and move)", () => {
  // SABOTAGE: drop the `insertedIndex <= shown` clause from activeSheetMoved
  // -> with no ids, the new sheet at the shown sheet's index looks like the
  // sheet that was there, and nothing is saved or restored.
  it("a sheet inserted AT the shown sheet's index, with no ids: still a switch, the insertion told between the save and the restore", async () => {
    h.shown = { activeSheetIndex: 1, activeSheetName: "Sheet2" };
    await announceSheetsChanged(
      { sheets: [{ index: 0, name: "Sheet1" }, { index: 1, name: "New" }, { index: 2, name: "Sheet2" }], activeIndex: 1 },
      { insertedIndex: 1 },
    );
    expect(h.calls).toEqual([
      'before:{"oldSheetIndex":1,"newSheetIndex":1}',
      `reorder:{"fromIndex":${FAR},"toIndex":1}`,
      "prime:1",
      'dispatch:{"index":1,"name":"New","surface":"grid"}',
      'normal:{"newSheetIndex":1,"newSheetName":"New"}',
      'emit:app:sheet-changed:{"sheetIndex":1,"sheetName":"New"}',
    ]);
  });

  it("the ACTIVE sheet moved: saved under its old index, rotated, restored under its new one", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "id-Sheet1" };
    await announceSheetsChanged({ sheets: list("Sheet2", "Sheet3", "Sheet1"), activeIndex: 2 }, {
      moved: { fromIndex: 0, toIndex: 2 },
    });
    expect(h.calls.slice(0, 2)).toEqual([
      'before:{"oldSheetIndex":0,"newSheetIndex":2}',
      'reorder:{"fromIndex":0,"toIndex":2}',
    ]);
    expect(kinds()).toEqual(["before", "reorder", "prime", "dispatch", "normal", "emit"]);
  });

  it("ANOTHER sheet moved past the active one: the rotate is told, nothing switches", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "id-Sheet1" };
    await announceSheetsChanged({ sheets: list("Sheet1", "Sheet3", "Sheet2"), activeIndex: 0 }, {
      moved: { fromIndex: 1, toIndex: 2 },
    });
    expect(h.calls[0]).toBe('reorder:{"fromIndex":1,"toIndex":2}');
    expect(kinds()).toEqual(["reorder", "dispatch", "emit", "dimensions", "data"]);
  });

  it("a move onto itself renumbers nothing: no reorder is sent", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "id-Sheet1" };
    await announceSheetsChanged({ sheets: list("Sheet1", "Sheet2"), activeIndex: 0 }, {
      moved: { fromIndex: 1, toIndex: 1 },
    });
    expect(kinds()).toEqual(["dispatch", "emit", "dimensions", "data"]);
  });
});

describe("the shown sheet stayed put: the light announcement, no switch", () => {
  it("a rename or a tab colour of the active sheet: the context (its new name), SHEET_CHANGED, the grid re-read", async () => {
    h.shown = { activeSheetIndex: 1, activeSheetName: "Sheet2", activeSheetId: "id-Sheet2" };
    await announceSheetsChanged({ sheets: [...list("Sheet1"), { index: 1, name: "Budget", sheetId: "id-Sheet2" }], activeIndex: 1 });
    expect(kinds()).toEqual(["dispatch", "emit", "dimensions", "data"]);
    expect(h.calls[0]).toContain('"name":"Budget"');
  });

  it("a sheet deleted AFTER the active one: the renumbering is told, nothing switches", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "id-Sheet1" };
    await announceSheetsChanged({ sheets: list("Sheet1", "Sheet2"), activeIndex: 0 }, { removedIndex: 2 });
    expect(h.calls[0]).toBe(`reorder:{"fromIndex":2,"toIndex":${FAR}}`);
    expect(kinds()).toEqual(["reorder", "dispatch", "emit", "dimensions", "data"]);
  });
});

describe("the same sheet renumbered UNTOLD is not a switch (review rev3C#2's backstop)", () => {
  // SABOTAGE: drop `!renumberedOnly &&` from the switch condition -> the
  // full switch runs: the sheet's view saved under its old index, and the
  // view another sheet left under the new one restored onto it.
  it("same stable id at another index, no renumbering: no save, no restore -- one rotate carries its memory", async () => {
    h.shown = { activeSheetIndex: 3, activeSheetName: "Notes", activeSheetId: "id-Notes" };
    await announceSheetsChanged({ sheets: list("Sales", "Summary", "Notes"), activeIndex: 2 });
    expect(h.calls).toEqual([
      'reorder:{"fromIndex":3,"toIndex":2}',
      'dispatch:{"index":2,"name":"Notes","surface":"grid","sheetId":"id-Notes"}',
      'emit:app:sheet-changed:{"sheetIndex":2,"sheetName":"Notes"}',
      "dimensions",
      "data",
    ]);
  });

  it("a TOLD renumbering keeps the tab strip's switch (unchanged)", async () => {
    h.shown = { activeSheetIndex: 3, activeSheetName: "Notes", activeSheetId: "id-Notes" };
    await announceSheetsChanged({ sheets: list("Sales", "Summary", "Notes"), activeIndex: 2 }, { removedIndex: 1 });
    expect(kinds()).toEqual(["before", "reorder", "prime", "dispatch", "normal", "emit"]);
  });

  it("control: a DIFFERENT sheet at another index is still a switch", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sales", activeSheetId: "id-Sales" };
    await announceSheetsChanged({ sheets: list("Sales", "Summary", "Notes"), activeIndex: 2 });
    expect(kinds()).toEqual(["before", "prime", "dispatch", "normal", "emit"]);
  });
});

describe("keepFocus rides sheet:normalSwitch (review rev3C#3: the command line keeps the keyboard)", () => {
  // SABOTAGE: drop the focus argument from normalSwitchDetail -> no keepFocus.
  it("announceSheetsChanged / changeSheetsAndFollow carry it to the switch", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "id-Sheet1" };
    await changeSheetsAndFollow(async () => ({ sheets: list("Sheet1", "Report"), activeIndex: 1 }), undefined, {
      keepFocus: true,
    });
    expect(h.calls).toContain('normal:{"newSheetIndex":1,"newSheetName":"Report","keepFocus":true}');
  });

  it("activateSheet carries it too, and an ordinary switch says nothing about focus", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "id-Sheet1" };
    h.backendSwitch.mockImplementationOnce(async () => ({ sheets: list("Sheet1", "Sheet2"), activeIndex: 1 }));
    await activateSheet(1, { keepFocus: true });
    expect(h.calls).toContain('normal:{"newSheetIndex":1,"newSheetName":"Sheet2","keepFocus":true}');
    h.calls.length = 0;
    await announceSheetsChanged({ sheets: list("Sheet1", "Sheet2"), activeIndex: 1 });
    expect(h.calls).toContain('normal:{"newSheetIndex":1,"newSheetName":"Sheet2"}');
  });
});

describe("changeSheetsAndFollow", () => {
  // Review rev3C#8: an add's landing index is the backend's to say.
  it("a renumbering FUNCTION is read from the change's own answer", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "id-Sheet1" };
    await changeSheetsAndFollow(
      async () => ({ sheets: list("Sheet1", "Sheet2", "Report"), activeIndex: 2 }),
      (added) => ({ insertedIndex: added.activeIndex }),
    );
    expect(h.calls).toContain(`reorder:{"fromIndex":${FAR},"toIndex":2}`);
  });

  it("runs the change and follows ITS answer, with the renumbering it was given", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "id-Sheet1" };
    const answer = { sheets: list("Sheet2", "Sheet3"), activeIndex: 0 };
    const result = await changeSheetsAndFollow(async () => {
      h.calls.push("change");
      return answer;
    }, { removedIndex: 0 });
    expect(result).toBe(answer);
    expect(kinds()).toEqual(["change", "before", "reorder", "prime", "dispatch", "normal", "emit"]);
  });

  it("a change that throws announces NOTHING and rethrows", async () => {
    h.shown = { activeSheetIndex: 0, activeSheetName: "Sheet1", activeSheetId: "id-Sheet1" };
    await expect(
      changeSheetsAndFollow(async () => {
        throw new Error("A workbook must contain at least one visible sheet.");
      }),
    ).rejects.toThrow(/at least one visible sheet/);
    expect(h.calls).toEqual([]);
  });
});
