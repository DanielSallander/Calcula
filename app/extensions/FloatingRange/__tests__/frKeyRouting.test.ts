//! FILENAME: app/extensions/FloatingRange/__tests__/frKeyRouting.test.ts
// PURPOSE: While a floating range owns the selection on a WORKSHEET, nothing
//          acts on Core's HIDDEN active cell (review 2026-09-27, FR finding 5)
//          -- driven through the REAL keybinding dispatcher, installed before
//          the extension the way the shell does it:
//          - Delete clears the range's cell ONCE and never runs the grid's
//            clear-contents (it used to run both: two cells, two undo steps);
//          - with only the OBJECT selected, Delete asks to delete the object;
//          - the range CLAIMS the selection (@api/selectionOwner, BUG-0185,
//            E7), so every door that writes to Core's selection -- the grid
//            commands' bridge (Copy, Paste, the fills, Merge, from any key a
//            user moved them to: BUG-0199), the grid keyboard's format keys,
//            the ribbon's formatting doors, and since D4 every extension
//            command that acts on the selection -- refuses with the range's
//            sentence, ONCE;
//          - W18 (wave C): so the range refuses no COMMAND of its own any
//            more. Its command-id refusals answered BEFORE those doors, which
//            made them redundant (every door already refuses) and, for
//            AutoFilter, wrong: Ctrl+Shift+L could not turn an existing filter
//            OFF, which the door allows. A key now reaches its command, whose
//            own door decides;
//          - only a key with no command behind it (Data Validation's
//            Alt+Down) is still refused as a combination;
//          - P3 (owner finding G3): the claim now ANSWERS too. A door that
//            supports cell targets (the grid commands' bridge: Copy, Paste,
//            the fills; Delete) acts on the RANGE's cells through
//            `cellTarget` -- never on Core's hidden cell -- while a door with
//            no target support keeps refusing with the range's sentence,
//            which now names "a floating grid";
//          - positive controls: no range selection -> the grid's commands run;
//            focus in a pane button -> the range's binding stands down.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

const FR_ID = "fr-keys";
const HOST = 0;

const INFO = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 0,
  y: 0,
  rotation: 0,
  pinToGrid: false,
  rowCount: 4,
  colCount: 3,
  colWidths: {},
  rowHeights: {},
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float1",
  backingSheetIndex: 1,
  hostSheetIndex: HOST,
} as FloatingRangeInfo;

const updateFloatingRangeCell = vi.fn(async (..._args: unknown[]): Promise<number[]> => []);
vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  FLOATING_RANGE_MIN_COL_W: 8,
  FLOATING_RANGE_MAX_COL_W: 1000,
  FLOATING_RANGE_MIN_ROW_H: 8,
  FLOATING_RANGE_MAX_ROW_H: 500,
  listFloatingRanges: vi.fn(async () => [INFO]),
  createFloatingRange: vi.fn(),
  updateFloatingRange: vi.fn(async () => ({})),
  renameFloatingRange: vi.fn(),
  deleteFloatingRange: vi.fn(async () => {}),
  updateFloatingRangeCell: (...args: unknown[]) => updateFloatingRangeCell(...args),
  // A1 holds a value; everything else is empty.
  getFloatingRangeCells: vi.fn(async () => [
    { row: 0, col: 0, type: "number", value: 5, display: "5", formula: null },
  ]),
}));

const clearRangeWithOptions = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ count: 1, updatedCells: [] }));
vi.mock("@api/lib", () => ({
  getActiveSheet: vi.fn(async () => HOST),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
  clearRangeWithOptions: (...args: unknown[]) => clearRangeWithOptions(...args),
  beginUndoTransaction: vi.fn(async () => null),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
}));

// The CORE grid-command registry the CommandRegistry bridge executes through
// (its handlers receive the door's target as `ctx.target`). Captured from the
// real module rather than imported: an extension test may import only @api.
type CoreGridCommands = {
  register(command: string, handler: (args: unknown, ctx?: { target: unknown }) => void): void;
  unregister(command: string): void;
};
const core = vi.hoisted(() => ({ gridCommands: null as CoreGridCommands | null }));
vi.mock("../../../src/core/lib/gridCommands", async (importOriginal) => {
  const real = await importOriginal<{ gridCommands: CoreGridCommands }>();
  core.gridCommands = real.gridCommands;
  return real;
});
const gridCommands = {
  register: (command: string, handler: (args: unknown, ctx?: { target: unknown }) => void) =>
    core.gridCommands!.register(command, handler),
  unregister: (command: string) => core.gridCommands!.unregister(command),
};

