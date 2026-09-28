//! FILENAME: app/src/api/__tests__/keybindings.exclusive.test.ts
// PURPOSE: `KeyBinding.exclusive`: when an exclusive binding wins a keystroke,
//          no other keydown listener hears it -- not even one on `window`'s
//          capture phase, the dispatcher's own target and phase, where
//          `stopPropagation` does not reach.
// CONTEXT: Several extensions act on their own shortcut from a window-capture
//          listener of their own (Hyperlinks Ctrl+K, Flash Fill Ctrl+E,
//          Grouping Alt+Shift+Arrow, AutoFilter Ctrl+Shift+L, Review Ctrl+Alt+M).
//          A floating grid's REFUSAL binding for Ctrl+K (its selected cell
//          leaves Core's active cell hidden underneath) showed its sentence and
//          then Hyperlinks inserted the link into the hidden cell anyway.
//          Round 3 of the canvas-sheet fixes, 2026-09-28.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initKeybindings, registerKeybinding } from "../keybindings";
import { CommandRegistry } from "../commands";

// The shell's order: the dispatcher's window-capture listener is installed at
// bootstrap, BEFORE any extension adds its own.
initKeybindings();

let container: HTMLElement;
let late: ReturnType<typeof vi.fn>;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = 0;
  document.body.appendChild(container);
  container.focus();
  late = vi.fn();
  window.addEventListener("keydown", late as unknown as EventListener, true);
});

afterEach(() => {
  window.removeEventListener("keydown", late as unknown as EventListener, true);
  while (cleanups.length) cleanups.pop()!();
  container.remove();
});

function bind(id: string, exclusive: boolean): ReturnType<typeof vi.fn> {
  const run = vi.fn();
  CommandRegistry.register(`test.${id}`, run);
  cleanups.push(() => CommandRegistry.unregister(`test.${id}`));
  cleanups.push(
    registerKeybinding(
      {
        id: `test.${id}`,
        combo: "Ctrl+Alt+Shift+F12",
        commandId: `test.${id}`,
        label: id,
        category: "Test",
        context: "not-editing",
        source: "extension",
        extensionId: "test",
        exclusive,
      },
      () => true,
    ),
  );
  return run;
}

function press(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key: "F12",
    ctrlKey: true,
    altKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  container.dispatchEvent(e);
  return e;
}

describe("an EXCLUSIVE winning binding silences every other keydown listener", () => {
  it("the binding runs, and a later window-capture listener never hears the key", async () => {
    const run = bind("exclusive", true);
    const e = press();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("control: an ordinary winning binding still leaves a same-phase window listener running (stopPropagation cannot reach it)", async () => {
    const run = bind("ordinary", false);
    press();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
  });
});
