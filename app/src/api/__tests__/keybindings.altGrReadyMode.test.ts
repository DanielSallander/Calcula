//! FILENAME: app/src/api/__tests__/keybindings.altGrReadyMode.test.ts
// PURPOSE: In READY mode -- the grid has the keyboard and no cell edit is open
//          -- a character the layout's AltGr produces is TYPING: the
//          dispatcher's tolerant tiers never read it as a shortcut. Excel
//          starts a cell entry with it; so does the grid (E13), once the
//          dispatcher lets it through.
// CONTEXT: W17 (wave C, the owner's decision on the wave-B KNOWN CONFLICT).
//          Windows reports AltGr as Ctrl+Alt, and Chromium cannot tell AltGr+8
//          from Ctrl+AltGr+8. The symbol tier (matchesEventOnLayout) read sv-SE
//          AltGr+8 / AltGr+9 as Ctrl+[ / Ctrl+] (Previous / Next Bookmark), and
//          the physical-key tier (matchesEventOnPhysicalKey) read AltGr+M (µ)
//          as New Comment's Ctrl+Alt+M and a user's Ctrl+Alt+2 as AltGr+2 (@),
//          so none of those characters could begin a cell entry. Typing now
//          wins wherever a CELL would receive it -- Core's grid focused and
//          unclaimed, or a selection owner whose own cell takes typing
//          (`receivesTyping`: a floating grid's selected cell, with the
//          keyboard on the grid or the body) -- and the tolerant tiers keep
//          working everywhere else: the commands stay reachable from a menu,
//          by a remap, and from the keyboard off the grid. Review C: an owner
//          whose selection takes NO typing (a floating grid selected as a
//          whole object) leaves no cell to type into, so the shortcut runs.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  handleGlobalKeyDown,
  initKeybindings,
  registerKeybinding,
  resetAllKeybindings,
} from "../keybindings";
import { CommandRegistry } from "../commands";
import { registerSelectionOwner } from "../../core/lib/selectionOwner";
import { setCoreCellEditFlag } from "../../core/lib/cellEditFlag";

const ran: string[] = [];
const COMMANDS = ["bookmarks.prev", "bookmarks.next", "review.newComment", "test.ctrlAlt2", "test.exactAt"];
const cleanups: (() => void)[] = [];

beforeAll(() => {
  initKeybindings();
});

beforeEach(() => {
  ran.length = 0;
  resetAllKeybindings();
  for (const id of COMMANDS) CommandRegistry.register(id, () => void ran.push(id));
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  for (const id of COMMANDS) CommandRegistry.unregister(id);
  resetAllKeybindings();
  setCoreCellEditFlag(false);
  document.body.innerHTML = "";
});

/** The grid's focus container, focused: ready mode. */
function focusGrid(): HTMLElement {
  const grid = document.createElement("div");
  grid.setAttribute("data-focus-container", "spreadsheet");
  grid.tabIndex = 0;
  document.body.appendChild(grid);
  grid.focus();
  return grid;
}

function focusButton(): HTMLElement {
  const button = document.createElement("button");
  document.body.appendChild(button);
  button.focus();
  return button;
}

function press(init: KeyboardEventInit & { keyCode?: number }): { handled: boolean; event: KeyboardEvent } {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  Object.defineProperty(event, "target", { value: document.activeElement ?? document.body });
  const handled = handleGlobalKeyDown(event);
  return { handled, event };
}

function bind(id: string, combo: string): void {
  cleanups.push(
    registerKeybinding({ id, combo, commandId: id, label: id, category: "Test", context: "not-editing", source: "user" }),
  );
}

/** sv-SE AltGr keystrokes as Chromium on Windows delivers them. */
const ALTGR_8 = { key: "[", code: "Digit8", keyCode: 56, ctrlKey: true, altKey: true };
const ALTGR_9 = { key: "]", code: "Digit9", keyCode: 57, ctrlKey: true, altKey: true };
const ALTGR_M = { key: "µ", code: "KeyM", keyCode: 77, ctrlKey: true, altKey: true };
const ALTGR_2 = { key: "@", code: "Digit2", keyCode: 50, ctrlKey: true, altKey: true };