/** The target a write through the range's cells carries. */
const FR_TARGET = { target: { kind: "floatingRange", id: FR_ID } };

const confirmAsync = vi.fn(async (..._args: unknown[]) => false);
vi.mock("@api/dialogs", () => ({
  confirmAsync: (...args: unknown[]) => confirmAsync(...args),
  promptAsync: vi.fn(async () => null),
  alertAsync: vi.fn(async () => {}),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showDialog: vi.fn(),
  showOverlay: vi.fn(),
  ExtensionRegistry: { onSelectionChange: () => () => {} },
}));

import {
  initKeybindings,
  getAllKeybindings,
  setUserKeybinding,
  resetAllKeybindings,
  commandRefusalFor,
} from "@api/keybindings";
import { CommandRegistry } from "@api/commands";

import { onAppEvent } from "@api/events";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import {
  getSelectionOwner,
  isSelectionOwned,
  refuseIfSelectionOwned,
  selectionRefusalFor,
  cellTargetFor,
} from "@api/selectionOwner";
import extension from "../index";
import {
  clearLocalSelection,
  deselectAllFloatingRanges,
  getLocalSelection,
  selectFloatingRange,
  setLocalSelection,
} from "../lib/frSelection";
import { cancelFrEditor, isFrEditorOpen } from "../editor/frEditor";
import { setFrActiveSheetIndex, upsertFromInfo } from "../lib/floatingRangeStore";
import {
  FR_ACTS_ON,
  FR_FILTER_REFUSAL,
  FR_REFUSED_COMBOS,
  FR_SELECTION_OWNER_ID,
  FR_TABLE_REFUSAL,
  FR_WHOLE_OBJECT_REFUSAL,
  frRefusalSlug,
  frSelectionRefusal,
} from "../lib/frKeyRouting";

/**
 * The commands the range used to refuse by command id (E7) -- every one of
 * which refuses ITSELF while an owner claims the selection: the grid commands
 * through the bridge's owner check (core/lib/gridCommands.ts), the rest in
 * their own doors (Format Cells, Format Painter, Paste Special and its quick
 * pastes, and D4's Insert Table, AutoFilter, Group/Ungroup, Hyperlink, Flash
 * Fill, Comment/Note, Bookmark).
 */
const SELF_REFUSING_COMMANDS = [
  "core.clipboard.copy",
  "core.clipboard.cut",
  "core.clipboard.paste",
  "core.clipboard.pasteSpecial",
  "core.clipboard.pasteValues",
  "core.clipboard.pasteFormulas",
  "core.clipboard.pasteFormatting",
  "core.clipboard.pasteLink",
  "core.edit.fillDown",
  "core.edit.fillRight",
  "core.edit.fillUp",
  "core.edit.fillLeft",
  "core.format.cells",
  "core.grid.merge",
  "core.format.painter",
  "insert.table",
  "autofilter.toggle",
  "grouping.group",
  "grouping.ungroup",
  "hyperlinks.insert",
  "flashfill.execute",
  "review.newComment",
  "review.newNote",
  "bookmarks.toggle",
] as const;

// THE SHELL'S ORDER: the dispatcher's window-capture listener is installed at
// bootstrap, before any extension activates -- so it runs FIRST on every key.
initKeybindings();

/** Every toast shown -- the dispatcher's, the selection owner's, the range's own. */
const toasts: ToastPayload[] = [];
registerToastSink((t) => toasts.push(t));
const toastTexts = (): string[] => toasts.map((t) => t.message);

/** The grid's built-in commands, observed (Core's handlers in the app). */
const GRID_COMMANDS = [
  "core.edit.clearContents",
  "core.clipboard.paste",
  "core.clipboard.cut",
  "core.clipboard.copy",
  "core.edit.fillDown",
  "core.edit.fillRight",
] as const;
const ran: string[] = [];

