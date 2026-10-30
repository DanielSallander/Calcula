// FILENAME: app/extensions/CommandLine/__tests__/gatewaySheetSwitch.test.ts
// PURPOSE: BUG-0464 -- the LIVE gateway switches sheets the way a tab click
//          does, and FOLLOWS every sheet-list change the backend made, through
//          the feature-neutral `@api/sheetSwitch` seam (never the bare backend
//          call that moves only the backend).
// CONTEXT: `set cell Sheet2!B3 = 5`, `goto Sheet2!A1` and the named-range goto
//          switched with `@api/lib` setActiveSheet -- the BACKEND alone -- so the
//          grid went on painting the old sheet while the CLI's write and the
//          user's next edit landed on the new one (the BUG-0046 shape). And
//          `set sheet <active> visibility=hidden` moved the backend's active
//          sheet with nobody applying it. Round 1 fixed those two; review
//          revG#2 found `add sheet` (the backend makes the new sheet active) and
//          `delete sheet <active>` (the backend lands on a neighbour) still
//          calling the raw wrappers. Every sheet-list change now runs inside
//          `changeSheetsAndFollow`, the delete with the index it removed (so
//          every later sheet keeps its own selection and scroll memory); what
//          the seam does with the answer is sheetSwitchAnnounce.test.ts's.
//          Round 5: the add tells where the backend put the new sheet (review
//          rev3C#8), and every switch leaves the keyboard on the prompt
//          (`keepFocus`, review rev3C#3) -- a switch gave the grid focus, and
//          the next typed line landed in a cell.

import { describe, expect, it, vi, beforeEach } from "vitest";

/* eslint-disable @typescript-eslint/naming-convention -- the doubles must match the real export names */

const { untouched, seam, lib } = vi.hoisted(() => {
  const answer = (activeIndex: number) => ({ sheets: [], activeIndex });
  return {
    untouched: (name: string) => () => {
      throw new Error(`${name} must not be reached by a sheet switch`);
    },
    seam: {
      activateSheet: vi.fn(async (index: number, _options?: unknown) => ({ sheets: [], activeIndex: index })),
      /** What the real seam does with the change, minus the announcement: run it, hand back its answer. */
      changeSheetsAndFollow: vi.fn(
        async (change: () => Promise<unknown>, _renumbering?: unknown, _focus?: unknown) => change(),
      ),
    },
    // The raw wrappers, recording. Each answers a list so the seam has one to follow.
    lib: {
      addSheet: vi.fn(async (..._a: unknown[]) => answer(3)),
      deleteSheet: vi.fn(async (..._a: unknown[]) => answer(0)),
      renameSheet: vi.fn(async (..._a: unknown[]) => answer(0)),
      hideSheet: vi.fn(async (..._a: unknown[]) => answer(1)),
      unhideSheet: vi.fn(async (..._a: unknown[]) => answer(0)),
      setTabColor: vi.fn(async (..._a: unknown[]) => answer(0)),
    },
  };
});

vi.mock("@api/lib", () => ({
  addSheet: (...a: unknown[]) => lib.addSheet(...a),
  beginUndoTransaction: untouched("beginUndoTransaction"),
  calculateNow: untouched("calculateNow"),
  clearRangeWithOptions: untouched("clearRangeWithOptions"),
  commitUndoTransaction: untouched("commitUndoTransaction"),
  createNamedRange: untouched("createNamedRange"),
  deleteNamedRange: untouched("deleteNamedRange"),
  deleteSheet: (...a: unknown[]) => lib.deleteSheet(...a),
  getAllNamedRanges: untouched("getAllNamedRanges"),
  getRangeCellsTyped: untouched("getRangeCellsTyped"),
  getSheets: untouched("getSheets"),
  getUsedRange: untouched("getUsedRange"),
  hideSheet: (...a: unknown[]) => lib.hideSheet(...a),
  redo: untouched("redo"),
  renameNamedRange: untouched("renameNamedRange"),
  renameSheet: (...a: unknown[]) => lib.renameSheet(...a),
  resolveNamedRangeCoords: untouched("resolveNamedRangeCoords"),
  // The bare BACKEND switch: what the gateway used to call.
  setActiveSheet: untouched("@api/lib setActiveSheet (the backend alone)"),
  setTabColor: (...a: unknown[]) => lib.setTabColor(...a),
  sortRangeByColumn: untouched("sortRangeByColumn"),
  undo: untouched("undo"),
  unhideSheet: (...a: unknown[]) => lib.unhideSheet(...a),
  updateCell: untouched("updateCell"),
}));

vi.mock("@api/sheetSwitch", () => ({
  activateSheet: (...a: [number, unknown?]) => seam.activateSheet(...a),
  changeSheetsAndFollow: (...a: [() => Promise<unknown>, unknown?, unknown?]) => seam.changeSheetsAndFollow(...a),
}));

vi.mock("@api/backend", () => ({
  getAllPivotTables: untouched("getAllPivotTables"),
  getAllTables: untouched("getAllTables"),
}));

vi.mock("@api/grid", () => ({
  navigateToRange: untouched("navigateToRange"),
}));

vi.mock("@api/commands", () => ({
  CommandRegistry: {
    has: untouched("CommandRegistry.has"),
    execute: untouched("CommandRegistry.execute"),
    getAll: untouched("CommandRegistry.getAll"),
  },
  CoreCommands: { UNDO: "core.undo", REDO: "core.redo" },
}));

