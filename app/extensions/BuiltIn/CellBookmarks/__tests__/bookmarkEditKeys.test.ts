//! FILENAME: app/extensions/BuiltIn/CellBookmarks/__tests__/bookmarkEditKeys.test.ts
// PURPOSE: The bookmark keys (Ctrl+Shift+B, Ctrl+] / Ctrl+[, Ctrl+Shift+V) do
//          nothing while a cell edit owns the keyboard, and still act (once)
//          when nothing is being edited.
// CONTEXT: Fix round 4, F2: Ctrl+Shift+B bookmarked Core's selection (hidden
//          during a floating-grid edit), Ctrl+] moved it, and Ctrl+Shift+V --
//          the native paste-as-text in a field -- was cancelled to open Save
//          View. Since wave B (D1) Ctrl+Shift+B and Ctrl+] / Ctrl+[ go ONLY
//          through the keybinding registry (its `not-editing` bindings and the
//          registered bookmarks.toggle / next / prev commands), so they are
//          driven through the REAL dispatcher and the real activation here;
//          Ctrl+Shift+V (Save Current View) is the one key Cell Bookmarks still
//          hears itself -- off the grid, because on the grid it is Paste
//          Special's binding -- through handleBookmarkKeyDown.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const addBookmark = vi.fn();
const removeBookmark = vi.fn();
vi.mock("../lib/bookmarkStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/bookmarkStore")>()),
  addBookmark: (...a: unknown[]) => addBookmark(...a),
  removeBookmark: (...a: unknown[]) => removeBookmark(...a),
  hasBookmarkAt: () => false,
}));
const navigateToNextBookmark = vi.fn(() => ({ row: 0, col: 0 }));
const navigateToPrevBookmark = vi.fn(() => ({ row: 0, col: 0 }));
vi.mock("../lib/bookmarkNavigation", () => ({
  navigateToNextBookmark: () => navigateToNextBookmark(),
  navigateToPrevBookmark: () => navigateToPrevBookmark(),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({
    selection: { startRow: 7, startCol: 2, endRow: 7, endCol: 2 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));
const showOverlay = vi.fn();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showOverlay: (...a: unknown[]) => showOverlay(...a),
  showToast: vi.fn(),
}));

import extension, { handleBookmarkKeyDown } from "../index";
import { CommandRegistry } from "@api/commands";
import { initKeybindings } from "@api/keybindings";
import { registerExternalFormulaTarget, setGlobalIsEditing } from "@api/editing";

const cleanups: (() => void)[] = [];

/** Every door inert, except `commands`, which are REAL. */
function stubContext(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) => {
      if (prop === "commands") {
        return {
          register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
            CommandRegistry.register(id, fn, opts as never),
          unregister: (id: string) => CommandRegistry.unregister(id),
          execute: (id: string) => CommandRegistry.execute(id),
        };
      }
      if (prop === "invokeBackend") return vi.fn(async () => null);
      return (t as Record<string | symbol, unknown>)[prop as string];
    },
  }) as never;
}
function focus(el: HTMLElement): HTMLElement {
  document.body.appendChild(el);
  el.focus();
  return el;
}
function gridContainer(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-focus-container", "spreadsheet");
  el.tabIndex = 0;
  return el;
}
function startFloatingGridEdit(): void {
  cleanups.push(
    registerExternalFormulaTarget({
      isExpectingReference: () => false,
      insertReference: () => undefined,
      session: {} as never,
    }),
  );
}
async function press(k: string, shift: boolean): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { key: k, ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  return e;
}
function acted(): number {
  return (
    addBookmark.mock.calls.length +
    removeBookmark.mock.calls.length +
    navigateToNextBookmark.mock.calls.length +
    navigateToPrevBookmark.mock.calls.length +
    showOverlay.mock.calls.length
  );
}

/** The registry-bound keys: [label, key, shift]. */
const REGISTRY_KEYS: [string, string, boolean][] = [
  ["Ctrl+Shift+B", "B", true],
  ["Ctrl+]", "]", false],
  ["Ctrl+[", "[", false],
];

beforeAll(async () => {
  initKeybindings();
  await extension.activate(stubContext());
});
afterAll(async () => {
  await extension.deactivate?.();
});
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("the registry's bookmark keys while a cell edit owns the keyboard", () => {
  for (const [label, k, shift] of REGISTRY_KEYS) {
    it(`${label}: a floating grid's live edit, parked with the keyboard on the grid -> nothing happens, key not taken`, async () => {
      startFloatingGridEdit();
      focus(gridContainer());
      const e = await press(k, shift);
      expect(acted()).toBe(0);
      expect(e.defaultPrevented).toBe(false);
    });

    it(`${label}: the formula bar focused during a floating grid's edit -> nothing happens`, async () => {
      startFloatingGridEdit();
      focus(document.createElement("input"));
      await press(k, shift);
      expect(acted()).toBe(0);
    });

    it(`${label}: Core's own in-cell edit -> nothing happens`, async () => {
      setGlobalIsEditing(true);
      focus(document.createElement("textarea"));
      const e = await press(k, shift);
      expect(acted()).toBe(0);
      expect(e.defaultPrevented).toBe(false);
    });

    it(`${label}: positive control -- nothing being edited, grid focused -> it acts ONCE`, async () => {
      focus(gridContainer());
      const e = await press(k, shift);
      expect(acted()).toBe(1);
      expect(e.defaultPrevented).toBe(true);
    });
  }

  it("Ctrl+Shift+B with no edit bookmarks Core's active cell", async () => {
    focus(gridContainer());
    await press("B", true);
    expect(addBookmark).toHaveBeenCalledWith(7, 2, 0, "Sheet1");
  });
});

describe("Ctrl+Shift+V (Save Current View, the listener's own key) while a cell edit owns the keyboard", () => {
  function ctrlShiftV(): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { key: "V", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(e, "target", { value: document.activeElement ?? document.body });
    handleBookmarkKeyDown(e);
    return e;
  }

  it("a floating grid's live edit, parked with the keyboard on the grid -> nothing happens, key not taken", () => {
    startFloatingGridEdit();
    focus(gridContainer());
    const e = ctrlShiftV();
    expect(acted()).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("a text field (the native paste-as-text) -> nothing happens, key not taken", () => {
    focus(document.createElement("input"));
    const e = ctrlShiftV();
    expect(acted()).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("Core's own in-cell edit -> nothing happens", () => {
    setGlobalIsEditing(true);
    focus(document.createElement("textarea"));
    ctrlShiftV();
    expect(acted()).toBe(0);
  });

  it("positive control: nothing being edited, a ribbon button focused -> Save Current View opens", () => {
    focus(document.createElement("button"));
    const e = ctrlShiftV();
    expect(showOverlay).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("its former keys are not the listener's any more: Ctrl+Shift+B through the listener does nothing", () => {
    focus(gridContainer());
    const e = new KeyboardEvent("keydown", { key: "B", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(e, "target", { value: document.activeElement ?? document.body });
    handleBookmarkKeyDown(e);
    expect(acted()).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });
});