function stubContext(): never {
  return {
    grid: { overlays: { register: () => () => {} } },
    ui: {
      menus: { registerItem: vi.fn(), unregisterItem: vi.fn() },
      overlays: { register: vi.fn(), unregister: vi.fn() },
      dialogs: { register: vi.fn(), unregister: vi.fn() },
    },
    events: { on: (name: string, cb: (detail: unknown) => void) => onAppEvent(name, cb) },
  } as never;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** A real keydown on the focused element: capture runs window-first. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

/** "Ctrl+Shift+$" -> the keydown a user's keyboard produces for it. */
function initFor(combo: string): { key: string; init: KeyboardEventInit } {
  const parts = combo.split("+");
  const key = parts[parts.length - 1] === "" ? "+" : parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  return {
    key,
    init: {
      ctrlKey: mods.includes("ctrl"),
      shiftKey: mods.includes("shift"),
      altKey: mods.includes("alt"),
    },
  };
}

function selectCell(): void {
  setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
}

let container: HTMLDivElement;

beforeEach(async () => {
  ran.length = 0;
  toasts.length = 0;
  updateFloatingRangeCell.mockClear();
  clearRangeWithOptions.mockClear();
  confirmAsync.mockClear();
  resetAllKeybindings();
  for (const id of GRID_COMMANDS) CommandRegistry.register(id, () => void ran.push(id));
  // The grid's focus container, focused -- where a click on a floating cell
  // leaves the keyboard (gridPointerEntry focuses it: no edit is open).
  container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = 0;
  document.body.appendChild(container);
  extension.activate(stubContext());
  await flush();
  container.focus();
});

afterEach(() => {
  extension.deactivate();
  resetAllKeybindings();
  for (const id of GRID_COMMANDS) CommandRegistry.unregister(id);
  container.remove();
});

describe("Delete with a floating range's cell selected", () => {
  it("clears the range's cell ONCE, through its cell target, and never the grid's hidden active cell", async () => {
    selectCell();
    const e = press("Delete");
    await flush();
    expect(ran).not.toContain("core.edit.clearContents");
    // P3: ONE clear of the selection with the target (one undo step), never
    // a write per cell.
    expect(clearRangeWithOptions).toHaveBeenCalledTimes(1);
    expect(clearRangeWithOptions).toHaveBeenCalledWith(0, 0, 0, 0, "contents", undefined, FR_TARGET);
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("Backspace is the range's too", async () => {
    selectCell();
    press("Backspace");
    await flush();
    expect(clearRangeWithOptions).toHaveBeenCalledTimes(1);
  });

  it("with only the OBJECT selected, asks to delete the object -- the grid clears nothing", async () => {
    selectFloatingRange(FR_ID);
    clearLocalSelection();
    press("Delete");
    await flush();
    expect(ran).not.toContain("core.edit.clearContents");
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(String(confirmAsync.mock.calls[0][0])).toMatch(/Delete floating range "Float1"/);
  });

  it("positive control: with no range selection the grid's clear-contents runs", async () => {
    press("Delete");
    await flush();
    expect(ran).toEqual(["core.edit.clearContents"]);
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(clearRangeWithOptions).not.toHaveBeenCalled();
  });

  it("with the keyboard in a pane's button, the range's binding stands down", async () => {
    selectCell();
    const paneButton = document.createElement("button");
    document.body.appendChild(paneButton);
    try {
      paneButton.focus();
      press("Delete");
      await flush();
      expect(updateFloatingRangeCell).not.toHaveBeenCalled();
      expect(ran).not.toContain("core.edit.clearContents");
    } finally {
      paneButton.remove();
    }
  });
});

describe("clipboard and fill keys with a floating range's cell selected (P3: they ACT on the range's cells)", () => {
  // Through the REAL grid-command bridge (CommandRegistry -> gridCommands),
  // as in the app: the stand-in handler is taken away, so the bridge's door
  // (`resolveCellTarget`) decides. The range admits these kinds of act, so
  // the grid command's handler runs with the RANGE's cells as its target --
  // never Core's hidden cell -- and nobody is refused.
  const cases: [string, KeyboardEventInit, string, string][] = [
    ["v", { ctrlKey: true }, "core.clipboard.paste", "paste"],
    ["x", { ctrlKey: true }, "core.clipboard.cut", "cut"],
    ["c", { ctrlKey: true }, "core.clipboard.copy", "copy"],
    ["d", { ctrlKey: true }, "core.edit.fillDown", "fillDown"],
    ["r", { ctrlKey: true }, "core.edit.fillRight", "fillRight"],
  ];
  for (const [key, init, coreCommand, gridCommand] of cases) {
    it(`Ctrl+${key.toUpperCase()} runs the grid command ${gridCommand} ONCE on the range's cells, never ${coreCommand} over the hidden cell`, async () => {
      CommandRegistry.unregister(coreCommand);
      const seen: unknown[] = [];
      gridCommands.register(gridCommand as never, (_args, ctx) => void seen.push(ctx?.target));
      try {
        selectCell();
        press(key, init);
        await flush();
        expect(ran).not.toContain(coreCommand);
        expect(toasts).toEqual([]);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          kind: "object",
          ref: { kind: "floatingRange", id: FR_ID },
          label: "Float1",
          wholeObject: false,
          selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, activeRow: 0, activeCol: 0 },
        });
      } finally {
        gridCommands.unregister(gridCommand as never);
      }
    });
  }

  it("positive control: with no range selection Ctrl+V pastes into the grid", async () => {
    press("v", { ctrlKey: true });
    await flush();
    expect(ran).toEqual(["core.clipboard.paste"]);
    expect(toasts).toEqual([]);
  });
});

