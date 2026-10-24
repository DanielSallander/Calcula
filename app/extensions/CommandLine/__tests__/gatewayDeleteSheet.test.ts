// FILENAME: app/extensions/CommandLine/__tests__/gatewayDeleteSheet.test.ts
// PURPOSE: The LIVE gateway's `deleteSheet` hands the facade the stable id the
//          writer read with the index -- review CLI-DELETE-BY-STALE-INDEX.
// CONTEXT: `delete sheet <name>` resolves the name against a fresh read and
//          deletes by index; a temporary sheet's discard landing between the
//          two renumbers the sheets, and a delete by the bare index removed the
//          neighbour that slid into it (a sheet delete ends the undo history).
//          The writer passes the id (appCli.test.ts proves that over a mock
//          gateway); this file proves the live gateway forwards it to @api/lib
//          as `{ expectedSheetId }`, so the backend can refuse instead.

import { describe, expect, it, vi, beforeEach } from "vitest";

/* eslint-disable @typescript-eslint/naming-convention -- the doubles must match the real export names */

const { untouched, deleteSheet } = vi.hoisted(() => ({
  untouched: (name: string) => () => {
    throw new Error(`${name} must not be reached by deleteSheet`);
  },
  deleteSheet: vi.fn(async (_index: number, _options?: { expectedSheetId?: string }) => ({
    sheets: [],
    activeIndex: 0,
  })),
}));

vi.mock("@api/lib", () => ({
  addSheet: untouched("addSheet"),
  beginUndoTransaction: untouched("beginUndoTransaction"),
  calculateNow: untouched("calculateNow"),
  clearRangeWithOptions: untouched("clearRangeWithOptions"),
  commitUndoTransaction: untouched("commitUndoTransaction"),
  createNamedRange: untouched("createNamedRange"),
  deleteNamedRange: untouched("deleteNamedRange"),
  deleteSheet: (...a: [number, { expectedSheetId?: string }?]) => deleteSheet(...a),
  getAllNamedRanges: untouched("getAllNamedRanges"),
  getRangeCellsTyped: untouched("getRangeCellsTyped"),
  getSheets: untouched("getSheets"),
  getUsedRange: untouched("getUsedRange"),
  hideSheet: untouched("hideSheet"),
  redo: untouched("redo"),
  renameNamedRange: untouched("renameNamedRange"),
  renameSheet: untouched("renameSheet"),
  resolveNamedRangeCoords: untouched("resolveNamedRangeCoords"),
  setActiveSheet: untouched("setActiveSheet"),
  setTabColor: untouched("setTabColor"),
  sortRangeByColumn: untouched("sortRangeByColumn"),
  undo: untouched("undo"),
  unhideSheet: untouched("unhideSheet"),
  updateCell: untouched("updateCell"),
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
  deleteSheet.mockClear();
});

describe("createLiveAppGateway().deleteSheet", () => {
  it("forwards the expected id as the facade's `{ expectedSheetId }`, with the index", async () => {
    await createLiveAppGateway().deleteSheet(2, "id-Costs");
    expect(deleteSheet).toHaveBeenCalledTimes(1);
    expect(deleteSheet).toHaveBeenCalledWith(2, { expectedSheetId: "id-Costs" });
  });

  it("without an id it passes no options at all (the facade's unguarded spelling)", async () => {
    await createLiveAppGateway().deleteSheet(1);
    expect(deleteSheet).toHaveBeenCalledWith(1, undefined);
  });

  it("the backend's refusal reaches the writer as the rejection it is", async () => {
    const refusal = "The sheets changed while that sheet was being deleted, so nothing was deleted.";
    deleteSheet.mockImplementationOnce(async () => {
      throw refusal;
    });
    await expect(createLiveAppGateway().deleteSheet(2, "id-Costs")).rejects.toBe(refusal);
  });
});
