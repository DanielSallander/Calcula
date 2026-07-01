// Dispatch-level tests for the centralized keybinding system.
//
// WHY THIS EXISTS: keyboard COMMAND dispatch (Ctrl+C/X/V, Ctrl+Z/Y, Ctrl+S, ...)
// has essentially no automated coverage — the Playwright e2e suite deliberately
// avoids driving these combos because WebView2 intercepts them. This jsdom suite
// is the safety net for the keyboard-dispatch consolidation: it drives
// `handleGlobalKeyDown` directly (not via the real window listener, to avoid
// capture-order flakiness) and asserts the right command fires, the focus/scope
// guards hold, user overrides route correctly, and DOM-text-selection defers to
// native copy. It is the gate for the riskier slices (remove MenuBar dispatch;
// de-dup grid clipboard keys).

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  handleGlobalKeyDown,
  getAllKeybindings,
  initKeybindings,
  setUserKeybinding,
  resetAllKeybindings,
} from "../keybindings";
import { CommandRegistry } from "../commands";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make the grid container the active element (isGridFocused() -> true). */
function focusGrid(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-focus-container", "spreadsheet");
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
  return el;
}

/** Move focus off the grid to a plain, non-editing element (body). */
function blurToBody(): void {
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.body.tabIndex = -1;
  document.body.focus();
}

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

/** Register a spy handler for a command; auto-cleaned in afterEach. */
const registered: string[] = [];
function spyCommand(commandId: string) {
  const spy = vi.fn();
  CommandRegistry.register(commandId, spy);
  registered.push(commandId);
  return spy;
}

beforeAll(() => {
  // Seed the registry with the 26 built-in DEFAULT_KEYBINDINGS + install the
  // (unused-by-us) window listener. We call handleGlobalKeyDown directly.
  initKeybindings();
});

beforeEach(() => {
  localStorage.clear();
  resetAllKeybindings();
});

