//! FILENAME: app/src/api/__tests__/keybindings.altGrNoCell.test.ts
// PURPOSE: "Typing wins" (W17) only where a CELL will receive the character:
//          on a CANVAS -- Core's grid focused, nothing claiming the selection,
//          but no cell selected, because a canvas has none -- an AltGr
//          keystroke is the shortcut it always was.
// CONTEXT: X16 (wave D; wave C core fix-up, new defect 4). The ready-mode rule
//          asked only "is the grid focused and unclaimed". On a canvas that
//          holds, yet Core's selection is null (the reducer drops it on
//          entering a canvas) and its type-to-edit opens nothing, so sv-SE
//          AltGr+9 did NOTHING at all -- before W17 it was Next Bookmark. The
//          dispatcher now also asks Core's grid state whether a cell is
//          selected. US Ctrl+] (an exact match) was never affected.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const grid = vi.hoisted(() => ({
  state: null as null | { surface: "grid" | "canvas"; selection: unknown },
}));
vi.mock("../../core/state/GridContext", () => ({
  getGridStateSnapshot: () => grid.state,
}));

import { handleGlobalKeyDown, initKeybindings, resetAllKeybindings } from "../keybindings";
import { CommandRegistry } from "../commands";
import { registerSelectionOwner } from "../../core/lib/selectionOwner";

const ran: string[] = [];
const COMMANDS = ["bookmarks.prev", "bookmarks.next", "review.newComment"];
const cleanups: (() => void)[] = [];

const A1 = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };

beforeAll(() => {
  initKeybindings();
});

beforeEach(() => {
  ran.length = 0;
  grid.state = null;
  resetAllKeybindings();
  for (const id of COMMANDS) CommandRegistry.register(id, () => void ran.push(id));
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  for (const id of COMMANDS) CommandRegistry.unregister(id);
  resetAllKeybindings();
  document.body.innerHTML = "";
});

function focusGrid(): void {
  const el = document.createElement("div");
  el.setAttribute("data-focus-container", "spreadsheet");
  el.tabIndex = 0;
  document.body.appendChild(el);
  el.focus();
}

function press(init: KeyboardEventInit & { keyCode?: number }): { handled: boolean; event: KeyboardEvent } {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  Object.defineProperty(event, "target", { value: document.activeElement ?? document.body });
  const handled = handleGlobalKeyDown(event);
  return { handled, event };
}

/** sv-SE AltGr keystrokes as Chromium on Windows delivers them. */
const ALTGR_8 = { key: "[", code: "Digit8", keyCode: 56, ctrlKey: true, altKey: true };
const ALTGR_9 = { key: "]", code: "Digit9", keyCode: 57, ctrlKey: true, altKey: true };
const ALTGR_M = { key: "µ", code: "KeyM", keyCode: 77, ctrlKey: true, altKey: true };

describe("a canvas with nothing selected: no cell receives the character, so the key is the shortcut", () => {
  it("AltGr+9 is Next Bookmark", () => {
    grid.state = { surface: "canvas", selection: null };
    focusGrid();
    const { handled, event } = press(ALTGR_9);
    expect(ran, "AltGr+9 did nothing on a canvas: read as typing with no cell to type into").toEqual([
      "bookmarks.next",
    ]);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("AltGr+8 is Previous Bookmark and AltGr+M is New Comment", () => {
    grid.state = { surface: "canvas", selection: null };
    focusGrid();
    press(ALTGR_8);
    press(ALTGR_M);
    expect(ran).toEqual(["bookmarks.prev", "review.newComment"]);
  });

  it("a worksheet grid with NO cell selected answers the same way (the question is the cell, not the surface)", () => {
    grid.state = { surface: "grid", selection: null };
    focusGrid();
    press(ALTGR_9);
    expect(ran).toEqual(["bookmarks.next"]);
  });
});

describe("controls: where a cell receives it, typing still wins", () => {
  it("a worksheet with a selected cell: AltGr+9 types ']' (no bookmark)", () => {
    grid.state = { surface: "grid", selection: A1 };
    focusGrid();
    const { handled } = press(ALTGR_9);
    expect(handled).toBe(false);
    expect(ran).toEqual([]);
  });

  it("a canvas whose floating grid has a selected CELL (an owner that takes typing): typing wins", () => {
    grid.state = { surface: "canvas", selection: null };
    cleanups.push(
      registerSelectionOwner({ id: "test.owner", label: "a test object", ownsSelection: () => true, receivesTyping: () => true }),
    );
    focusGrid();
    const { handled } = press(ALTGR_9);
    expect(handled).toBe(false);
    expect(ran).toEqual([]);
  });

  it("the US exact binding Ctrl+] runs on a canvas as before", () => {
    grid.state = { surface: "canvas", selection: null };
    focusGrid();
    press({ key: "]", code: "BracketRight", ctrlKey: true });
    expect(ran).toEqual(["bookmarks.next"]);
  });
});