describe("ready mode: an AltGr character is typing, never a tolerant match", () => {
  it("AltGr+8 / AltGr+9 ([ and ]) are not Previous / Next Bookmark: the key goes on to the grid", () => {
    focusGrid();
    for (const init of [ALTGR_8, ALTGR_9]) {
      const { handled, event } = press(init);
      expect(handled, init.key).toBe(false);
      expect(event.defaultPrevented, init.key).toBe(false);
    }
    expect(ran).toEqual([]);
  });

  it("AltGr+M (µ) is not New Comment's Ctrl+Alt+M", () => {
    focusGrid();
    const { handled } = press(ALTGR_M);
    expect(handled).toBe(false);
    expect(ran).toEqual([]);
  });

  it("a user's Ctrl+Alt+2 does not take AltGr+2 (@) by its key", () => {
    bind("test.ctrlAlt2", "Ctrl+Alt+2");
    focusGrid();
    press(ALTGR_2);
    expect(ran).toEqual([]);
  });

  it("a floating grid's cell owning the selection with the keyboard on the body: typing wins there too", () => {
    cleanups.push(
      registerSelectionOwner({ id: "test.owner", label: "a test object", ownsSelection: () => true, receivesTyping: () => true }),
    );
    (document.activeElement as HTMLElement | null)?.blur();
    const { handled } = press(ALTGR_8);
    expect(handled).toBe(false);
    expect(ran).toEqual([]);
  });

  it("the same with the GRID focused: the owner's cell takes the character (its type-to-edit), no bookmark runs", () => {
    cleanups.push(
      registerSelectionOwner({ id: "test.owner", label: "a test object", ownsSelection: () => true, receivesTyping: () => true }),
    );
    focusGrid();
    const { handled } = press(ALTGR_9);
    expect(handled).toBe(false);
    expect(ran).toEqual([]);
  });
});

describe("typing wins only where a CELL would receive the character (review C)", () => {
  // A floating grid selected as a whole OBJECT claims the selection -- Core's
  // own active cell is hidden and its type-to-edit refuses -- and the range's
  // type-to-edit takes a character only for a selected CELL. So nothing would
  // be typed: the keystroke is the shortcut it always was. W17 read "the grid
  // is focused" as "a cell receives it" and asked no owner, so AltGr+9 went on
  // to Core, which opened an edit of the HIDDEN cell.
  it("grid focused, an owner whose selection takes NO typing: AltGr+9 is Next Bookmark", () => {
    cleanups.push(registerSelectionOwner({ id: "test.owner", label: "a test object", ownsSelection: () => true }));
    focusGrid();
    const { handled, event } = press(ALTGR_9);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(ran).toEqual(["bookmarks.next"]);
  });

  it("an owner that says its cell takes no typing RIGHT NOW (receivesTyping false): AltGr+M is New Comment", () => {
    cleanups.push(
      registerSelectionOwner({ id: "test.owner", label: "a test object", ownsSelection: () => true, receivesTyping: () => false }),
    );
    focusGrid();
    press(ALTGR_M);
    expect(ran).toEqual(["review.newComment"]);
  });

  it("the keyboard on the body, an owner whose selection takes no typing: AltGr+8 is Previous Bookmark", () => {
    cleanups.push(registerSelectionOwner({ id: "test.owner", label: "a test object", ownsSelection: () => true }));
    (document.activeElement as HTMLElement | null)?.blur();
    press(ALTGR_8);
    expect(ran).toEqual(["bookmarks.prev"]);
  });

  it("an owner whose receivesTyping THROWS is read as taking no typing (a broken extension cannot eat the shortcut)", () => {
    cleanups.push(
      registerSelectionOwner({
        id: "test.owner",
        label: "a test object",
        ownsSelection: () => true,
        receivesTyping: () => {
          throw new Error("broken");
        },
      }),
    );
    focusGrid();
    press(ALTGR_9);
    expect(ran).toEqual(["bookmarks.next"]);
  });

  it("control: an owner registered but NOT claiming leaves Core's grid the typist -- typing wins", () => {
    cleanups.push(registerSelectionOwner({ id: "test.owner", label: "a test object", ownsSelection: () => false }));
    focusGrid();
    const { handled } = press(ALTGR_9);
    expect(handled).toBe(false);
    expect(ran).toEqual([]);
  });
});

describe("what typing-wins must NOT take away", () => {
  it("an EXACT binding of the typed character still runs: the user recorded Ctrl+Alt+@ on purpose", () => {
    bind("test.exactAt", "Ctrl+Alt+@");
    focusGrid();
    const { handled } = press(ALTGR_2);
    expect(handled).toBe(true);
    expect(ran).toEqual(["test.exactAt"]);
  });

  it("US keystrokes are shortcuts, not characters: Ctrl+[ and Ctrl+Alt+M (key m) run in ready mode", () => {
    focusGrid();
    press({ key: "[", code: "BracketLeft", ctrlKey: true });
    press({ key: "m", code: "KeyM", keyCode: 77, ctrlKey: true, altKey: true });
    expect(ran).toEqual(["bookmarks.prev", "review.newComment"]);
  });

  it("OFF the grid (a ribbon button has the keyboard) the tolerant tiers still hear the AltGr keystroke", () => {
    focusButton();
    press(ALTGR_9);
    press(ALTGR_M);
    expect(ran).toEqual(["bookmarks.next", "review.newComment"]);
  });

  it("the keyboard on the body with NO owner claiming the selection: nothing would type, the shortcut runs", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    press(ALTGR_8);
    expect(ran).toEqual(["bookmarks.prev"]);
  });
});
