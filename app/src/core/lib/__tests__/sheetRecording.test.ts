//! FILENAME: app/src/core/lib/__tests__/sheetRecording.test.ts
// PURPOSE: What the macro recorder sees from the sheet wrappers, and the one
//          option that hides a call from it. `deleteSheet` and `setActiveSheet`
//          record by default; `{ record: false }` records NOTHING while every
//          other effect of the call stays (the backend invoke, the SHEET_DELETED
//          and MUTATION_REFRESH announcements). The temporary sheet's two
//          primitives go BY STABLE ID: `keepEphemeralSheet` invokes the keep and
//          announces the `sheets` domain; `discardEphemeralSheet` invokes the
//          discard, announces EXACTLY what `deleteSheet` announces -- with the
//          index and name the BACKEND reports -- and records nothing. And
//          `deleteSheet`'s `{ expectedSheetId }` (the tab strip's Delete): the
//          id rides the invoke, a refusal announces and records nothing, and
//          SHEET_DELETED names the sheet by that id.
// CONTEXT: A drill-through lands on a temporary sheet and the tab strip
//          discards it when the user leaves; a macro recorded across one would
//          otherwise replay `deleteSheet(index)` on whatever sheet holds that
//          index later (docs/design/model-drillthrough.md 2.7). Same harness as
//          mergeRecording.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  deleteSheet,
  discardEphemeralSheet,
  keepEphemeralSheet,
  setActiveSheet,
  setGridRecorderHook,
  type DiscardedSheet,
  type RecordedGridEvent,
  type SheetsResult,
} from "../tauri-api";
import { AppEvents } from "../events";

const recorded: RecordedGridEvent[] = [];
const announced: Array<{ type: string; detail: unknown }> = [];
const onEvent = (e: Event) => announced.push({ type: e.type, detail: (e as CustomEvent).detail });

const LIST: SheetsResult = {
  sheets: [
    { index: 0, name: "Sheet1", visibility: "visible", sheetId: "a" },
    { index: 1, name: "Drillthrough", visibility: "visible", sheetId: "b", ephemeral: true },
  ],
  activeIndex: 1,
};
const AFTER: SheetsResult = { sheets: [LIST.sheets[0]], activeIndex: 0 };

beforeEach(() => {
  invoke.mockReset();
  // The wrappers read the list first (`sheetNamesBefore`); every other command
  // answers the list as it is afterwards.
  invoke.mockImplementation(async (cmd: string) => (cmd === "get_sheets" ? LIST : AFTER));
  recorded.length = 0;
  announced.length = 0;
  setGridRecorderHook((e) => recorded.push(e));
  window.addEventListener(AppEvents.SHEET_DELETED, onEvent);
  window.addEventListener(AppEvents.MUTATION_REFRESH, onEvent);
});

afterEach(() => {
  setGridRecorderHook(null);
  window.removeEventListener(AppEvents.SHEET_DELETED, onEvent);
  window.removeEventListener(AppEvents.MUTATION_REFRESH, onEvent);
});

describe("deleteSheet", () => {
  it("records a deleteSheet step by default", async () => {
    await deleteSheet(1);
    expect(invoke).toHaveBeenCalledWith("delete_sheet", { index: 1 });
    expect(recorded).toEqual([{ kind: "deleteSheet", index: 1 }]);
  });

  it("{ record: false } records NOTHING and changes nothing else: the backend call and both announcements still happen", async () => {
    const result = await deleteSheet(1, { record: false });
    expect(result).toEqual(AFTER);
    expect(invoke).toHaveBeenCalledWith("delete_sheet", { index: 1 });
    expect(recorded).toEqual([]);
    expect(announced.map((a) => a.type)).toEqual([AppEvents.SHEET_DELETED, AppEvents.MUTATION_REFRESH]);
    expect(announced[0].detail).toEqual({ sheetIndex: 1, sheetName: "Drillthrough" });
    expect((announced[1].detail as { domains: string[] }).domains).toContain("sheets");
  });

  it("an explicit { record: true } and an empty options object record as the default does", async () => {
    await deleteSheet(1, { record: true });
    await deleteSheet(1, {});
    expect(recorded).toEqual([
      { kind: "deleteSheet", index: 1 },
      { kind: "deleteSheet", index: 1 },
    ]);
  });
});

