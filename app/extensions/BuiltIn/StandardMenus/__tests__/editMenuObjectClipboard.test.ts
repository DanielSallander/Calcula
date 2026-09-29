//! FILENAME: app/extensions/BuiltIn/StandardMenus/__tests__/editMenuObjectClipboard.test.ts
// PURPOSE: Edit > Copy and Edit > Paste on a CANVAS copy and paste the
//          selected OBJECTS -- the canvas's own door, the one Ctrl+C / Ctrl+V
//          reach there -- and keep running the cell clipboard everywhere else.
// CONTEXT: X12 (wave D; wave C canvas fix-up, NEEDS OTHER OWNER). The items
//          named only `core.clipboard.copy` / `core.clipboard.paste`, the
//          grid's cell clipboard, which has nothing to act on on a page with
//          no cells: select a chart on a canvas, Edit > Copy, Ctrl+V -- nothing
//          was pasted. The keys already went to the canvas's commands through
//          guarded bindings (CanvasSheet lib/canvasClipboard.ts); a menu item
//          runs no binding, so it has to ask the same question itself.
//
//          Real @api/commands, @api/objectClipboard and @api/objectSelection:
//          the canvas is Core's grid state saying `surface: "canvas"` (the one
//          thing `canvasOwnsObjectClipboard` reads), and an INNER selection
//          that owns the clipboard keys is a real object-selection provider.
//          The item is run the way the MenuBar runs one: its `action` when it
//          has one, else its `commandId`.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles export React components under their real PascalCase
 * names (the icons, `StandardMenus`), which the code under test imports. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// --- Core's grid state: the surface is what decides "canvas" ----------------
const grid = vi.hoisted(() => ({
  state: { surface: "grid" as "grid" | "canvas", selection: null as unknown },
}));
vi.mock("../../../../src/core/state/GridContext", () => ({
  getGridStateSnapshot: () => grid.state,
}));

// --- The menu registry is where the Edit menu is read from ------------------
const registerMenu = vi.fn();
vi.mock("@api/ui", () => ({
  registerMenu: (...a: unknown[]) => registerMenu(...a),
  unregisterMenu: vi.fn(),
  registerShellComponent: vi.fn(),
  unregisterShellComponent: vi.fn(),
  showDialog: vi.fn(),
  registerMenuItem: vi.fn(),
  unregisterMenuItem: vi.fn(),
  updateMenuItem: vi.fn(),
}));
vi.mock("@api", () => {
  const Stub = () => null;
  const names = [
    "IconUndo", "IconRedo", "IconCut", "IconCopy", "IconPaste",
    "IconPasteValues", "IconPasteFormulas", "IconPasteFormatting",
    "IconPasteLink", "IconPasteSpecial", "IconClear", "IconClearFormatting",
    "IconClearContents", "IconClearComments", "IconClearHyperlinks",
    "IconFind", "IconReplace",
  ];
  return Object.fromEntries(names.map((n) => [n, Stub]));
});
vi.mock("../FormatMenu", () => ({ registerFormatMenu: vi.fn(() => () => {}) }));
vi.mock("../FileMenu", () => ({
  fileNew: vi.fn(),
  fileOpen: vi.fn(),
  fileSave: vi.fn(),
  fileSaveAs: vi.fn(),
}));
vi.mock("../StandardMenus", () => ({ StandardMenus: () => null }));
vi.mock("@api/undoState", () => ({
  getUndoAvailability: () => ({ canUndo: false, canRedo: false }),
  subscribeToUndoAvailability: () => () => {},
}));

import extension from "../index";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { registerObjectSelectionProvider, type ObjectSelectionKey } from "@api/objectSelection";
import type { MenuDefinition, MenuItemDefinition } from "@api/ui";
import {
  CANVAS_COPY_SELECTION_COMMAND,
  CANVAS_PASTE_OBJECTS_COMMAND,
} from "../../../CanvasSheet/lib/canvasClipboard";

const ran: string[] = [];
const cleanups: (() => void)[] = [];

function context() {
  return { commands: { register: vi.fn(), unregister: vi.fn(), execute: vi.fn() } } as never;
}

function editMenu(): MenuDefinition {
  const def = registerMenu.mock.calls.map((c) => c[0] as MenuDefinition).find((m) => m.id === "edit");
  if (!def) throw new Error("the Edit menu was never registered");
  return def;
}

