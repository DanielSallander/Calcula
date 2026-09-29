//! FILENAME: app/src/api/__tests__/keybindings.layoutSymbols.test.ts
// PURPOSE: The dispatcher hears a SYMBOL shortcut on a keyboard layout where
//          the symbol itself needs Shift or AltGr -- without letting that
//          tolerance take a keystroke from an exact binding, or take a TYPED
//          character from a text field.
// CONTEXT: Review of BUG-0183 (K2). On sv-SE ";" is Shift+comma and "]" / "["
//          are AltGr+9 / AltGr+8 (AltGr arrives as Ctrl+Alt on Windows), so
//          Excel's Alt+; is typed Alt+Shift+comma and Ctrl+] Ctrl+AltGr+9. The
//          registry's exact-modifier match refused both, and once the
//          extensions' own listeners stood aside for the registry, Select
//          Visible Cells and next/previous bookmark were dead keys on that
//          layout. The fix is a SECOND, layout-tolerant tier the dispatcher
//          asks only when nothing matched exactly (matchesEventOnLayout).

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  handleGlobalKeyDown,
  initKeybindings,
  registerKeybinding,
  resetAllKeybindings,
  matchesEventOnLayout,
} from "../keybindings";
import { CommandRegistry } from "../commands";

const ran: string[] = [];
const COMMANDS = ["selectVisibleCells.execute", "bookmarks.next", "test.exactCtrlAlt", "test.always", "test.namedShift"];
const cleanups: (() => void)[] = [];

beforeAll(() => {
  initKeybindings();
});

beforeEach(() => {
  ran.length = 0;
  resetAllKeybindings();
  for (const id of COMMANDS) CommandRegistry.register(id, () => void ran.push(id));
  // A ribbon button has the keyboard: not typing, not the grid.
  const button = document.createElement("button");
  document.body.appendChild(button);
  button.focus();
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  for (const id of COMMANDS) CommandRegistry.unregister(id);
  resetAllKeybindings();
  document.body.innerHTML = "";
});

async function press(init: KeyboardEventInit): Promise<{ handled: boolean; event: KeyboardEvent }> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: document.activeElement ?? document.body });
  const handled = handleGlobalKeyDown(event);
  await Promise.resolve();
  await Promise.resolve();
  return { handled, event };
}

function bind(id: string, combo: string, context?: "always" | "not-editing"): void {
  cleanups.push(
    registerKeybinding({ id, combo, commandId: id, label: id, category: "Test", context, source: "extension" }),
  );
}

describe("the built-in symbol shortcuts, typed on sv-SE", () => {
  it("Alt+; typed as Alt+Shift+comma selects visible cells", async () => {
    const { handled, event } = await press({ key: ";", altKey: true, shiftKey: true });
    expect(ran).toEqual(["selectVisibleCells.execute"]);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Ctrl+] typed as Ctrl+AltGr+9 goes to the next bookmark", async () => {
    await press({ key: "]", ctrlKey: true, altKey: true });
    expect(ran).toEqual(["bookmarks.next"]);
  });

  it("positive control: the US-layout keystrokes still match exactly", async () => {
    await press({ key: ";", altKey: true });
    await press({ key: "]", ctrlKey: true });
    expect(ran).toEqual(["selectVisibleCells.execute", "bookmarks.next"]);
  });
});

describe("what the tolerance must NOT do", () => {
  it("an EXACT binding wins: Ctrl+Alt+] bound on its own is not taken by Ctrl+]", async () => {
    bind("test.exactCtrlAlt", "Ctrl+Alt+]");
    await press({ key: "]", ctrlKey: true, altKey: true });
    expect(ran).toEqual(["test.exactCtrlAlt"]);
  });

  it("Alt is not AltGr: Ctrl+Alt+; does not select visible cells (Alt+;)", async () => {
    const { handled } = await press({ key: ";", ctrlKey: true, altKey: true });
    expect(ran).toEqual([]);
    expect(handled).toBe(false);
  });

  it("a combo that NAMES Shift still requires it", async () => {
    bind("test.namedShift", "Ctrl+Shift+.");
    await press({ key: ".", ctrlKey: true });
    expect(ran).toEqual([]);
    await press({ key: ".", ctrlKey: true, altKey: true, shiftKey: true });
    expect(ran).toEqual(["test.namedShift"]);
  });

  it("while TYPING, a Ctrl+Alt character is text: an always-on Ctrl+. is not run by AltGr+.", async () => {
    bind("test.always", "Ctrl+.", "always");
    document.body.innerHTML = "";
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const typed = await press({ key: ".", ctrlKey: true, altKey: true });
    expect(ran, "an AltGr-typed character in a text field ran a shortcut").toEqual([]);
    expect(typed.event.defaultPrevented).toBe(false);
    // Positive control: the exact keystroke still reaches an always-on binding there.
    await press({ key: ".", ctrlKey: true });
    expect(ran).toEqual(["test.always"]);
  });

  it("off a text field the same AltGr keystroke does reach it", async () => {
    bind("test.always", "Ctrl+.", "always");
    await press({ key: ".", ctrlKey: true, altKey: true });
    expect(ran).toEqual(["test.always"]);
  });
});

describe("matchesEventOnLayout: symbols only", () => {
  const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
  it.each([
    ["Ctrl+E", { key: "E", ctrlKey: true, shiftKey: true }],
    ["Ctrl+1", { key: "1", ctrlKey: true, shiftKey: true }],
    ["Alt+Shift+ArrowRight", { key: "ArrowRight", altKey: true }],
    ["Shift+F2", { key: "F2", shiftKey: true, ctrlKey: true, altKey: true }],
    ["Ctrl+]", { key: "]", ctrlKey: true, metaKey: true }],
    ["Ctrl+]", { key: "[", ctrlKey: true, altKey: true }],
  ] as const)("%s never matches %o", (combo, init) => {
    expect(matchesEventOnLayout(combo, ev(init), { altGr: true })).toBe(false);
  });

  it("AltGr is read only when asked", () => {
    expect(matchesEventOnLayout("Ctrl+]", ev({ key: "]", ctrlKey: true, altKey: true }), { altGr: true })).toBe(true);
    expect(matchesEventOnLayout("Ctrl+]", ev({ key: "]", ctrlKey: true, altKey: true }), { altGr: false })).toBe(false);
  });
});
