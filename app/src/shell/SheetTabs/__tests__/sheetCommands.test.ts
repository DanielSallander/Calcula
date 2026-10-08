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
    expect(c.renameSheet).toHaveBeenCalledWith(1, "Totals");
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
    expect(c.renameSheet).toHaveBeenCalledWith(0, "First");
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
    expect(data.sheets).toEqual([
      { index: 0, name: "A" },
      { index: 2, name: "B" },
    ]);
    expect(data.sourceIndex).toBe(2);
    expect(data.sourceName).toBe("B");
    expect(data.canCopy).toBe(true);
  });

  it("the dialog's answer reaches the strip", async () => {
    const c = mount(TWO_SHEETS);
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY);
    const data = h.openDialog.mock.calls[0][1] as MoveOrCopySheetData;
    await data.onResult({ beforeIndex: 0, copy: true });
    expect(c.moveOrCopySheet).toHaveBeenCalledWith(1, 0, true);
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
    expect(c.moveOrCopySheet).toHaveBeenCalledWith(1, null, false);
  });

  it("a copy of a canvas asked for by args is refused", async () => {
    const c = mount({ sheets: [sheet(0, "A"), sheet(1, "Page", { kind: "canvas" })], activeIndex: 1, locked: false });
    await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { beforeIndex: 0, copy: true });
    expect(c.moveOrCopySheet).not.toHaveBeenCalled();
    expect(toasts.length).toBe(1);
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