describe("a REMAPPED command is refused on its new key (BUG-0199, E7)", () => {
  it("Copy moved to Ctrl+Shift+Q: the new key copies the RANGE's cells, never the hidden cell", async () => {
    expect(setUserKeybinding("core.copy", "Ctrl+Shift+Q")).toBeNull();
    // The real bridge (see above): its door answers whatever key ran it.
    CommandRegistry.unregister("core.clipboard.copy");
    const seen: unknown[] = [];
    gridCommands.register("copy", (_args, ctx) => void seen.push(ctx?.target));
    try {
      selectCell();
      const e = press("Q", { ctrlKey: true, shiftKey: true });
      await flush();
      expect(ran, "the remapped Copy copied Core's hidden cell").not.toContain("core.clipboard.copy");
      expect(toasts).toEqual([]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: "object", ref: { kind: "floatingRange", id: FR_ID } });
      expect(e.defaultPrevented).toBe(true);
    } finally {
      gridCommands.unregister("copy");
    }
  });

  it("the OLD key is no longer Copy: pressing it refuses nothing and copies nothing", async () => {
    setUserKeybinding("core.copy", "Ctrl+Shift+Q");
    selectCell();
    press("c", { ctrlKey: true });
    await flush();
    expect(toasts).toEqual([]);
    expect(ran).not.toContain("core.clipboard.copy");
  });

  it("a remapped extension command (Insert Table on Ctrl+Alt+J) reaches its command on the new key, whose OWN door refuses (W18)", async () => {
    setUserKeybinding("core.insertTable", "Ctrl+Alt+J");
    // The door as StandardMenus/selectionDoors.ts has it since D4: ask the owner first.
    const insertTable = vi.fn(() => {
      if (refuseIfSelectionOwned("Insert Table")) return;
      ran.push("insert.table:opened");
    });
    CommandRegistry.register("insert.table", insertTable);
    try {
      selectCell();
      press("j", { ctrlKey: true, altKey: true });
      await flush();
      expect(insertTable, "the range pre-empted the command").toHaveBeenCalledTimes(1);
      expect(ran).not.toContain("insert.table:opened");
      expect(toastTexts()).toEqual([frSelectionRefusal("Insert Table")]);
    } finally {
      CommandRegistry.unregister("insert.table");
    }
  });

  it("positive control: with no range selection the remapped Copy copies", async () => {
    setUserKeybinding("core.copy", "Ctrl+Shift+Q");
    press("Q", { ctrlKey: true, shiftKey: true });
    await flush();
    expect(ran).toEqual(["core.clipboard.copy"]);
    expect(toasts).toEqual([]);
  });
});

describe("the range CLAIMS the selection (@api/selectionOwner, BUG-0185, E7)", () => {
  it("claims while a cell of it is selected, and while only the object is -- never with nothing selected", () => {
    deselectAllFloatingRanges();
    clearLocalSelection();
    expect(isSelectionOwned()).toBe(false);
    expect(refuseIfSelectionOwned("Bold")).toBe(false);
    expect(toasts).toEqual([]);

    selectCell();
    expect(getSelectionOwner()?.id).toBe(FR_SELECTION_OWNER_ID);
    expect(refuseIfSelectionOwned("Bold")).toBe(true);
    expect(toastTexts()).toEqual([frSelectionRefusal("Bold")]);

    clearLocalSelection();
    selectFloatingRange(FR_ID);
    expect(isSelectionOwned()).toBe(true);
  });

  it("does not claim for a range on ANOTHER sheet than the one shown", () => {
    selectCell();
    setFrActiveSheetIndex(HOST + 3);
    try {
      expect(isSelectionOwned()).toBe(false);
    } finally {
      setFrActiveSheetIndex(HOST);
    }
  });

  it("the grid keyboard's format keys are the claim's, not a combination's: Ctrl+B reaches the grid keyboard, which the claim refuses", async () => {
    const gridKeyboard = vi.fn();
    container.addEventListener("keydown", gridKeyboard as unknown as EventListener);
    try {
      selectCell();
      const e = press("b", { ctrlKey: true });
      await flush();
      // No binding took the key (the old per-combination refusal is retired):
      // Core's grid keyboard hears it, and asks the owner before it writes.
      expect(gridKeyboard).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented).toBe(false);
      expect(selectionRefusalFor("Bold")).toBe(frSelectionRefusal("Bold"));
    } finally {
      container.removeEventListener("keydown", gridKeyboard as unknown as EventListener);
    }
  });

  it("is withdrawn with the extension", async () => {
    extension.deactivate();
    // The range and its cell are back in the stores, but no owner is left to claim.
    upsertFromInfo(INFO);
    setFrActiveSheetIndex(HOST);
    selectCell();
    expect(isSelectionOwned()).toBe(false);
    clearLocalSelection();
    extension.activate(stubContext());
    await flush();
  });
});

