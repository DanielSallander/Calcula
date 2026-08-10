//! FILENAME: app/extensions/BuiltIn/StandardMenus/__tests__/editMenuUndoEnablement.test.ts
// PURPOSE: Edit > Undo and Edit > Redo follow the real undo stack, from the
//          SAME store the ribbon reads.
// CONTEXT: Measured 2026-08-10 (register §3ax(1)): the Edit menu items carried
//          no enablement at all. The ribbon half is pinned in
//          HomeTab/__tests__/homeTabUndoEnablement.test.tsx; the property that
//          matters across the two is that a greyed ribbon button can never sit
//          above an enabled menu entry for the same command, which is why both
//          bind to `@api/undoState` rather than each polling for itself.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// --- Mocks: the menu registry is the surface under test ---------------------

const registerMenu = vi.fn();
const updateMenuItem = vi.fn();
const registerShellComponent = vi.fn();
const unregisterShellComponent = vi.fn();

vi.mock("@api/ui", () => ({
  registerMenu: (...a: unknown[]) => registerMenu(...a),
  registerShellComponent: (...a: unknown[]) => registerShellComponent(...a),
  unregisterShellComponent: (...a: unknown[]) => unregisterShellComponent(...a),
  showDialog: vi.fn(),
  registerMenuItem: vi.fn(),
  unregisterMenuItem: vi.fn(),
  updateMenuItem: (...a: unknown[]) => updateMenuItem(...a),
}));

// The menu icons hang off the @api barrel, which reaches every extension; a
// flat stub keeps that graph out of this test.
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

vi.mock("../FormatMenu", () => ({ registerFormatMenu: vi.fn() }));
vi.mock("../FileMenu", () => ({
  fileNew: vi.fn(),
  fileOpen: vi.fn(),
  fileSave: vi.fn(),
  fileSaveAs: vi.fn(),
}));
vi.mock("../StandardMenus", () => ({ StandardMenus: () => null }));

// The real store would reach the Tauri backend for its seed read; drive it by
// hand instead so the test controls the transitions.
let listener: ((a: { canUndo: boolean; canRedo: boolean }) => void) | null = null;
const unsubscribe = vi.fn();
const initial = { canUndo: false, canRedo: false };

vi.mock("@api/undoState", () => ({
  getUndoAvailability: () => initial,
  subscribeToUndoAvailability: (cb: (a: { canUndo: boolean; canRedo: boolean }) => void) => {
    listener = cb;
    return unsubscribe;
  },
}));

import extension from "../index";

function context() {
  return {
    commands: { register: vi.fn(), unregister: vi.fn(), execute: vi.fn() },
  } as never;
}

/** The last `disabled` value pushed for one Edit menu item id. */
function lastDisabled(itemId: string): boolean | undefined {
  const calls = updateMenuItem.mock.calls.filter(
    (c) => c[0] === "edit" && c[1] === itemId,
  );
  return calls.length === 0
    ? undefined
    : (calls[calls.length - 1][2] as { disabled?: boolean }).disabled;
}

beforeEach(() => {
  registerMenu.mockReset();
  updateMenuItem.mockReset();
  unsubscribe.mockReset();
  listener = null;
  initial.canUndo = false;
  initial.canRedo = false;
});

afterEach(() => {
  extension.deactivate?.();
});

describe("Edit menu undo/redo enablement", () => {
  it("greys both items on activation when the stack is empty", () => {
    extension.activate(context());

    expect(lastDisabled("edit:undo")).toBe(true);
    expect(lastDisabled("edit:redo")).toBe(true);
  });

  it("does not grey them when the stack is not empty", () => {
    initial.canUndo = true;
    initial.canRedo = true;
    extension.activate(context());

    expect(lastDisabled("edit:undo")).toBe(false);
    expect(lastDisabled("edit:redo")).toBe(false);
  });

  it("follows later transitions", () => {
    extension.activate(context());
    expect(listener, "the extension never subscribed").toBeTruthy();

    listener!({ canUndo: true, canRedo: false });
    expect(lastDisabled("edit:undo")).toBe(false);
    expect(lastDisabled("edit:redo")).toBe(true);

    listener!({ canUndo: false, canRedo: true });
    expect(lastDisabled("edit:undo")).toBe(true);
    expect(lastDisabled("edit:redo")).toBe(false);
  });

  it("patches the items in place rather than re-registering the menu", () => {
    // Re-registering would rebuild Edit from this extension's own literal and
    // drop anything another extension had contributed to it in the meantime.
    extension.activate(context());
    const registrations = registerMenu.mock.calls.length;

    listener!({ canUndo: true, canRedo: true });

    expect(registerMenu.mock.calls.length).toBe(registrations);
  });

  it("unsubscribes on deactivate", () => {
    extension.activate(context());
    extension.deactivate?.();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