afterEach(() => {
  for (const id of registered.splice(0)) CommandRegistry.unregister(id);
  document.querySelectorAll('[data-focus-container="spreadsheet"]').forEach((n) => n.remove());
  blurToBody();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

describe("handleGlobalKeyDown — core dispatch", () => {
  it.each([
    ["Ctrl+C", { key: "c", ctrlKey: true }, "core.clipboard.copy"],
    ["Ctrl+X", { key: "x", ctrlKey: true }, "core.clipboard.cut"],
    ["Ctrl+V", { key: "v", ctrlKey: true }, "core.clipboard.paste"],
    ["Ctrl+Z", { key: "z", ctrlKey: true }, "core.edit.undo"],
    ["Ctrl+Y", { key: "y", ctrlKey: true }, "core.edit.redo"],
    ["Ctrl+D", { key: "d", ctrlKey: true }, "core.edit.fillDown"],
    ["Ctrl+R", { key: "r", ctrlKey: true }, "core.edit.fillRight"],
  ])("%s dispatches %s when the grid is focused", async (_label, init, commandId) => {
    focusGrid();
    const spy = spyCommand(commandId);
    const ev = keydown(init);
    const pd = vi.spyOn(ev, "preventDefault");
    const handled = handleGlobalKeyDown(ev);
    await Promise.resolve();
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(pd).toHaveBeenCalled();
  });

  it("does NOT preventDefault or dispatch for an unbound combo", () => {
    focusGrid();
    const ev = keydown({ key: "q", ctrlKey: true, shiftKey: true });
    const pd = vi.spyOn(ev, "preventDefault");
    expect(handleGlobalKeyDown(ev)).toBe(false);
    expect(pd).not.toHaveBeenCalled();
  });

  it("ignores pure modifier keydown", () => {
    focusGrid();
    expect(handleGlobalKeyDown(keydown({ key: "Control", ctrlKey: true }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scope guards (grid-scoped vs app-global)
// ---------------------------------------------------------------------------

describe("handleGlobalKeyDown — focus scope", () => {
  it("skips a grid-scoped command (copy) when focus is outside the grid", async () => {
    blurToBody();
    const spy = spyCommand("core.clipboard.copy");
    const ev = keydown({ key: "c", ctrlKey: true });
    const pd = vi.spyOn(ev, "preventDefault");
    const handled = handleGlobalKeyDown(ev);
    await Promise.resolve();
    expect(handled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(pd).not.toHaveBeenCalled(); // lets native copy proceed
  });

  it("fires an app-global command (Find) even when focus is outside the grid", async () => {
    blurToBody();
    const spy = spyCommand("core.edit.find");
    const handled = handleGlobalKeyDown(keydown({ key: "f", ctrlKey: true }));
    await Promise.resolve();
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fires File > Save (Ctrl+S) even when focus is outside the grid", async () => {
    blurToBody();
    const spy = spyCommand("core.file.save");
    const handled = handleGlobalKeyDown(keydown({ key: "s", ctrlKey: true }));
    await Promise.resolve();
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // Undo/redo are app-global (context: "not-editing"), NOT grid-scoped: they fire
  // even when focus is on a non-grid shell element, but defer to native undo while
  // editing a text input. This preserves global undo after MenuBar's own keyboard
  // dispatcher was removed.
  it("fires undo (Ctrl+Z) when focus is outside the grid but not editing", async () => {
    blurToBody();
    const spy = spyCommand("core.edit.undo");
    const handled = handleGlobalKeyDown(keydown({ key: "z", ctrlKey: true }));
    await Promise.resolve();
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire undo (Ctrl+Z) while editing a text input", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const spy = spyCommand("core.edit.undo");
    const handled = handleGlobalKeyDown(keydown({ key: "z", ctrlKey: true }));
    await Promise.resolve();
    expect(handled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    input.remove();
  });
});

// ---------------------------------------------------------------------------
// DOM text-selection deferral (the original toast bug)
// ---------------------------------------------------------------------------

describe("handleGlobalKeyDown — DOM text selection defers copy/cut", () => {
  it("does NOT dispatch copy when a non-collapsed DOM selection exists", async () => {
    focusGrid();
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      isCollapsed: false,
      toString: () => "selected toast text",
    } as unknown as Selection);
    const spy = spyCommand("core.clipboard.copy");
    const ev = keydown({ key: "c", ctrlKey: true });
    const pd = vi.spyOn(ev, "preventDefault");
    handleGlobalKeyDown(ev);
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
    expect(pd).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// User customization
// ---------------------------------------------------------------------------

describe("handleGlobalKeyDown — user overrides", () => {
  it("dispatches copy on the overridden combo and not on the default", async () => {
    focusGrid();
    setUserKeybinding("core.copy", "Ctrl+Shift+K");
    const spy = spyCommand("core.clipboard.copy");

    handleGlobalKeyDown(keydown({ key: "k", ctrlKey: true, shiftKey: true }));
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);

    handleGlobalKeyDown(keydown({ key: "c", ctrlKey: true }));
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1); // default Ctrl+C no longer maps to copy
  });
});

// ---------------------------------------------------------------------------
// Menu-bar ↔ registry consistency (the Slice 2 gate)
// ---------------------------------------------------------------------------

describe("menu-bar shortcut ↔ registry consistency", () => {
  // Sanity: shortcuts that ARE already registry-bound must resolve.
  it.each([
    ["core.clipboard.copy"],
    ["core.clipboard.cut"],
    ["core.clipboard.paste"],
    ["core.edit.undo"],
    ["core.edit.find"],
  ])("registry has a binding for %s", (commandId) => {
    expect(getAllKeybindings().some((b) => b.commandId === commandId)).toBe(true);
  });

  // The former "silent-death" set: top-menu-bar shortcuts that used to be
  // dispatchable ONLY by MenuBar (no registry binding). Slice 2 registered these,
  // so removing MenuBar's keydown handler (Slice 3) can no longer kill them.
  const FORMERLY_MENUBAR_ONLY = [
    "core.file.new",
    "core.file.open",
    "core.file.save",
    "core.file.saveAs",
    "insert.table",
    "view.goToSpecial",
    "core.grid.merge",
  ];
  it("every former MenuBar-only shortcut now has a registry binding", () => {
    const bindings = getAllKeybindings();
    const missing = FORMERLY_MENUBAR_ONLY.filter((id) => !bindings.some((b) => b.commandId === id));
    expect(missing).toEqual([]);
  });
});
