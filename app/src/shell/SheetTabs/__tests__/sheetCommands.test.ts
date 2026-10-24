//! FILENAME: app/src/shell/SheetTabs/__tests__/sheetCommands.test.ts
// PURPOSE: The core.sheet.* commands (Excel's Home > Cells > Insert Sheet /
//          Delete Sheet and Format > Hide & Unhide / Organize Sheets) run the
//          SHEET TAB STRIP's own handlers for the active sheet -- never the raw
//          @api addSheet / deleteSheet, which would skip the strip's
//          sheet-switch steps (beforeSwitch, the canvas prime, the Redux sheet
//          context, normalSwitch, SHEET_CHANGED).
// CONTEXT: The strip is a component; the commands are registered once at
//          bootstrap, long before it mounts. They meet through a controller the
//          strip registers (sheetCommands.ts). This file drives the commands
//          against a FAKE controller: it proves what each command asks the
//          strip to do, and which commands are refused -- with one toast --
//          before the strip is asked anything. What the strip then does is
//          proved by sheetPlacement.test.ts (the arithmetic) and
//          sheetTabCommandWiring.test.ts (the wiring).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prompt: vi.fn(),
  openDialog: vi.fn(),
  registerDialog: vi.fn(),
}));

vi.mock("@api/dialogs", () => ({
  promptAsync: (...a: unknown[]) => h.prompt(...a),
  alertAsync: vi.fn(async () => undefined),
  confirmAsync: vi.fn(async () => false),
}));
vi.mock("@api/ui", () => ({
  DialogExtensions: {
    openDialog: (...a: unknown[]) => h.openDialog(...a),
    registerDialog: (...a: unknown[]) => h.registerDialog(...a),
    unregisterDialog: vi.fn(),
  },
}));

import { CommandRegistry, CoreCommands } from "@api/commands";
import { commandRefusalFor } from "@api/commandRefusals";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import {
  registerSheetCommands,
  registerSheetTabsController,
  getSheetTabsController,
  SHEET_DISCARD_EPHEMERAL_COMMAND,
  type SheetTabsController,
  type SheetTabsSnapshot,
} from "../sheetCommands";
import { promptForSheetName } from "../renameSheetPrompt";
import { MOVE_OR_COPY_SHEET_DIALOG_ID, type MoveOrCopySheetData } from "../../dialogs/MoveOrCopySheetDialog";

const SHEET_COMMANDS = [
  CoreCommands.SHEET_INSERT,
  CoreCommands.SHEET_DELETE,
  CoreCommands.SHEET_RENAME,
  CoreCommands.SHEET_HIDE,
  CoreCommands.SHEET_UNHIDE,
  CoreCommands.SHEET_TAB_COLOR,
  CoreCommands.SHEET_MOVE_OR_COPY,
] as const;

type Sheet = SheetTabsSnapshot["sheets"][number];

const sheet = (index: number, name: string, extra: Partial<Sheet> = {}): Sheet => ({
  index,
  name,
  visibility: "visible",
  sheetId: `id-${name}`,
  ...extra,
});

const toasts: ToastPayload[] = [];
let releaseCommands: () => void = () => {};
let releaseController: () => void = () => {};

function fakeController(snapshot: SheetTabsSnapshot) {
  const c = {
    snapshot: () => snapshot,
    insertSheetBefore: vi.fn(async () => undefined),
    appendSheet: vi.fn(async () => undefined),
    deleteSheet: vi.fn(async () => undefined),
    discardSheet: vi.fn(async (_sheetId: string): Promise<boolean> => true),
    keepSheet: vi.fn(async (_sheetId: string | undefined) => undefined),
    renameSheet: vi.fn(async () => undefined),
    hideSheet: vi.fn(async () => undefined),
    openUnhideDialog: vi.fn(async () => undefined),
    setTabColor: vi.fn(async () => undefined),
    moveOrCopySheet: vi.fn(async () => undefined),
  };
  return c satisfies SheetTabsController;
}

function mount(snapshot: SheetTabsSnapshot) {
  releaseController();
  const c = fakeController(snapshot);
  releaseController = registerSheetTabsController(c);
  return c;
}

const TWO_SHEETS: SheetTabsSnapshot = {
  sheets: [sheet(0, "Sheet1"), sheet(1, "Data")],
  activeIndex: 1,
  locked: false,
};

beforeAll(() => {
  registerToastSink((t) => toasts.push(t));
  releaseCommands = registerSheetCommands();
});
afterAll(() => {
  releaseController();
  releaseCommands();
});
beforeEach(() => {
  toasts.length = 0;
  h.prompt.mockReset();
  h.openDialog.mockReset();
});

