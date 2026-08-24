//! FILENAME: app/src/api/__tests__/nameManagerShortcut.test.ts
// PURPOSE: Ctrl+F3 opens the Name Manager, and bare F3 stays free.
// CONTEXT: DEFAULT_KEYBINDINGS had no F3 row of any kind, so Excel's Ctrl+F3 did
//          nothing at all — the Name Manager was reachable only through the
//          Formulas menu. The one existing F3 handler in the app is Find Next
//          inside the Find and Replace dialog, and it tests `e.key === "F3"`
//          WITHOUT looking at ctrlKey; that is why this file asserts not only
//          that Ctrl+F3 fires the command but that the dispatcher CONSUMES the
//          event, since it is the capture-phase stopPropagation that keeps a
//          Ctrl+F3 from also stepping the find cursor.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  handleGlobalKeyDown,
  getAllKeybindings,
  getEffectiveCombo,
  findConflicts,
  initKeybindings,
  resetAllKeybindings,
} from "../keybindings";
import { CommandRegistry } from "../commands";

const NAME_MANAGER_COMMAND = "definedNames.nameManager";

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

const registered: string[] = [];
function spyCommand(commandId: string) {
  const spy = vi.fn();
  CommandRegistry.register(commandId, spy);
  registered.push(commandId);
  return spy;
}

beforeAll(() => {
  initKeybindings();
});

beforeEach(() => {
  localStorage.clear();
  resetAllKeybindings();
  document.body.tabIndex = -1;
  document.body.focus();
});

afterEach(() => {
  for (const id of registered.splice(0)) CommandRegistry.unregister(id);
});

describe("Name Manager shortcut", () => {
  it("declares Ctrl+F3 as a built-in bound to the Name Manager command", () => {
    const binding = getAllKeybindings().find((b) => b.commandId === NAME_MANAGER_COMMAND);
    expect(binding).toBeDefined();
    expect(getEffectiveCombo(binding!.id)).toBe("Ctrl+F3");
    expect(binding!.source).toBe("built-in");
  });

  it("executes the Name Manager command on Ctrl+F3", async () => {
    const spy = spyCommand(NAME_MANAGER_COMMAND);
    const handled = handleGlobalKeyDown(keydown({ key: "F3", ctrlKey: true }));
    await Promise.resolve();
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("consumes the Ctrl+F3 event, so the dialog's ctrl-blind F3 handler cannot also fire", () => {
    spyCommand(NAME_MANAGER_COMMAND);
    const event = keydown({ key: "F3", ctrlKey: true });
    handleGlobalKeyDown(event);
    // preventDefault is the observable half of the same call that also does
    // stopPropagation; React's root-container listener never sees a stopped
    // capture-phase event.
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves BARE F3 to Find Next - nothing in the registry claims it", async () => {
    const spy = spyCommand(NAME_MANAGER_COMMAND);
    expect(findConflicts("F3")).toEqual([]);
    const event = keydown({ key: "F3" });
    expect(handleGlobalKeyDown(event)).toBe(false);
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not fire on Shift+F3 or Alt+F3 either", async () => {
    const spy = spyCommand(NAME_MANAGER_COMMAND);
    expect(handleGlobalKeyDown(keydown({ key: "F3", shiftKey: true }))).toBe(false);
    expect(handleGlobalKeyDown(keydown({ key: "F3", altKey: true }))).toBe(false);
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
  });
});