// The tab strip's Delete names the sheet its confirmation showed BY STABLE ID
// (model-drillthrough.md 2.7, review DISCARD-RENUMBERS-UNDER-DELETE-CONFIRM):
// the backend deletes only if the sheet at `index` still carries it.
describe("deleteSheet with { expectedSheetId }", () => {
  it("sends the id with the index, so the backend can refuse a delete whose index names another sheet", async () => {
    await deleteSheet(1, { expectedSheetId: "b" });
    expect(invoke).toHaveBeenCalledWith("delete_sheet", { index: 1, expectedSheetId: "b" });
    expect(recorded).toEqual([{ kind: "deleteSheet", index: 1 }]);
  });

  it("without one the invoke carries the index alone (every other caller is unchanged)", async () => {
    await deleteSheet(1, { record: false });
    expect(invoke.mock.calls.filter((c) => c[0] === "delete_sheet")).toEqual([["delete_sheet", { index: 1 }]]);
  });

  it("the refusal -- the sheets changed under the delete -- propagates, and NOTHING is announced or recorded", async () => {
    const refusal = "The sheets changed while that sheet was being deleted, so nothing was deleted.";
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "delete_sheet") throw refusal;
      return LIST;
    });
    await expect(deleteSheet(1, { expectedSheetId: "b" })).rejects.toBe(refusal);
    expect(announced).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("SHEET_DELETED names the sheet BY ITS ID: a pre-read taken before a renumbering still names the sheet that went", async () => {
    // The names were read while "Drillthrough" (id b) stood at 1; by the time
    // the delete held its locks it stood at 0, and the backend deleted it there.
    await deleteSheet(0, { expectedSheetId: "b", record: false });
    expect(announced[0]).toEqual({ type: AppEvents.SHEET_DELETED, detail: { sheetIndex: 0, sheetName: "Drillthrough" } });
  });
});

describe("setActiveSheet", () => {
  it("records an activateSheet step by default, and not with { record: false }", async () => {
    await setActiveSheet(1);
    await setActiveSheet(1, { record: false });
    expect(invoke.mock.calls.filter((c) => c[0] === "set_active_sheet")).toEqual([
      ["set_active_sheet", { index: 1 }],
      ["set_active_sheet", { index: 1 }],
    ]);
    expect(recorded).toEqual([{ kind: "activateSheet", index: 1 }]);
  });
});

describe("keepEphemeralSheet (by stable id)", () => {
  it("invokes the sheet primitive by its own name with the sheet's ID, records nothing (a flag no macro replays) and announces the sheets domain", async () => {
    const result = await keepEphemeralSheet("b");
    expect(invoke).toHaveBeenCalledWith("keep_ephemeral_sheet", { sheetId: "b" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result).toEqual(AFTER);
    expect(recorded).toEqual([]);
    expect(announced.map((a) => a.type)).toEqual([AppEvents.MUTATION_REFRESH]);
    expect(announced[0].detail).toEqual({ domains: ["sheets"], source: "commit" });
  });

  // The backend's real contract (C2): an id no sheet has is refused; a sheet
  // that is ALREADY ordinary is not (a second keep of the same sheet is true),
  // so the caller reads the answered list before saying "kept".
  it("a refusal (an id no sheet has) propagates and announces nothing", async () => {
    invoke.mockRejectedValueOnce("There is no sheet with that id.");
    await expect(keepEphemeralSheet("gone")).rejects.toBe("There is no sheet with that id.");
    expect(announced).toEqual([]);
  });
});

describe("discardEphemeralSheet (by stable id)", () => {
  const ANSWER: DiscardedSheet = { deletedIndex: 1, deletedName: "Drillthrough", result: AFTER };

  beforeEach(() => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "discard_ephemeral_sheet" ? ANSWER : LIST));
  });

  it("invokes the discard primitive with the sheet's ID and nothing else: no pre-read, no index", async () => {
    const answer = await discardEphemeralSheet("b");
    expect(answer).toEqual(ANSWER);
    expect(invoke.mock.calls).toEqual([["discard_ephemeral_sheet", { sheetId: "b" }]]);
  });

  it("records NOTHING (the discard is the drill's consequence, not a macro step)", async () => {
    await discardEphemeralSheet("b");
    expect(recorded).toEqual([]);
  });

  it("announces SHEET_DELETED with the index and name the BACKEND reports -- not any index the caller held", async () => {
    invoke.mockImplementation(async () => ({ deletedIndex: 4, deletedName: "Moved", result: AFTER }));
    await discardEphemeralSheet("b");
    expect(announced[0]).toEqual({ type: AppEvents.SHEET_DELETED, detail: { sheetIndex: 4, sheetName: "Moved" } });
  });

  it("announces EXACTLY what deleteSheet announces: the same events, in the same order, over the same seven domains", async () => {
    await discardEphemeralSheet("b");
    const discardAnnouncements = announced.splice(0);
    invoke.mockImplementation(async (cmd: string) => (cmd === "get_sheets" ? LIST : AFTER));
    await deleteSheet(1, { record: false });
    const deleteAnnouncements = announced.splice(0);
    expect(discardAnnouncements.map((a) => a.type)).toEqual([AppEvents.SHEET_DELETED, AppEvents.MUTATION_REFRESH]);
    expect(discardAnnouncements).toEqual(deleteAnnouncements);
    expect((discardAnnouncements[1].detail as { domains: string[] }).domains).toEqual([
      "sheets", "slicer", "pivot", "ribbonFilter", "objects", "paneControl", "floatingRanges",
    ]);
  });

  it("a refusal (unknown id, no longer temporary, structure protected) propagates and announces nothing", async () => {
    invoke.mockRejectedValueOnce("That sheet is not temporary any more.");
    await expect(discardEphemeralSheet("b")).rejects.toBe("That sheet is not temporary any more.");
    expect(announced).toEqual([]);
    expect(recorded).toEqual([]);
  });
});