describe("registration", () => {
  it("registers all seven core.sheet.* commands", () => {
    for (const id of SHEET_COMMANDS) expect(CommandRegistry.has(id), id).toBe(true);
  });

  it("registers the Move or Copy dialog", () => {
    expect(h.registerDialog.mock.calls.map((c) => (c[0] as { id: string }).id)).toContain(
      MOVE_OR_COPY_SHEET_DIALOG_ID,
    );
  });

  it("none is script-safe (each changes the workbook's STRUCTURE, which no grid-data API grants)", () => {
    for (const id of SHEET_COMMANDS) expect(CommandRegistry.isScriptSafe(id), id).toBe(false);
  });
});

describe("Insert Sheet", () => {
  it("inserts BEFORE the active sheet (Excel's Shift+F11)", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_INSERT);
    expect(c.insertSheetBefore).toHaveBeenCalledWith(1);
  });

  it("`{ index }` names another anchor", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { index: 0 });
    expect(c.insertSheetBefore).toHaveBeenCalledWith(0);
  });

  it("an index the strip does not list is refused, not guessed", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { index: 9 });
    expect(c.insertSheetBefore).not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
  });

  // Review finding (2026-10-08): the Canvas tab's New Page reached the strip
  // through the Shell's PRIVATE `sheet:requestAdd` window event, because this
  // command could not say "a canvas". It can now: `{ kind }` names the kind
  // of sheet, `{ atEnd: true }` appends instead of inserting before an anchor.
  it("`{ kind: \"canvas\" }` inserts a CANVAS before the anchor", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { kind: "canvas" });
    expect(c.insertSheetBefore).toHaveBeenCalledWith(1, "canvas");
    expect(c.appendSheet).not.toHaveBeenCalled();
  });

  it("`{ atEnd: true }` APPENDS (the strip's \"+\"), of the kind named or a worksheet", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { kind: "canvas", atEnd: true });
    expect(c.appendSheet).toHaveBeenCalledWith("canvas");
    await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { atEnd: true });
    expect(c.appendSheet).toHaveBeenLastCalledWith(undefined);
    expect(c.insertSheetBefore).not.toHaveBeenCalled();
  });

  it("an unknown kind is refused by name, not guessed into a worksheet", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { kind: "chart" });
    expect(c.insertSheetBefore).not.toHaveBeenCalled();
    expect(c.appendSheet).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toMatch(/chart/);
  });

  it("the structure lock refuses the canvas insert too (one door, one set of refusals)", async () => {
    const c = mount({ ...TWO_SHEETS, locked: true });
    await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { kind: "canvas", atEnd: true });
    expect(c.appendSheet).not.toHaveBeenCalled();
  });
});

describe("Delete Sheet", () => {
  it("asks the strip to delete the active sheet (the strip decides whether to confirm)", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_DELETE);
    expect(c.deleteSheet).toHaveBeenCalledWith(1);
  });

  it("refuses the last VISIBLE sheet with Excel's sentence, before any dialog", async () => {
    const c = mount({
      sheets: [sheet(0, "Only"), sheet(1, "Hidden", { visibility: "hidden" })],
      activeIndex: 0,
      locked: false,
    });
    await CommandRegistry.execute(CoreCommands.SHEET_DELETE);
    expect(c.deleteSheet).not.toHaveBeenCalled();
    expect(toasts.map((t) => t.message).join(" ")).toMatch(/at least one visible/i);
  });

  it("a HIDDEN sheet can still be deleted beside the last visible one", async () => {
    const c = mount({
      sheets: [sheet(0, "Only"), sheet(1, "Hidden", { visibility: "hidden" })],
      activeIndex: 0,
      locked: false,
    });
    await CommandRegistry.execute(CoreCommands.SHEET_DELETE, { index: 1 });
    expect(c.deleteSheet).toHaveBeenCalledWith(1);
  });
});

