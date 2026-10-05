//! FILENAME: app/src/api/__tests__/keybindings.f5NeverReloads.test.ts
// PURPOSE: F5 never reaches the browser's own handling, which in WebView2 is
//          RELOAD -- a reload throws away the open workbook's unsaved session.
// CONTEXT: (Home tab = Excel's Home tab, 2026-10-04, review finding (a).) F5 is
//          the registry's Go To (core.goTo, "not-editing"), and Core's grid
//          handler no longer takes it (gridKeyboardF5GoTo.test.tsx). So whenever
//          the Go To binding stands down -- a cell edit open (in-cell, parked,
//          the formula bar), a text field focused (a dialog box, a pane), Go To
//          remapped to another key -- nothing took the key, and WebView2 reloads
//          the page on an unprevented F5 (nothing in the app turns its browser
//          accelerator keys off). Excel never reloads anything on F5.
//          DECISION: during an edit F5 is SWALLOWED, not Go To: Go To moves
//          Core's selection, and an edit owns the keyboard (the dispatcher's
//          "not-editing" rule). Ctrl+F5 / Shift+F5 (the browser's hard reloads)
//          are swallowed the same way. Only the default is prevented: the key
//          still propagates, so an editor that listens for it still hears it.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { handleGlobalKeyDown, initKeybindings, setUserKeybinding, resetAllKeybindings } from "../keybindings";
import { CommandRegistry } from "../commands";
import { setGlobalIsEditing } from "../editing";

const GO_TO = "navigate.goTo";
let goTo: ReturnType<typeof vi.fn>;

beforeAll(() => {
  initKeybindings();
});

afterEach(() => {
  CommandRegistry.unregister(GO_TO);
  setGlobalIsEditing(false);
  resetAllKeybindings();
  document.body.innerHTML = "";
  (document.activeElement as HTMLElement | null)?.blur?.();
});

function spyGoTo(): void {
  goTo = vi.fn();
  CommandRegistry.register(GO_TO, goTo);
}

function focusGrid(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-focus-container", "spreadsheet");
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
  return el;
}

function focusField(tag: "input" | "textarea"): HTMLElement {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  el.focus();
  return el;
}

/** Core's in-cell editor: a textarea INSIDE the grid container, edit flag up. */
function openInCellEditor(): void {
  setGlobalIsEditing(true);
  const container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = -1;
  const editor = document.createElement("textarea");
  editor.setAttribute("data-inline-editor", "true");
  container.appendChild(editor);
  document.body.appendChild(container);
  editor.focus();
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: document.activeElement ?? document.body });
  handleGlobalKeyDown(event);
  return event;
}

const F5 = { key: "F5", code: "F5" };

describe("F5 is never the browser's (WebView2 reloads the page on it)", () => {
  it("in Core's in-cell editor: Go To does not run, and the reload is prevented", () => {
    spyGoTo();
    openInCellEditor();
    const e = press(F5);
    expect(goTo, "Go To ran during an in-cell edit").not.toHaveBeenCalled();
    expect(e.defaultPrevented, "F5 during an edit reached WebView2's reload").toBe(true);
  });

  it("with Core's edit PARKED (keyboard on the grid container): prevented", () => {
    spyGoTo();
    setGlobalIsEditing(true);
    focusGrid();
    const e = press(F5);
    expect(goTo).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("in a text field (a dialog box, the formula bar): prevented", () => {
    spyGoTo();
    focusField("input");
    const e = press(F5);
    expect(goTo).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("with Go To REMAPPED off F5: F5 runs nothing and still does not reload", () => {
    spyGoTo();
    setUserKeybinding("core.goTo", "Ctrl+Alt+F12");
    focusGrid();
    const e = press(F5);
    expect(goTo).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("Ctrl+F5 and Shift+F5 (the hard reloads) are prevented too", () => {
    spyGoTo();
    focusGrid();
    expect(press({ ...F5, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press({ ...F5, shiftKey: true }).defaultPrevented).toBe(true);
  });

  it("swallowing never stops propagation: an editor that listens for F5 still hears it", () => {
    openInCellEditor();
    const e = press(F5);
    expect(e.cancelBubble, "the reload guard stopped propagation").toBe(false);
  });

  it("control: no edit, grid focused -> F5 is Go To, as before", () => {
    spyGoTo();
    focusGrid();
    const e = press(F5);
    expect(goTo).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("control: an unbound key the guard is not about (F12) is left alone", () => {
    focusField("input");
    const e = press({ key: "F12", code: "F12" });
    expect(e.defaultPrevented).toBe(false);
  });
});