function findItem(items: readonly MenuItemDefinition[], id: string): MenuItemDefinition | null {
  for (const item of items) {
    if (item.id === id) return item;
    const inner = item.children ? findItem(item.children, id) : null;
    if (inner) return inner;
  }
  return null;
}

/** Run an item the way the MenuBar's executeMenuItem does, and let it land. */
async function click(itemId: string): Promise<void> {
  const item = findItem(editMenu().items, itemId);
  if (!item) throw new Error(`no Edit menu item ${itemId}`);
  if (item.action) item.action();
  else if (item.commandId) void CommandRegistry.execute(item.commandId);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A family whose INNER selection holds the clipboard keys (a floating grid's selected cell). */
function innerSelectionOwnsClipboard(): void {
  cleanups.push(
    registerObjectSelectionProvider({
      types: ["test-inner"],
      isSelected: () => true,
      select: () => {},
      deselectAll: () => {},
      ownsKey: (key: ObjectSelectionKey) => key === "Clipboard",
    }),
  );
}

beforeEach(() => {
  ran.length = 0;
  registerMenu.mockReset();
  grid.state = { surface: "grid", selection: null };
  for (const id of [
    CANVAS_COPY_SELECTION_COMMAND,
    CANVAS_PASTE_OBJECTS_COMMAND,
    CoreCommands.COPY,
    CoreCommands.PASTE,
  ]) {
    CommandRegistry.register(id, () => void ran.push(id));
  }
  extension.activate(context());
});

afterEach(() => {
  extension.deactivate?.();
  while (cleanups.length > 0) cleanups.pop()!();
  for (const id of [
    CANVAS_COPY_SELECTION_COMMAND,
    CANVAS_PASTE_OBJECTS_COMMAND,
    CoreCommands.COPY,
    CoreCommands.PASTE,
  ]) {
    CommandRegistry.unregister(id);
  }
});

describe("Edit > Copy / Paste on a canvas run the canvas's object clipboard", () => {
  it("Edit > Copy copies the selected objects (the canvas's own Copy), not the cell clipboard", async () => {
    grid.state = { surface: "canvas", selection: null };
    await click("edit:copy");
    expect(ran, "Edit > Copy ran the grid's cell copy on a page with no cells").toEqual([
      CANVAS_COPY_SELECTION_COMMAND,
    ]);
  });

  it("Edit > Paste > Paste pastes the copied objects (the canvas's own Paste)", async () => {
    grid.state = { surface: "canvas", selection: null };
    await click("edit:paste:paste");
    expect(ran, "Edit > Paste ran the grid's cell paste on a page with no cells").toEqual([
      CANVAS_PASTE_OBJECTS_COMMAND,
    ]);
  });

  it("an INNER selection holding the clipboard keys (a floating grid's cell) keeps them: the cell clipboard runs", async () => {
    grid.state = { surface: "canvas", selection: null };
    innerSelectionOwnsClipboard();
    await click("edit:copy");
    await click("edit:paste:paste");
    expect(ran).toEqual([CoreCommands.COPY, CoreCommands.PASTE]);
  });

  it("with the canvas's commands not registered (its extension off), the items fall back to the cell clipboard", async () => {
    grid.state = { surface: "canvas", selection: null };
    CommandRegistry.unregister(CANVAS_COPY_SELECTION_COMMAND);
    CommandRegistry.unregister(CANVAS_PASTE_OBJECTS_COMMAND);
    await click("edit:copy");
    await click("edit:paste:paste");
    expect(ran).toEqual([CoreCommands.COPY, CoreCommands.PASTE]);
  });
});

describe("positive control: a worksheet keeps the cell clipboard", () => {
  it("Edit > Copy and Edit > Paste run core.clipboard.copy / core.clipboard.paste", async () => {
    grid.state = { surface: "grid", selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } };
    await click("edit:copy");
    await click("edit:paste:paste");
    expect(ran).toEqual([CoreCommands.COPY, CoreCommands.PASTE]);
  });

  it("the items still NAME the cell commands (their shortcut chips and tooltips read commandId)", () => {
    expect(findItem(editMenu().items, "edit:copy")?.commandId).toBe(CoreCommands.COPY);
    expect(findItem(editMenu().items, "edit:paste:paste")?.commandId).toBe(CoreCommands.PASTE);
  });
});