describe("Rename Sheet", () => {
  it("prompts with the active sheet's name and renames to the trimmed answer", async () => {
    const c = mount(TWO_SHEETS);
    h.prompt.mockResolvedValue("  Totals  ");
    await CommandRegistry.execute(CoreCommands.SHEET_RENAME);
    expect(h.prompt.mock.calls[0][1]).toMatchObject({ defaultValue: "Data" });
    expect(c.renameSheet).toHaveBeenCalledWith(1, "Totals", "id-Data");
  });

  // Review TSHELL3-CONVERSE-OTHER-DOORS: a temporary sheet's discard can land
  // while the prompt is open and hand the sheet's index to its neighbour. The
  // strip is given the STABLE id read before the prompt, and finds the sheet
  // by it.
  it("hands the strip the id it read BEFORE the prompt, though the list renumbered while the prompt was open", async () => {
    const snapshot: SheetTabsSnapshot = {
      sheets: [sheet(0, "Sheet1"), sheet(1, "Drillthrough", { ephemeral: true }), sheet(2, "Data")],
      activeIndex: 2,
      locked: false,
    };
    const c = mount(snapshot);
    h.prompt.mockImplementation(async () => {
      // The discard lands while the prompt is open: Data is index 1 now.
      snapshot.sheets = [sheet(0, "Sheet1"), sheet(1, "Data")];
      snapshot.activeIndex = 1;
      return "Totals";
    });
    await CommandRegistry.execute(CoreCommands.SHEET_RENAME);
    expect(c.renameSheet).toHaveBeenCalledTimes(1);
    expect(c.renameSheet.mock.calls[0][2]).toBe("id-Data");
  });

  it("Cancel, a blank answer or the same name renames nothing", async () => {
    const c = mount(TWO_SHEETS);
    for (const answer of [null, "   ", "Data", " Data "]) {
      h.prompt.mockResolvedValueOnce(answer);
      await CommandRegistry.execute(CoreCommands.SHEET_RENAME);
    }
    expect(c.renameSheet).not.toHaveBeenCalled();
  });

  it("`{ index }` renames THAT sheet, seeded with its own name", async () => {
    const c = mount(TWO_SHEETS);
    h.prompt.mockResolvedValue("First");
    await CommandRegistry.execute(CoreCommands.SHEET_RENAME, { index: 0 });
    expect(h.prompt.mock.calls[0][1]).toMatchObject({ defaultValue: "Sheet1" });
    expect(c.renameSheet).toHaveBeenCalledWith(0, "First", "id-Sheet1");
  });
});

describe("promptForSheetName (the one rename prompt every door shows)", () => {
  it("asks the tab's question", async () => {
    h.prompt.mockResolvedValue("X");
    await promptForSheetName("Sheet1");
    expect(h.prompt).toHaveBeenCalledWith("Enter new sheet name:", { title: "Rename sheet", defaultValue: "Sheet1" });
  });

  it("answers the trimmed new name, or null", async () => {
    h.prompt.mockResolvedValueOnce(" New ");
    expect(await promptForSheetName("Old")).toBe("New");
    h.prompt.mockResolvedValueOnce(null);
    expect(await promptForSheetName("Old")).toBeNull();
    h.prompt.mockResolvedValueOnce("Old ");
    expect(await promptForSheetName("Old")).toBeNull();
  });
});

describe("Hide Sheet / Unhide Sheet", () => {
  it("hides the active sheet", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_HIDE);
    expect(c.hideSheet).toHaveBeenCalledWith(1);
  });

  it("refuses to hide the last visible sheet", async () => {
    const c = mount({ sheets: [sheet(0, "Only")], activeIndex: 0, locked: false });
    await CommandRegistry.execute(CoreCommands.SHEET_HIDE);
    expect(c.hideSheet).not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
  });

  it("Unhide is REFUSED while no sheet is hidden -- the refusal any door can ask (Excel greys it)", async () => {
    const c = mount(TWO_SHEETS);
    expect(commandRefusalFor(CoreCommands.SHEET_UNHIDE)).toMatch(/no sheets are hidden/i);
    await CommandRegistry.execute(CoreCommands.SHEET_UNHIDE);
    expect(c.openUnhideDialog).not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
  });

  it("Unhide opens the strip's Unhide dialog when a sheet is hidden", async () => {
    const c = mount({
      sheets: [sheet(0, "A"), sheet(1, "B", { visibility: "hidden" })],
      activeIndex: 0,
      locked: false,
    });
    expect(commandRefusalFor(CoreCommands.SHEET_UNHIDE)).toBeNull();
    await CommandRegistry.execute(CoreCommands.SHEET_UNHIDE);
    expect(c.openUnhideDialog).toHaveBeenCalledTimes(1);
  });

  it("a veryHidden sheet is not offered for unhiding (Excel: only VBA can show it)", () => {
    mount({
      sheets: [sheet(0, "A"), sheet(1, "B", { visibility: "veryHidden" })],
      activeIndex: 0,
      locked: false,
    });
    expect(commandRefusalFor(CoreCommands.SHEET_UNHIDE)).toMatch(/no sheets are hidden/i);
  });
});

