// FILENAME: app/extensions/CommandLine/__tests__/gatewayMacroListing.test.ts
// PURPOSE: The LIVE gateway's `listMacros` costs ONE backend call however many
//          modules the workbook holds, and still derives every entry's origin
//          from its own row.
// CONTEXT: `createLiveAppGateway().listMacros` went through
//          `listWorkbookScriptRecords`, which fans out to one `get_script` per
//          module — on every `ls macros`, every `run`, and every session
//          refresh — to fetch bodies the CLI never lists, shows or runs (`run`
//          goes through the macroRunService seam, which reads the record
//          itself). The summary row carries `sourcePackage` verbatim from the
//          record, so provenance needs nothing more than the listing. The
//          source-shape guard in macroProvenance.test.ts pins WHICH door the
//          gateway names; this file pins what that door COSTS, by counting.

import { describe, expect, it, vi, beforeEach } from "vitest";

/* eslint-disable @typescript-eslint/naming-convention -- the doubles must match the real export names */

// ---------------------------------------------------------------------------
// The workbook-script doors, counted. Only the summary listing has rows to
// give; the two per-record doors exist so that a call to either is visible.
// ---------------------------------------------------------------------------
const listWorkbookScripts = vi.fn(async () => [
  { id: "macro-hello", name: "Hello", scope: { type: "workbook" as const } },
  { id: "macro-remit", name: "Remit", scope: { type: "workbook" as const }, sourcePackage: "Q3 Report" },
  { id: "macro-blank", name: "Blank", sourcePackage: "   " },
  { id: "macro-local-named", name: "Named local", sourcePackage: "local" },
]);
const listWorkbookScriptRecords = vi.fn(async () => {
  throw new Error("the gateway must not fan out to the full record inventory");
});
const getWorkbookScript = vi.fn(async () => {
  throw new Error("the gateway must not fetch a record to list it");
});

vi.mock("@api/workbookScripts", () => ({
  listWorkbookScripts: (...a: unknown[]) => listWorkbookScripts(...(a as [])),
  listWorkbookScriptRecords: (...a: unknown[]) => listWorkbookScriptRecords(...(a as [])),
  getWorkbookScript: (...a: unknown[]) => getWorkbookScript(...(a as [])),
}));

// ---------------------------------------------------------------------------
// Everything else the gateway module imports, stubbed: none of it is reached
// by `listMacros`, and a stub that throws makes any accidental reach visible.
// Hoisted, because the `vi.mock` factories below are hoisted above every
// top-level `const` and would otherwise read it before initialization.
// ---------------------------------------------------------------------------
const { untouched } = vi.hoisted(() => ({
  untouched: (name: string) => () => {
    throw new Error(`${name} must not be reached by listMacros`);
  },
}));

vi.mock("@api/lib", () => ({
  addSheet: untouched("addSheet"),
  beginUndoTransaction: untouched("beginUndoTransaction"),
  calculateNow: untouched("calculateNow"),
  clearRangeWithOptions: untouched("clearRangeWithOptions"),
  commitUndoTransaction: untouched("commitUndoTransaction"),
  createNamedRange: untouched("createNamedRange"),
  deleteNamedRange: untouched("deleteNamedRange"),
  deleteSheet: untouched("deleteSheet"),
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

vi.mock("@api/macroRunService", () => ({
  hasMacroRunProvider: untouched("hasMacroRunProvider"),
  requireMacroRunProvider: untouched("requireMacroRunProvider"),
}));

/* eslint-enable @typescript-eslint/naming-convention */

import { createLiveAppGateway } from "../cli/appGateway";

beforeEach(() => {
  listWorkbookScripts.mockClear();
  listWorkbookScriptRecords.mockClear();
  getWorkbookScript.mockClear();
});

describe("createLiveAppGateway().listMacros", () => {
  it("costs ONE backend call for a workbook of N local + M distributed modules", async () => {
    const entries = await createLiveAppGateway().listMacros();

    expect(
      listWorkbookScripts,
      "the summary listing is the one call that has to happen",
    ).toHaveBeenCalledTimes(1);
    expect(
      getWorkbookScript,
      "one `get_script` per module, on every ls/run/refresh, to fetch bodies the CLI never shows",
    ).not.toHaveBeenCalled();
    expect(listWorkbookScriptRecords).not.toHaveBeenCalled();
    expect(entries).toHaveLength(4);
  });

  it("still derives every origin from the row's own stamp, and never from the name", async () => {
    const entries = await createLiveAppGateway().listMacros();
    const byId = new Map(entries.map((e) => [e.id, e]));

    expect(byId.get("macro-hello")!.origin).toEqual({ kind: "local" });
    expect(byId.get("macro-remit")!.origin).toEqual({ kind: "package", name: "Q3 Report" });
    // A blank stamp is a stamp: a nameless publisher's code, never the user's.
    expect(byId.get("macro-blank")!.origin).toEqual({
      kind: "package",
      name: "(unknown package)",
    });
    // ...and a publisher who names the application `local` still gets a package.
    expect(byId.get("macro-local-named")!.origin).toEqual({ kind: "package", name: "local" });
    // Nothing was read that could fail, so no entry claims an unreadable record.
    expect(entries.every((e) => e.loadError === null)).toBe(true);
    expect(byId.get("macro-remit")!.scope).toEqual({ type: "workbook" });
  });
});