vi.mock("@api/workbookScripts", () => ({
  listWorkbookScripts: untouched("listWorkbookScripts"),
}));

vi.mock("@api/macroRunService", () => ({
  hasMacroRunProvider: untouched("hasMacroRunProvider"),
  requireMacroRunProvider: untouched("requireMacroRunProvider"),
}));

/* eslint-enable @typescript-eslint/naming-convention */

import { createLiveAppGateway } from "../cli/appGateway";

beforeEach(() => {
  seam.activateSheet.mockClear();
  seam.changeSheetsAndFollow.mockClear();
  for (const fn of Object.values(lib)) fn.mockClear();
});

/**
 * The gateway call reached the raw wrapper ONLY from inside the follow: once,
 * with `args`; the follow was told `renumbering` -- read from the wrapper's own
 * answer when the gateway handed a function -- and told to leave the keyboard
 * on the command line (review rev3C#3).
 */
async function expectFollowed(wrapper: ReturnType<typeof vi.fn>, args: unknown[], renumbering: unknown): Promise<void> {
  expect(seam.changeSheetsAndFollow, "the change was not followed: the grid stays on the old sheet").toHaveBeenCalledTimes(1);
  const told = seam.changeSheetsAndFollow.mock.calls[0][1];
  const answer = await wrapper.mock.results[0]?.value;
  expect(typeof told === "function" ? (told as (r: unknown) => unknown)(answer) : told).toEqual(renumbering);
  expect(
    seam.changeSheetsAndFollow.mock.calls[0][2],
    "the follow gives the grid the keyboard: the next typed line lands in a cell",
  ).toEqual({ keepFocus: true });
  expect(wrapper).toHaveBeenCalledTimes(1);
  expect(wrapper).toHaveBeenCalledWith(...args);
  expect(seam.activateSheet, "a follow must not make a second backend switch").not.toHaveBeenCalled();
}

describe("createLiveAppGateway() sheet switches go through @api/sheetSwitch", () => {
  // Changed deliberately (review rev3C#3): the switch keeps the keyboard on
  // the prompt, so `set cell Sheet2!A1 = 5` and the next typed line both stay
  // in the command line.
  it("setActiveSheet is the TAB CLICK (activateSheet): the grid follows the backend, the keyboard stays", async () => {
    const result = await createLiveAppGateway().setActiveSheet(2);
    expect(seam.activateSheet).toHaveBeenCalledTimes(1);
    expect(seam.activateSheet).toHaveBeenCalledWith(2, { keepFocus: true });
    expect(result.activeIndex).toBe(2);
  });
});

describe("every sheet-list change is FOLLOWED (review revG#2)", () => {
  // SABOTAGE: `addSheet: (name, kind) => addSheet(name, kind)` (the raw
  // wrapper, as before) -> the follow is never called.
  // Changed deliberately (review rev3C#8): the add tells WHERE the backend put
  // the new sheet -- its answer's active index, the end of the USER sheets --
  // so a sheet it pushed up (an object sheet in the tail) keeps its memory.
  // SABOTAGE: drop the insertedIndex function -> the renumbering reads undefined.
  it("add sheet: the backend makes the new sheet active, the grid follows it, told where it landed", async () => {
    const result = await createLiveAppGateway().addSheet("Report", "canvas");
    await expectFollowed(lib.addSheet, ["Report", "canvas"], { insertedIndex: 3 });
    expect(result.activeIndex).toBe(3);
  });

  // SABOTAGE: drop `{ removedIndex: index }` -> the renumbering is not told.
  it("delete sheet: followed WITH the index it removed, and the id still guards the delete", async () => {
    await createLiveAppGateway().deleteSheet(0, "id-Sheet1");
    await expectFollowed(lib.deleteSheet, [0, { expectedSheetId: "id-Sheet1" }], { removedIndex: 0 });
  });

  it("hide sheet (veryHidden too): followed, so a hide of the active sheet lands the grid on the neighbour", async () => {
    await createLiveAppGateway().hideSheet(0, "veryHidden");
    await expectFollowed(lib.hideSheet, [0, "veryHidden"], undefined);
  });

  it("unhide, rename and tab colour are followed too (a tab colour's wrapper announces nothing of its own)", async () => {
    const gateway = createLiveAppGateway();
    await gateway.unhideSheet(1);
    await expectFollowed(lib.unhideSheet, [1], undefined);
    seam.changeSheetsAndFollow.mockClear();
    await gateway.renameSheet(1, "Budget");
    await expectFollowed(lib.renameSheet, [1, "Budget"], undefined);
    seam.changeSheetsAndFollow.mockClear();
    await gateway.setTabColor(1, "#ff0000");
    await expectFollowed(lib.setTabColor, [1, "#ff0000"], undefined);
  });

  it("a refused change rejects through the follow (which announces nothing for it)", async () => {
    lib.deleteSheet.mockImplementationOnce(async () => {
      throw new Error("The sheets changed while that sheet was being deleted, so nothing was deleted.");
    });
    await expect(createLiveAppGateway().deleteSheet(1, "id-Sheet2")).rejects.toThrow(/nothing was deleted/);
    expect(seam.changeSheetsAndFollow).toHaveBeenCalledTimes(1);
  });
});