describe("Tab Color { color: string | null }", () => {
  it("sets a hex colour on the active sheet", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_TAB_COLOR, { color: "#FF0000" });
    expect(c.setTabColor).toHaveBeenCalledWith(1, "#FF0000");
  });

  it("null is No Color (the backend's empty string)", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_TAB_COLOR, { color: null });
    expect(c.setTabColor).toHaveBeenCalledWith(1, "");
  });

  it("anything that is not a hex colour or null is refused, not stored", async () => {
    const c = mount(TWO_SHEETS);
    for (const args of [undefined, {}, { color: "red" }, { color: "#12" }, { color: "url(x)" }, { color: 5 }]) {
      await CommandRegistry.execute(CoreCommands.SHEET_TAB_COLOR, args);
    }
    expect(c.setTabColor).not.toHaveBeenCalled();
    expect(toasts.length).toBe(6);
  });
});

describe("Move or Copy Sheet...", () => {
  it("opens the dialog with the visible sheets in tab order and the active sheet as the source", async () => {
    mount({
      sheets: [sheet(0, "A"), sheet(1, "H", { visibility: "hidden" }), sheet(2, "B")],
      activeIndex: 2,
      locked: false,
    });
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY);
    expect(h.openDialog).toHaveBeenCalledTimes(1);
    const [id, data] = h.openDialog.mock.calls[0] as [string, MoveOrCopySheetData];
    expect(id).toBe(MOVE_OR_COPY_SHEET_DIALOG_ID);
    // By STABLE id: no index travels into the dialog, so none can come back out.
    expect(data.sheets).toEqual([
      { sheetId: "id-A", name: "A" },
      { sheetId: "id-B", name: "B" },
    ]);
    expect(data.sourceSheetId).toBe("id-B");
    expect(data.sourceName).toBe("B");
    expect(data.canCopy).toBe(true);
    expect(Object.keys(data)).not.toContain("sourceIndex");
  });

  it("the dialog's answer reaches the strip BY ID: the source's, and the chosen sheet's", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY);
    const data = h.openDialog.mock.calls[0][1] as MoveOrCopySheetData;
    await data.onResult({ beforeSheetId: "id-Sheet1", copy: true });
    expect(c.moveOrCopySheet).toHaveBeenCalledWith("id-Data", "id-Sheet1", true);
  });

  // Review TSHELL3-CONVERSE-DIALOG-WINDOW: the dialog stayed open while a
  // temporary sheet's discard renumbered the sheets, and OK then answered the
  // indices it was opened with -- which named other sheets by then.
  it("a discard renumbering the sheets while the dialog is open changes nothing it answers: the ids it opened with reach the strip", async () => {
    const snapshot: SheetTabsSnapshot = {
      sheets: [sheet(0, "Sales"), sheet(1, "Drillthrough", { ephemeral: true }), sheet(2, "Costs"), sheet(3, "Summary"), sheet(4, "Q4")],
      activeIndex: 0,
      locked: false,
    };
    const c = mount(snapshot);
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { index: 3 });
    const data = h.openDialog.mock.calls[0][1] as MoveOrCopySheetData;
    // The discard lands while the dialog is open: Summary is index 2, Q4 index 3.
    snapshot.sheets = [sheet(0, "Sales"), sheet(1, "Costs"), sheet(2, "Summary"), sheet(3, "Q4")];
    await data.onResult({ beforeSheetId: "id-Q4", copy: true });
    expect(c.moveOrCopySheet).toHaveBeenCalledWith("id-Summary", "id-Q4", true);
  });

  it("a canvas cannot be copied (the backend refuses one), so the dialog offers move only", async () => {
    mount({ sheets: [sheet(0, "A"), sheet(1, "Page", { kind: "canvas" })], activeIndex: 1, locked: false });
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY);
    expect((h.openDialog.mock.calls[0][1] as MoveOrCopySheetData).canCopy).toBe(false);
  });

  it("args run it without the dialog: `{ beforeIndex: null }` is (move to end)", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { beforeIndex: null, copy: false });
    expect(h.openDialog).not.toHaveBeenCalled();
    expect(c.moveOrCopySheet).toHaveBeenCalledWith("id-Data", null, false);
  });

  it("args name sheets by index, turned into their ids AT THE CALL, against the list just read", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { index: 0, beforeIndex: 1, copy: true });
    expect(c.moveOrCopySheet).toHaveBeenCalledWith("id-Sheet1", "id-Data", true);
  });

  it("a `beforeIndex` no visible sheet has is refused with one toast, never read as (move to end)", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { beforeIndex: 7, copy: false });
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { beforeIndex: "0", copy: false });
    expect(c.moveOrCopySheet).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(2);
  });

  it("a sheet the workbook reports no id for (an older backend) is refused with one toast: it could not be followed", async () => {
    const c = mount({ sheets: [sheet(0, "A", { sheetId: undefined }), sheet(1, "B")], activeIndex: 0, locked: false });
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY);
    expect(h.openDialog).not.toHaveBeenCalled();
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { index: 1, beforeIndex: 0, copy: false });
    expect(c.moveOrCopySheet).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(2);
    expect(toasts[0].message).toMatch(/"A" cannot be moved or copied/);
  });

  it("a copy of a canvas asked for by args is refused", async () => {
    const c = mount({ sheets: [sheet(0, "A"), sheet(1, "Page", { kind: "canvas" })], activeIndex: 1, locked: false });
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { beforeIndex: 0, copy: true });
    expect(c.moveOrCopySheet).not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
  });
});