describe("W18: the range refuses no command whose own door refuses", () => {
  /** An extension's OWN window-capture listener, installed after the dispatcher (as every extension's is). */
  let lateCapture: ReturnType<typeof vi.fn>;
  /** Core's grid keyboard stand-in: a listener on the focused container. */
  let gridKeyboard: ReturnType<typeof vi.fn>;
  /** The commands, observed: each stand-in is a door that asks the owner first. */
  const reached: string[] = [];
  /** The grid's canvas layer: the range's cell editor mounts in it, so F2 CAN open one here. */
  let layer: HTMLDivElement;
  beforeEach(() => {
    reached.length = 0;
    lateCapture = vi.fn();
    gridKeyboard = vi.fn();
    layer = document.createElement("div");
    layer.setAttribute("data-grid-canvas-layer", "");
    document.body.appendChild(layer);
    window.addEventListener("keydown", lateCapture as unknown as EventListener, true);
    container.addEventListener("keydown", gridKeyboard as unknown as EventListener);
    for (const id of SELF_REFUSING_COMMANDS) {
      CommandRegistry.register(id, () => {
        reached.push(id);
        refuseIfSelectionOwned(id);
      });
    }
  });
  afterEach(() => {
    if (isFrEditorOpen()) cancelFrEditor();
    layer.remove();
    window.removeEventListener("keydown", lateCapture as unknown as EventListener, true);
    container.removeEventListener("keydown", gridKeyboard as unknown as EventListener);
    for (const id of SELF_REFUSING_COMMANDS) CommandRegistry.unregister(id);
    // The grid stand-ins the file-level beforeEach registers, back for afterEach.
    for (const id of GRID_COMMANDS) CommandRegistry.register(id, () => void ran.push(id));
  });

  /** A cell with a neighbour on every side, so a stray move or extend would show. */
  function selectMiddleCell(): void {
    setLocalSelection({ frId: FR_ID, anchorRow: 1, anchorCol: 1, endRow: 1, endCol: 1 });
  }

  it("no command-id refusal is registered for any of them while a cell is selected", () => {
    selectCell();
    for (const id of SELF_REFUSING_COMMANDS) {
      expect(commandRefusalFor(id), `${id} is still refused by the range`).toBeNull();
    }
  });

  it("the refused combinations are unique; only Data Validation's Alt+Down is one (no command stands behind it)", () => {
    const slugs = FR_REFUSED_COMBOS.map((k) => frRefusalSlug(k));
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(FR_REFUSED_COMBOS.map((k) => k.combo)).toEqual(["Alt+ArrowDown"]);
  });

  const bound = getAllKeybindings().filter(
    (b) => b.source === "built-in" && (SELF_REFUSING_COMMANDS as readonly string[]).includes(b.commandId),
  );

  it("every built-in key of those commands is covered (the list is not empty)", () => {
    expect(bound.length).toBeGreaterThanOrEqual(18);
  });

  for (const binding of bound) {
    it(`${binding.combo} reaches ${binding.commandId} ONCE, whose door refuses with ONE sentence -- neither the grid keyboard nor the range's own keyboard acts on it`, async () => {
      selectMiddleCell();
      const before = getLocalSelection();
      const { key, init } = initFor(binding.combo);
      const e = press(key, init);
      await flush();
      expect(reached, `${binding.combo}: the range pre-empted the command`).toEqual([binding.commandId]);
      expect(toastTexts()).toEqual([frSelectionRefusal(binding.commandId)]);
      expect(gridKeyboard, `${binding.combo}: the grid keyboard still acted`).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(true);
      // Review C: the dispatcher's own stopPropagation cannot silence another
      // listener on window's capture phase -- the range's keyboard heard
      // Alt+Shift+Right (Group) as Shift+Right and extended its selection,
      // Alt+Shift+Left as Shift+Left, and Shift+F2 (New Note) as F2 and opened
      // its cell editor, after the toast had said nothing was changed.
      expect(getLocalSelection(), `${binding.combo}: the refused key ALSO moved the range's selection`).toEqual(before);
      expect(isFrEditorOpen(), `${binding.combo}: the refused key ALSO opened the range's cell editor`).toBe(false);
    });
  }

  it("positive control: the keys NO binding takes are still the range's own (Shift+Right extends, F2 opens its editor)", async () => {
    selectMiddleCell();
    press("ArrowRight", { shiftKey: true });
    await flush();
    expect(getLocalSelection()).toMatchObject({ anchorRow: 1, anchorCol: 1, endRow: 1, endCol: 2 });
    press("F2");
    await flush();
    expect(isFrEditorOpen()).toBe(true);
    expect(toasts).toEqual([]);
    expect(reached).toEqual([]);
  });

  it("Ctrl+Shift+L with a filter already on reaches AutoFilter, whose door lets a filter be turned OFF (the range refused it)", async () => {
    CommandRegistry.register("autofilter.toggle", () => void reached.push("autofilter.toggle:removed"));
    selectCell();
    press("L", { ctrlKey: true, shiftKey: true });
    await flush();
    expect(reached).toEqual(["autofilter.toggle:removed"]);
    expect(toasts).toEqual([]);
  });

  it("Alt+Down (Pick From List) is still refused as a combination, and no other listener hears it", async () => {
    selectCell();
    const e = press("ArrowDown", { altKey: true });
    await flush();
    expect(toastTexts()).toEqual([frSelectionRefusal("Pick From List")]);
    expect(lateCapture).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("positive control: with no range selection the same keys reach their commands, and nothing refuses", async () => {
    press("k", { ctrlKey: true });
    press("v", { ctrlKey: true });
    await flush();
    expect(reached).toEqual(["hyperlinks.insert", "core.clipboard.paste"]);
    expect(toasts).toEqual([]);
  });
});

describe("an AltGr character (sv-SE) and the range's claim (W17, review C)", () => {
  // Typing wins only where a CELL would receive the character. The range's
  // own type-to-edit takes it for a selected CELL (the claim says so:
  // receivesTyping); with only the OBJECT selected nothing of the range takes
  // typing and Core's hidden cell must not, so the keystroke stays the
  // shortcut it collides with.
  const ALTGR_9 = { key: "]", code: "Digit9", ctrlKey: true, altKey: true } as const;
  const ran: string[] = [];
  let layer: HTMLDivElement;
  beforeEach(() => {
    ran.length = 0;
    CommandRegistry.register("bookmarks.next", () => void ran.push("bookmarks.next"));
    layer = document.createElement("div");
    layer.setAttribute("data-grid-canvas-layer", "");
    document.body.appendChild(layer);
  });
  afterEach(() => {
    if (isFrEditorOpen()) cancelFrEditor();
    layer.remove();
    CommandRegistry.unregister("bookmarks.next");
  });

  it("a CELL selected: AltGr+9 types ']' into the range's cell -- its editor opens seeded with it, no bookmark jump", async () => {
    selectCell();
    const e = press(ALTGR_9.key, ALTGR_9);
    await flush();
    expect(ran, "the dispatcher read the typed ']' as Next Bookmark").toEqual([]);
    expect(isFrEditorOpen()).toBe(true);
    expect(layer.querySelector("textarea")?.value).toBe("]");
    expect(e.defaultPrevented).toBe(true);
  });

  it("only the OBJECT selected: AltGr+9 is Next Bookmark -- no cell of the range takes it, and Core's hidden one must not", async () => {
    selectFloatingRange(FR_ID);
    clearLocalSelection();
    expect(isSelectionOwned()).toBe(true);
    const e = press(ALTGR_9.key, ALTGR_9);
    await flush();
    expect(ran).toEqual(["bookmarks.next"]);
    expect(isFrEditorOpen()).toBe(false);
    // Taken by the dispatcher: Core's container (type-to-edit) never hears it.
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("the keyboard on a ribbon tab's or a pane's BUTTON (review 2026-09-28)", () => {
  let lateCapture: ReturnType<typeof vi.fn>;
  let button: HTMLButtonElement;
  const reached: string[] = [];
  const DOORS = ["insert.table", "autofilter.toggle", "flashfill.execute", "hyperlinks.insert", "bookmarks.toggle", "review.newComment", "review.newNote", "core.format.painter", "grouping.group", "grouping.ungroup"];
  let layer: HTMLDivElement;
  beforeEach(() => {
    reached.length = 0;
    lateCapture = vi.fn();
    window.addEventListener("keydown", lateCapture as unknown as EventListener, true);
    layer = document.createElement("div");
    layer.setAttribute("data-grid-canvas-layer", "");
    document.body.appendChild(layer);
    button = document.createElement("button");
    button.textContent = "Review";
    document.body.appendChild(button);
    button.focus();
    for (const id of DOORS) {
      CommandRegistry.register(id, () => {
        reached.push(id);
        refuseIfSelectionOwned(id);
      });
    }
  });
  afterEach(() => {
    if (isFrEditorOpen()) cancelFrEditor();
    window.removeEventListener("keydown", lateCapture as unknown as EventListener, true);
    button.remove();
    layer.remove();
    for (const id of DOORS) CommandRegistry.unregister(id);
  });

  const cases: [string, string][] = [
    ["Ctrl+T", "insert.table"],
    ["Ctrl+Shift+L", "autofilter.toggle"],
    ["Ctrl+E", "flashfill.execute"],
    ["Ctrl+K", "hyperlinks.insert"],
    ["Ctrl+Shift+B", "bookmarks.toggle"],
    ["Ctrl+Alt+M", "review.newComment"],
    ["Shift+F2", "review.newNote"],
    ["Ctrl+Shift+C", "core.format.painter"],
    ["Alt+Shift+ArrowRight", "grouping.group"],
    ["Alt+Shift+ArrowLeft", "grouping.ungroup"],
  ];
  for (const [combo, commandId] of cases) {
    it(`${combo} (a command that asks no focus) reaches ${commandId} with the button focused; its door refuses once, and the range's keyboard does not act on it too`, async () => {
      setLocalSelection({ frId: FR_ID, anchorRow: 1, anchorCol: 1, endRow: 1, endCol: 1 });
      const before = getLocalSelection();
      expect(document.activeElement).toBe(button);
      const { key, init } = initFor(combo);
      const e = press(key, init);
      await flush();
      expect(reached, combo).toEqual([commandId]);
      expect(toastTexts(), combo).toEqual([frSelectionRefusal(commandId)]);
      expect(e.defaultPrevented).toBe(true);
      expect(getLocalSelection(), `${combo}: the refused key ALSO moved the range's selection`).toEqual(before);
      expect(isFrEditorOpen(), `${combo}: the refused key ALSO opened the range's cell editor`).toBe(false);
    });
  }

  it("a GRID-scoped command stands down off the grid: no refusal, and the key keeps its meaning there", async () => {
    selectCell();
    for (const combo of ["Ctrl+C", "Ctrl+X", "Ctrl+V", "Ctrl+D", "Ctrl+R", "Ctrl+1", "Ctrl+M"]) {
      lateCapture.mockClear();
      const { key, init } = initFor(combo);
      const e = press(key, init);
      await flush();
      expect(lateCapture, combo).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented, combo).toBe(false);
    }
    expect(toasts).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("a text field never sees a refusal (the dispatcher's not-editing rule)", async () => {
    selectCell();
    const field = document.createElement("input");
    document.body.appendChild(field);
    try {
      field.focus();
      press("k", { ctrlKey: true });
      await flush();
      expect(toasts).toEqual([]);
      expect(reached).toEqual([]);
      expect(lateCapture).toHaveBeenCalledTimes(1);
    } finally {
      field.remove();
    }
  });
});

describe("Delete and Backspace WITH A MODIFIER (review 2026-09-28)", () => {
  // The range binds the bare keys only, and the dispatcher matches modifiers
  // exactly, so Ctrl+Backspace, Shift+Delete, ... reached the grid keyboard --
  // whose delete branch took ANY modifier and cleared Core's HIDDEN cell.
  // Core's branch now takes the bare keys only (gridKeyboardModifiedDelete);
  // the range does not rely on that: none of them reaches the grid while the
  // range owns its keys. The stand-in below is the grid keyboard as it was --
  // a listener on the focused container that clears on any Delete/Backspace.
  let gridKeyboardClears: string[];
  const gridKeyboard = (e: KeyboardEvent): void => {
    if (e.key === "Delete" || e.key === "Backspace") gridKeyboardClears.push(e.key);
  };
  beforeEach(() => {
    gridKeyboardClears = [];
    container.addEventListener("keydown", gridKeyboard);
  });
  afterEach(() => {
    container.removeEventListener("keydown", gridKeyboard);
  });

  const MODIFIED: [string, KeyboardEventInit][] = [
    ["Backspace", { ctrlKey: true }],
    ["Backspace", { shiftKey: true }],
    ["Backspace", { altKey: true }],
    ["Delete", { ctrlKey: true }],
    ["Delete", { shiftKey: true }],
    ["Delete", { metaKey: true }],
  ];
  for (const [key, init] of MODIFIED) {
    const mods = Object.keys(init).map((m) => m.replace("Key", "")).join("+");
    it(`${mods}+${key} with the range's cell selected reaches neither the grid nor the range's cell`, async () => {
      selectCell();
      const e = press(key, init);
      await flush();
      expect(gridKeyboardClears, `${mods}+${key} reached the grid keyboard (Core's hidden cell)`).toEqual([]);
      expect(ran).not.toContain("core.edit.clearContents");
      expect(updateFloatingRangeCell).not.toHaveBeenCalled();
      expect(toasts).toEqual([]);
      expect(e.defaultPrevented).toBe(true);
    });
  }

  it("with only the OBJECT selected, Ctrl+Backspace reaches no grid and deletes no object", async () => {
    selectFloatingRange(FR_ID);
    clearLocalSelection();
    press("Backspace", { ctrlKey: true });
    await flush();
    expect(gridKeyboardClears).toEqual([]);
    expect(confirmAsync).not.toHaveBeenCalled();
  });

  it("positive control: with no range selection a modified Delete reaches the grid keyboard", async () => {
    press("Delete", { shiftKey: true });
    press("Backspace", { ctrlKey: true });
    await flush();
    expect(gridKeyboardClears).toEqual(["Delete", "Backspace"]);
  });

  it("positive control: the bare keys are still the range's", async () => {
    selectCell();
    press("Backspace");
    await flush();
    expect(clearRangeWithOptions).toHaveBeenCalledTimes(1);
    expect(gridKeyboardClears).toEqual([]);
  });
});

describe("the claim ANSWERS with the range's cells (P3, owner finding G3)", () => {
  it("a selected CELL range answers its cells: the ref, the extent, the name, the ACTIVE cell", () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 2, anchorCol: 1, endRow: 0, endCol: 2 });
    const t = cellTargetFor("format");
    expect(t).toMatchObject({
      kind: "object",
      ownerId: FR_SELECTION_OWNER_ID,
      ref: { kind: "floatingRange", id: FR_ID },
      bounds: { rows: 4, cols: 3 },
      label: "Float1",
      wholeObject: false,
      selection: { startRow: 0, startCol: 1, endRow: 2, endCol: 2, activeRow: 2, activeCol: 1 },
    });
  });

  it("the OBJECT selected answers the whole window, active A1 -- admitted for formatting, refused for acts that need cells", () => {
    clearLocalSelection();
    selectFloatingRange(FR_ID);
    expect(cellTargetFor("format")).toMatchObject({
      kind: "object",
      wholeObject: true,
      selection: { startRow: 0, startCol: 0, endRow: 3, endCol: 2, activeRow: 0, activeCol: 0 },
    });
    expect(cellTargetFor("sort", "Sort")).toEqual({ refusal: FR_WHOLE_OBJECT_REFUSAL });
  });

  it("a range on ANOTHER sheet than the one shown answers nothing: the grid's own selection is the target", () => {
    selectCell();
    setFrActiveSheetIndex(HOST + 3);
    try {
      expect(cellTargetFor("format")).toMatchObject({ kind: "grid" });
    } finally {
      setFrActiveSheetIndex(HOST);
    }
  });

  it("admits every Home kind of act but Format as Table, Filter and the shifting Insert/Delete Cells", () => {
    expect([...FR_ACTS_ON].sort()).toEqual(
      ["clear", "conditionalFormat", "content", "format", "lineSize", "merge", "numberFormat", "read", "sort", "structure"],
    );
    selectCell();
    expect(cellTargetFor("table", "Format as Table")).toEqual({ refusal: FR_TABLE_REFUSAL });
    expect(cellTargetFor("filter", "Filter")).toEqual({ refusal: FR_FILTER_REFUSAL });
    expect(cellTargetFor("shiftCells", "Insert Cells")).toEqual({
      refusal: "Insert Cells is not available inside a floating grid yet. Nothing was changed.",
    });
  });

  it("the refusal of a door with no target support names the floating grid", () => {
    expect(frSelectionRefusal("Insert Table")).toBe(
      "Insert Table is not available inside a floating grid yet. Nothing was changed.",
    );
  });
});
