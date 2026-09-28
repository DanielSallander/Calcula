//! FILENAME: app/extensions/FloatingRange/__tests__/frKeyRouting.test.ts
// PURPOSE: While a floating range owns the selection on a WORKSHEET, the
//          grid's selection-acting keys never act on Core's HIDDEN active cell
//          (review 2026-09-27, FR finding 5) -- driven through the REAL
//          keybinding dispatcher, installed before the extension the way the
//          shell does it:
//          - Delete clears the range's cell ONCE and never runs the grid's
//            clear-contents (it used to run both: two cells, two undo steps);
//          - with only the OBJECT selected, Delete asks to delete the object;
//          - Ctrl+V / Ctrl+X / Ctrl+C / Ctrl+D / Ctrl+R are refused with a
//            sentence, never pasted/cut/copied/filled over the hidden cell;
//          - positive controls: no range selection -> the grid's commands run;
//            focus in a pane button -> the range's binding stands down;
//          - the grid commands' other doors (ribbon, menus) are guarded.

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

const h = vi.hoisted(() => ({
  guards: [] as { commands: string[]; guard: (sel: unknown) => boolean | string }[],
}));

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

vi.mock("@api/lib", () => ({
  getActiveSheet: vi.fn(async () => HOST),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
}));

const confirmAsync = vi.fn(async (..._args: unknown[]) => false);
vi.mock("@api/dialogs", () => ({
  confirmAsync: (...args: unknown[]) => confirmAsync(...args),
  promptAsync: vi.fn(async () => null),
  alertAsync: vi.fn(async () => {}),
}));

const showToast = vi.fn();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showToast: (...args: unknown[]) => showToast(...args),
  showDialog: vi.fn(),
  showOverlay: vi.fn(),
  ExtensionRegistry: { onSelectionChange: () => () => {} },
}));

import { initKeybindings } from "@api/keybindings";
import { CommandRegistry } from "@api/commands";
import { registerGridCommandsService } from "@api/extensions";
import { onAppEvent } from "@api/events";
import extension from "../index";
import {
  clearLocalSelection,
  deselectAllFloatingRanges,
  selectFloatingRange,
  setLocalSelection,
} from "../lib/frSelection";
import { FR_GRID_COMMAND_REFUSAL, FR_REFUSED_GRID_KEYS, frRefusalSlug } from "../lib/frKeyRouting";
import { GRID_COMMANDS as CORE_GRID_COMMAND_NAMES } from "@api/extensions";

// THE SHELL'S ORDER: the dispatcher's window-capture listener is installed at
// bootstrap, before any extension activates -- so it runs FIRST on every key.
initKeybindings();

// Core's grid-command registry, as far as the guard needs it.
registerGridCommandsService({
  register: () => {},
  execute: async () => false,
  hasHandler: () => false,
  registerGuard: (commands, guard) => {
    const entry = { commands: [...commands] as string[], guard: guard as (sel: unknown) => boolean | string };
    h.guards.push(entry);
    return () => {
      const i = h.guards.indexOf(entry);
      if (i >= 0) h.guards.splice(i, 1);
    };
  },
});

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

let container: HTMLDivElement;

beforeEach(async () => {
  ran.length = 0;
  updateFloatingRangeCell.mockClear();
  confirmAsync.mockClear();
  showToast.mockClear();
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
  for (const id of GRID_COMMANDS) CommandRegistry.unregister(id);
  container.remove();
});