// Review SHEET-COMMAND-MALFORMED-INDEX-RETARGETS-ACTIVE: an `index` that was
// PRESENT but not a number was read as ABSENT, and the command acted on the
// ACTIVE sheet -- through the command line's `command <id> = <json>`, which runs
// without a confirm card. Only an absent index means "the active sheet".
describe("a malformed argument is refused by name, never read as absent", () => {
  /** Active = 2 ("Summary"), so a fallback to the active sheet is visible. */
  const THREE: SheetTabsSnapshot = {
    sheets: [sheet(0, "Sales"), sheet(1, "Costs"), sheet(2, "Summary")],
    activeIndex: 2,
    locked: false,
  };
  /** Every controller call the fake recorded (the snapshot read excluded). */
  const stripCalls = (c: ReturnType<typeof fakeController>): number =>
    Object.entries(c).reduce(
      (n, [name, fn]) =>
        name !== "snapshot" && typeof fn === "function" && "mock" in fn
          ? n + (fn as ReturnType<typeof vi.fn>).mock.calls.length
          : n,
      0,
    );
  const INDEX_COMMANDS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    [CoreCommands.SHEET_INSERT, {}],
    [CoreCommands.SHEET_DELETE, {}],
    [CoreCommands.SHEET_RENAME, {}],
    [CoreCommands.SHEET_HIDE, {}],
    [CoreCommands.SHEET_TAB_COLOR, { color: "#FF0000" }],
    [CoreCommands.SHEET_MOVE_OR_COPY, {}],
  ];

  it.each(INDEX_COMMANDS)("%s with an index that is present but not a whole number asks the strip nothing and says so once", async (id, extra) => {
    h.prompt.mockResolvedValue("Renamed");
    for (const bad of ["0", "1", null, 1.5, true, { at: 0 }]) {
      const c = mount(THREE);
      toasts.length = 0;
      await CommandRegistry.execute(id, { ...extra, index: bad });
      expect(stripCalls(c), `${id} acted for index ${JSON.stringify(bad)}`).toBe(0);
      expect(toasts.map((t) => t.message), `${id} index ${JSON.stringify(bad)}`).toEqual([
        `"index" takes a sheet's number, such as 0 (got ${typeof bad === "string" ? `"${bad}"` : JSON.stringify(bad)}).`,
      ]);
    }
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.openDialog).not.toHaveBeenCalled();
  });

  it("controls: an ABSENT index (missing, or undefined) is the active sheet, and a whole number names its sheet", async () => {
    const c = mount(THREE);
    await CommandRegistry.execute(CoreCommands.SHEET_HIDE);
    await CommandRegistry.execute(CoreCommands.SHEET_HIDE, {});
    await CommandRegistry.execute(CoreCommands.SHEET_HIDE, { index: undefined });
    await CommandRegistry.execute(CoreCommands.SHEET_HIDE, { index: 0 });
    expect(c.hideSheet.mock.calls).toEqual([[2], [2], [2], [0]]);
    expect(toasts).toEqual([]);
  });

  it("the finding's own line: {\"index\":\"0\",\"beforeIndex\":2,\"copy\":\"true\"} moves NOTHING -- the active sheet least of all", async () => {
    const c = mount(THREE);
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { index: "0", beforeIndex: 2, copy: "true" });
    expect(c.moveOrCopySheet).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
  });

  it("Move or Copy's `copy` must be true or false: \"true\" is refused, never quietly a move", async () => {
    const c = mount(THREE);
    for (const copy of ["true", 1, null]) {
      toasts.length = 0;
      await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { index: 0, beforeIndex: 2, copy });
      expect(toasts.map((t) => t.message)).toEqual([
        `"copy" takes true or false (got ${typeof copy === "string" ? `"${copy}"` : JSON.stringify(copy)}).`,
      ]);
    }
    expect(c.moveOrCopySheet).not.toHaveBeenCalled();
    // An absent `copy` is a move, as it always was.
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { index: 0, beforeIndex: 2 });
    expect(c.moveOrCopySheet).toHaveBeenCalledWith("id-Sales", "id-Summary", false);
  });

  it("a `beforeIndex` of the wrong TYPE is named as a type mistake -- not 'no visible sheet at index 2' while sheet 2 exists", async () => {
    const c = mount(THREE);
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { index: 0, beforeIndex: "2", copy: false });
    expect(c.moveOrCopySheet).not.toHaveBeenCalled();
    expect(toasts.map((t) => t.message)).toEqual([`"beforeIndex" takes a sheet's number, such as 0 (got "2").`]);
  });

  it("Insert's `atEnd` must be true or false: \"true\" is refused before anything is added", async () => {
    const c = mount(THREE);
    await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { atEnd: "true" });
    await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { atEnd: 1 });
    expect(c.appendSheet).not.toHaveBeenCalled();
    expect(c.insertSheetBefore).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(2);
    // `atEnd: false` is the insert before the anchor.
    await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { atEnd: false });
    expect(c.insertSheetBefore).toHaveBeenCalledWith(2);
  });
});