describe("Delete with a floating range's cell selected", () => {
  it("clears the range's cell ONCE and never the grid's hidden active cell", async () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    const e = press("Delete");
    await flush();
    expect(ran).not.toContain("core.edit.clearContents");
    expect(updateFloatingRangeCell).toHaveBeenCalledTimes(1);
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 0, 0, "");
    expect(e.defaultPrevented).toBe(true);
  });

  it("Backspace is the range's too", async () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    press("Backspace");
    await flush();
    expect(updateFloatingRangeCell).toHaveBeenCalledTimes(1);
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
  });

  it("with the keyboard in a pane's button, the range's binding stands down", async () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
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

describe("clipboard and fill keys with a floating range's cell selected", () => {
  const cases: [string, KeyboardEventInit, string][] = [
    ["v", { ctrlKey: true }, "core.clipboard.paste"],
    ["x", { ctrlKey: true }, "core.clipboard.cut"],
    ["c", { ctrlKey: true }, "core.clipboard.copy"],
    ["d", { ctrlKey: true }, "core.edit.fillDown"],
    ["r", { ctrlKey: true }, "core.edit.fillRight"],
  ];
  for (const [key, init, gridCommand] of cases) {
    it(`Ctrl+${key.toUpperCase()} is refused with a sentence, never ${gridCommand} over the hidden cell`, async () => {
      setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
      press(key, init);
      await flush();
      expect(ran).not.toContain(gridCommand);
      expect(showToast).toHaveBeenCalledTimes(1);
      expect(String(showToast.mock.calls[0][0])).toMatch(/floating range's cells/);
    });
  }

  it("positive control: with no range selection Ctrl+V pastes into the grid", async () => {
    press("v", { ctrlKey: true });
    await flush();
    expect(ran).toEqual(["core.clipboard.paste"]);
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("the grid commands' other doors (ribbon, menus)", () => {
  function guardFor(command: string): (sel: unknown) => boolean | string {
    const entry = h.guards.find((g) => g.commands.includes(command));
    if (!entry) throw new Error(`no guard for ${command}`);
    return entry.guard;
  }

  it("refuse while a range's cell or the range is selected, and allow otherwise", () => {
    for (const command of ["paste", "cut", "copy", "clearContents", "insertRow", "deleteColumn"]) {
      deselectAllFloatingRanges();
      clearLocalSelection();
      expect(guardFor(command)(null), command).toBe(true);
      setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
      expect(guardFor(command)(null), command).toBe(FR_GRID_COMMAND_REFUSAL);
      clearLocalSelection();
      selectFloatingRange(FR_ID);
      expect(guardFor(command)(null), command).toBe(FR_GRID_COMMAND_REFUSAL);
    }
  });

  it("is withdrawn with the extension", () => {
    extension.deactivate();
    expect(h.guards.length).toBe(0);
    extension.activate(stubContext());
  });
});

/** "Ctrl+Shift+$" -> the keydown a user's keyboard produces for it. */
function initFor(combo: string): { key: string; init: KeyboardEventInit } {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
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

describe("every OTHER key that acts on Core's selection (audit 2026-09-28)", () => {
  /** An extension's OWN window-capture listener, installed after the dispatcher (as every extension's is). */
  let lateCapture: ReturnType<typeof vi.fn>;
  /** Core's grid keyboard stand-in: a listener on the focused container. */
  let gridKeyboard: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    lateCapture = vi.fn();
    gridKeyboard = vi.fn();
    window.addEventListener("keydown", lateCapture as unknown as EventListener, true);
    container.addEventListener("keydown", gridKeyboard as unknown as EventListener);
  });
  afterEach(() => {
    window.removeEventListener("keydown", lateCapture as unknown as EventListener, true);
    container.removeEventListener("keydown", gridKeyboard as unknown as EventListener);
  });

  it("the refused keys have unique binding ids", () => {
    const slugs = FR_REFUSED_GRID_KEYS.map((k) => frRefusalSlug(k));
    expect(new Set(slugs).size).toBe(slugs.length);
    const combos = FR_REFUSED_GRID_KEYS.map((k) => k.combo.toLowerCase());
    expect(new Set(combos).size).toBe(combos.length);
  });

  const NEW_KEYS = [
    "Ctrl+K", "Ctrl+T", "Ctrl+E", "Ctrl+Shift+L", "Ctrl+Shift+B", "Alt+Shift+ArrowRight", "Alt+Shift+ArrowLeft",
    "Ctrl+Alt+M", "Shift+F2", "Alt+ArrowDown", "Ctrl+B", "Ctrl+I", "Ctrl+U", "Ctrl+2", "Ctrl+5", "Ctrl+;",
    "Ctrl+Shift+:", "Ctrl+Shift+$", "Ctrl+Shift+%", "Ctrl+Shift+#", "Ctrl+Alt+V", "F11", "Ctrl+Shift+C",
  ];
  for (const combo of NEW_KEYS) {
    it(`${combo} is refused with the sentence, and neither an extension's own listener nor the grid keyboard hears it`, async () => {
      expect(FR_REFUSED_GRID_KEYS.some((k) => k.combo === combo), `${combo} is not in the refused list`).toBe(true);
      setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
      const { key, init } = initFor(combo);
      const e = press(key, init);
      await flush();
      expect(showToast).toHaveBeenCalledTimes(1);
      expect(String(showToast.mock.calls[0][0])).toMatch(/floating range's cells/);
      expect(lateCapture, `${combo}: a same-phase window listener still acted`).not.toHaveBeenCalled();
      expect(gridKeyboard, `${combo}: the grid keyboard still acted`).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(true);
    });
  }

  it("positive control: with no range selection Ctrl+K and Ctrl+B reach their own handlers", async () => {
    press("k", { ctrlKey: true });
    press("b", { ctrlKey: true });
    await flush();
    expect(showToast).not.toHaveBeenCalled();
    expect(lateCapture).toHaveBeenCalledTimes(2);
    expect(gridKeyboard).toHaveBeenCalledTimes(1); // Ctrl+B: no built-in binding stops it
  });
});

describe("the grid commands' other doors cover EVERY grid command (derived from Core)", () => {
  it("fill, merge, clear-formatting, clear-all and the rest are all refused while the range owns the selection", () => {
    const guarded = new Set(h.guards.flatMap((g) => g.commands));
    for (const command of CORE_GRID_COMMAND_NAMES) {
      expect(guarded.has(command), `${command} is not guarded`).toBe(true);
      const entry = h.guards.find((g) => g.commands.includes(command))!;
      deselectAllFloatingRanges();
      clearLocalSelection();
      expect(entry.guard(null), command).toBe(true);
      setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
      expect(entry.guard(null), command).toBe(FR_GRID_COMMAND_REFUSAL);
    }
  });
});

describe("the keyboard on a ribbon tab's or a pane's BUTTON (review 2026-09-28)", () => {
  // Click a floating range's cell, then a ribbon tab: the tab's <button> has
  // the keyboard and the range keeps its selection. Most refused keys are
  // acted on by something that never asks where the focus is -- a
  // context-"always" registry built-in (Ctrl+T ran insert.table) or an
  // extension's own window listener (Review's Ctrl+Alt+M wrote a comment into
  // Core's HIDDEN cell). The refusal used to stand down off the grid, so
  // those actions ran on the cell the user cannot see.
  /** An extension's own window-capture listener with no focus check (Review, Flash Fill, Grouping, ...). */
  let lateCapture: ReturnType<typeof vi.fn>;
  let button: HTMLButtonElement;
  let execute: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    lateCapture = vi.fn();
    window.addEventListener("keydown", lateCapture as unknown as EventListener, true);
    button = document.createElement("button");
    button.textContent = "Review";
    document.body.appendChild(button);
    button.focus();
    execute = vi.spyOn(CommandRegistry, "execute");
  });
  afterEach(() => {
    execute.mockRestore();
    window.removeEventListener("keydown", lateCapture as unknown as EventListener, true);
    button.remove();
  });

  const OFF_GRID_KEYS = FR_REFUSED_GRID_KEYS.filter((k) => k.gridFocusOnly !== true);
  const GRID_ONLY_KEYS = FR_REFUSED_GRID_KEYS.filter((k) => k.gridFocusOnly === true);

  it("every key some focus-blind built-in or listener acts on is refused off the grid", () => {
    const offGrid = new Set(OFF_GRID_KEYS.map((k) => k.combo));
    for (const combo of [
      "Ctrl+T", "Ctrl+Shift+L", "Ctrl+E", "Ctrl+K", "Ctrl+Shift+B", "Alt+Shift+ArrowRight",
      "Alt+Shift+ArrowLeft", "Ctrl+Alt+M", "Shift+F2", "Alt+ArrowDown", "Ctrl+Shift+C",
    ]) {
      expect(offGrid.has(combo), `${combo} stands down off the grid`).toBe(true);
    }
  });

  for (const refused of OFF_GRID_KEYS) {
    it(`${refused.combo} is refused with the button focused -- no built-in and no later window listener acts on the hidden cell`, async () => {
      setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
      expect(document.activeElement).toBe(button);
      const { key, init } = initFor(refused.combo);
      const e = press(key, init);
      await flush();
      expect(showToast, `${refused.combo}: no refusal`).toHaveBeenCalledTimes(1);
      expect(String(showToast.mock.calls[0][0])).toMatch(/floating range's cells/);
      expect(lateCapture, `${refused.combo}: a window listener still acted on Core's hidden cell`).not.toHaveBeenCalled();
      expect(execute.mock.calls.map((c) => c[0])).toEqual([`ext.floatingRange.refuse.${frRefusalSlug(refused)}`]);
      expect(e.defaultPrevented).toBe(true);
    });
  }

  it("a grid-only key stands down off the grid: no refusal, no registry command, and the key keeps its meaning there", async () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    for (const refused of GRID_ONLY_KEYS) {
      lateCapture.mockClear();
      const { key, init } = initFor(refused.combo);
      const e = press(key, init);
      await flush();
      // No registry binding acts on it off the grid (the claim `gridFocusOnly`
      // makes: its built-in, if any, is grid-scoped) ...
      expect(execute, `${refused.combo}: a registry command ran off the grid`).not.toHaveBeenCalled();
      // ... and the key reaches whatever owns it there, unprevented.
      expect(lateCapture, `${refused.combo}`).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented, `${refused.combo}`).toBe(false);
    }
    expect(showToast).not.toHaveBeenCalled();
  });

  it("positive control: with no range selection the off-grid keys reach their own listeners", async () => {
    press("m", { ctrlKey: true, altKey: true });
    press("F2", { shiftKey: true });
    await flush();
    expect(showToast).not.toHaveBeenCalled();
    expect(lateCapture).toHaveBeenCalledTimes(2);
  });

  it("a text field never sees a refusal (the bindings' not-editing context)", async () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    const field = document.createElement("input");
    document.body.appendChild(field);
    try {
      field.focus();
      press("k", { ctrlKey: true });
      await flush();
      expect(showToast).not.toHaveBeenCalled();
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
      setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
      const e = press(key, init);
      await flush();
      expect(gridKeyboardClears, `${mods}+${key} reached the grid keyboard (Core's hidden cell)`).toEqual([]);
      expect(ran).not.toContain("core.edit.clearContents");
      expect(updateFloatingRangeCell).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalled();
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
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    press("Backspace");
    await flush();
    expect(updateFloatingRangeCell).toHaveBeenCalledTimes(1);
    expect(gridKeyboardClears).toEqual([]);
  });
});