describe("refusals that hold for every sheet command", () => {
  it("while a formula is being written (the strip's structural lock), each is refused with one toast", async () => {
    const c = mount({ ...TWO_SHEETS, locked: true });
    h.prompt.mockResolvedValue("X");
    for (const id of SHEET_COMMANDS) {
      expect(commandRefusalFor(id), id).toMatch(/formula/i);
      toasts.length = 0;
      await CommandRegistry.execute(id, id === CoreCommands.SHEET_TAB_COLOR ? { color: "#FF0000" } : undefined);
      expect(toasts.length, id).toBe(1);
    }
    for (const fn of Object.values(c)) {
      if (typeof fn === "function" && "mock" in fn && fn !== c.snapshot) {
        expect((fn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      }
    }
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("with no tab strip mounted, nothing runs and nothing throws", async () => {
    releaseController();
    expect(getSheetTabsController()).toBeNull();
    for (const id of SHEET_COMMANDS) {
      await expect(CommandRegistry.execute(id)).resolves.toBeUndefined();
    }
    expect(h.prompt).not.toHaveBeenCalled();
  });
});

// A drill-through's TEMPORARY sheet (docs/design/model-drillthrough.md 2.7):
// the runner clears a still-active one through this door before it adds the
// next result sheet. By STABLE id passed STRAIGHT THROUGH -- never an index
// resolved here, which can name another sheet by the time the delete lands
// (review finding discard-stale-index-after-insert-or-copy-move) -- and it
// RESOLVES to whether the sheet is gone (C7): true, or false with exactly one
// toast. An ordinary sheet is refused because the strip's discard never asks.
describe("Discard a temporary sheet (core.sheet.discardEphemeral { sheetId })", () => {
  const WITH_DRILL: SheetTabsSnapshot = {
    sheets: [sheet(0, "Sheet1"), sheet(1, "Data"), sheet(2, "Drillthrough", { ephemeral: true })],
    activeIndex: 2,
    locked: false,
  };

  it("is registered under its one id, and is not script-safe (it removes a sheet)", () => {
    expect(SHEET_DISCARD_EPHEMERAL_COMMAND).toBe("core.sheet.discardEphemeral");
    expect(CommandRegistry.has(SHEET_DISCARD_EPHEMERAL_COMMAND)).toBe(true);
    expect(CommandRegistry.isScriptSafe(SHEET_DISCARD_EPHEMERAL_COMMAND)).toBe(false);
  });

  it("passes the STABLE id straight to the strip's DISCARD (never its delete, never an index) and resolves true", async () => {
    const c = mount(WITH_DRILL);
    await expect(
      CommandRegistry.execute(SHEET_DISCARD_EPHEMERAL_COMMAND, { sheetId: "id-Drillthrough" }),
    ).resolves.toBe(true);
    expect(c.discardSheet).toHaveBeenCalledTimes(1);
    expect(c.discardSheet).toHaveBeenCalledWith("id-Drillthrough");
    expect(c.deleteSheet).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
  });

  it("an id the strip's list does not carry yet (a result sheet added a moment ago) still reaches the strip: the backend decides", async () => {
    const c = mount(WITH_DRILL);
    await CommandRegistry.execute(SHEET_DISCARD_EPHEMERAL_COMMAND, { sheetId: "id-JustLanded" });
    expect(c.discardSheet).toHaveBeenCalledWith("id-JustLanded");
    expect(toasts).toHaveLength(0);
  });

  it("the strip's refusal resolves false and adds no toast of the door's own (the strip told the user)", async () => {
    const c = mount(WITH_DRILL);
    c.discardSheet.mockResolvedValueOnce(false);
    await expect(
      CommandRegistry.execute(SHEET_DISCARD_EPHEMERAL_COMMAND, { sheetId: "id-Drillthrough" }),
    ).resolves.toBe(false);
    expect(toasts).toHaveLength(0);
  });

  it("REFUSES a sheet the strip lists as ordinary with one toast naming it, resolving false", async () => {
    const c = mount(WITH_DRILL);
    await expect(CommandRegistry.execute(SHEET_DISCARD_EPHEMERAL_COMMAND, { sheetId: "id-Data" })).resolves.toBe(false);
    expect(c.discardSheet).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toMatch(/ordinary sheet/);
    expect(toasts[0].message).toMatch(/"Data"/);
  });

  it("refuses a call without a usable { sheetId }, each with one toast, resolving false", async () => {
    const c = mount(WITH_DRILL);
    for (const args of [undefined, {}, { sheetId: "" }, { sheetId: 3 }]) {
      await expect(CommandRegistry.execute(SHEET_DISCARD_EPHEMERAL_COMMAND, args)).resolves.toBe(false);
    }
    expect(c.discardSheet).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(4);
  });

  it("AWAITS the strip: the command resolves only once the discard has (the runner adds its next sheet after)", async () => {
    const c = mount(WITH_DRILL);
    let release: () => void = () => {};
    c.discardSheet.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return true;
    });
    let settled: unknown = "pending";
    const pending = CommandRegistry.execute(SHEET_DISCARD_EPHEMERAL_COMMAND, { sheetId: "id-Drillthrough" }).then((gone) => {
      settled = gone;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(c.discardSheet).toHaveBeenCalledWith("id-Drillthrough");
    expect(settled).toBe("pending");
    release();
    await pending;
    expect(settled).toBe(true);
  });

  it("the structure lock refuses it (it removes a sheet) -- in its OWN handler, so it still resolves false, with one toast", async () => {
    const c = mount({ ...WITH_DRILL, locked: true });
    // Not a registry refusal: that would return before the handler and resolve undefined.
    expect(commandRefusalFor(SHEET_DISCARD_EPHEMERAL_COMMAND)).toBeNull();
    await expect(
      CommandRegistry.execute(SHEET_DISCARD_EPHEMERAL_COMMAND, { sheetId: "id-Drillthrough" }),
    ).resolves.toBe(false);
    expect(c.discardSheet).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toMatch(/formula/i);
  });

  it("with no tab strip mounted, nothing runs, nothing throws, and it resolves false with one toast", async () => {
    releaseController();
    await expect(
      CommandRegistry.execute(SHEET_DISCARD_EPHEMERAL_COMMAND, { sheetId: "id-Drillthrough" }),
    ).resolves.toBe(false);
    expect(toasts).toHaveLength(1);
  });
});

describe("the controller seat", () => {
  it("a stale release does not unseat a newer controller (a remount's cleanup order)", () => {
    const first = fakeController(TWO_SHEETS);
    const second = fakeController(TWO_SHEETS);
    const releaseFirst = registerSheetTabsController(first);
    const releaseSecond = registerSheetTabsController(second);
    releaseFirst();
    expect(getSheetTabsController()).toBe(second);
    releaseSecond();
    expect(getSheetTabsController()).toBeNull();
  });
});

// Review SHEET-COMMAND-NON-OBJECT-ARGS-RETARGET-ACTIVE (round 5): the rule
// "only an ABSENT index means the active sheet" held only when the arguments
// were an object. A bare number, string, array or null was read as "no index",
// so `command core.sheet.hide = 1` hid the ACTIVE sheet instead of sheet 1, and
// `command core.sheet.delete = 2` deleted a blank active sheet without asking.
// ONE guard refuses arguments that are present but not a plain object.
describe("arguments that are present but not a plain object are refused, never read as 'no index'", () => {
  /** Active = 2 ("Summary"), so a fallback to the active sheet is visible. */
  const THREE: SheetTabsSnapshot = {
    sheets: [sheet(0, "Sales"), sheet(1, "Costs"), sheet(2, "Summary")],
    activeIndex: 2,
    locked: false,
  };
  /** Every controller call the fake recorded (the snapshot read excluded). */
  const stripCalls = (c: ReturnType<typeof fakeController>): number =>
    Object.entries(c).reduce(
      (n, [name, fn]) =>
        name !== "snapshot" && typeof fn === "function" && "mock" in fn
          ? n + (fn as ReturnType<typeof vi.fn>).mock.calls.length
          : n,
      0,
    );
  const quoted = (value: unknown): string => (typeof value === "string" ? `"${value}"` : JSON.stringify(value));
  const SHAPES: ReadonlyArray<readonly [string, string]> = [
    [CoreCommands.SHEET_INSERT, '{ "index": 0 }'],
    [CoreCommands.SHEET_DELETE, '{ "index": 0 }'],
    [CoreCommands.SHEET_RENAME, '{ "index": 0 }'],
    [CoreCommands.SHEET_HIDE, '{ "index": 0 }'],
    [CoreCommands.SHEET_TAB_COLOR, '{ "index": 0, "color": "#FF0000" }'],
    [CoreCommands.SHEET_MOVE_OR_COPY, '{ "index": 0, "beforeIndex": 1, "copy": false }'],
  ];

  it.each(SHAPES)(
    "%s given WHOLE arguments 1, \"1\", [1], true or null asks the strip nothing, opens nothing, and names the shape once",
    async (id, shape) => {
      h.prompt.mockResolvedValue("Renamed");
      for (const bad of [1, "1", [1], true, null]) {
        const c = mount(THREE);
        toasts.length = 0;
        await CommandRegistry.execute(id, bad);
        expect(stripCalls(c), `${id} acted for arguments ${JSON.stringify(bad)}`).toBe(0);
        expect(toasts.map((t) => t.message), `${id} arguments ${JSON.stringify(bad)}`).toEqual([
          `${id} takes ${shape} (got ${quoted(bad)}).`,
        ]);
      }
      expect(h.prompt).not.toHaveBeenCalled();
      expect(h.openDialog).not.toHaveBeenCalled();
    },
  );

  it("the finding's own lines: `= 1` hides nothing and `= 2` deletes nothing -- the active sheet least of all", async () => {
    const c = mount(THREE);
    await CommandRegistry.execute(CoreCommands.SHEET_HIDE, 1);
    await CommandRegistry.execute(CoreCommands.SHEET_DELETE, 2);
    await CommandRegistry.execute(CoreCommands.SHEET_INSERT, 0);
    expect(c.hideSheet).not.toHaveBeenCalled();
    expect(c.deleteSheet).not.toHaveBeenCalled();
    expect(c.insertSheetBefore).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(3);
  });

  it("controls: ABSENT arguments and an empty object still act on the ACTIVE sheet, for every index-taking command", async () => {
    h.prompt.mockResolvedValue("Renamed");
    for (const none of [undefined, {}]) {
      const c = mount(THREE);
      toasts.length = 0;
      h.openDialog.mockReset();
      await CommandRegistry.execute(CoreCommands.SHEET_INSERT, none);
      await CommandRegistry.execute(CoreCommands.SHEET_DELETE, none);
      await CommandRegistry.execute(CoreCommands.SHEET_RENAME, none);
      await CommandRegistry.execute(CoreCommands.SHEET_HIDE, none);
      await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, none);
      expect(c.insertSheetBefore.mock.calls, JSON.stringify(none)).toEqual([[2]]);
      expect(c.deleteSheet.mock.calls).toEqual([[2]]);
      expect(c.renameSheet.mock.calls).toEqual([[2, "Renamed", "id-Summary"]]);
      expect(c.hideSheet.mock.calls).toEqual([[2]]);
      expect(h.openDialog).toHaveBeenCalledTimes(1);
      expect((h.openDialog.mock.calls[0][1] as MoveOrCopySheetData).sourceSheetId).toBe("id-Summary");
      expect(toasts).toEqual([]);
    }
    // Tab Color needs its colour; given one, it colours the active sheet.
    const c = mount(THREE);
    await CommandRegistry.execute(CoreCommands.SHEET_TAB_COLOR, { color: "#FF0000" });
    expect(c.setTabColor).toHaveBeenCalledWith(2, "#FF0000");
  });
});
