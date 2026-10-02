//! FILENAME: app/src/api/__tests__/keybindings.heldCellPress.test.ts
// PURPOSE: While Core's cell press session holds a CLAIMED press (an in-cell
//          button or a pivot +/- that acts on its release), Escape is the
//          press's: it cancels the press, and the keybinding dispatcher does not
//          ALSO act on it.
// CONTEXT: The dispatcher is a window-CAPTURE listener installed at startup, so
//          it runs before the session's own window-capture listener (added at
//          the press), and it stops propagation without stopping the same-phase
//          listeners -- so both acted. Reachable: BUG-0270's
//          `ext.objectPosition.deselect` is bound to Escape, and a claimed cell
//          press never deselects a selected chart (it never reaches the grid's
//          own press), so holding an in-cell button and pressing Escape both
//          cancelled the press AND deselected the chart. The dispatcher now
//          leaves Escape alone while a press is HELD (armed by a claim); before
//          the claim arrives nobody owns the press, and Escape goes on to its
//          owner as before.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initKeybindings, registerKeybinding } from "../keybindings";
import { CommandRegistry } from "../commands";
import { actOnCellRelease } from "../../core/lib/cellClickInterceptors";
import { cancelCellPress, isCellPressHeld, openCellPress, type CellPressDeps } from "../../core/lib/cellPressRelease";

// The shell's order: the dispatcher's window-capture listener is installed at
// bootstrap, BEFORE any press session adds its own.
initKeybindings();

/** A fake grid: 100 x 20 px cells from the client origin. */
const deps: CellPressDeps = {
  cellAt: (sample) => ({ row: Math.floor(sample.clientY / 20), col: Math.floor(sample.clientX / 100) }),
  sheetKey: () => "0",
  redraw: () => {},
};

let container: HTMLElement;
let deselect: ReturnType<typeof vi.fn>;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  cancelCellPress();
  container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = 0;
  document.body.appendChild(container);
  container.focus();
  // An Escape binding like BUG-0270's object deselect: not exclusive, applies.
  deselect = vi.fn();
  CommandRegistry.register("test.deselectObject", deselect);
  cleanups.push(() => CommandRegistry.unregister("test.deselectObject"));
  cleanups.push(
    registerKeybinding(
      {
        id: "test.deselectObject",
        combo: "Escape",
        commandId: "test.deselectObject",
        label: "Deselect Object",
        category: "Editing",
        context: "not-editing",
        source: "extension",
        extensionId: "test",
      },
      () => true,
    ),
  );
});

afterEach(() => {
  cancelCellPress();
  while (cleanups.length) cleanups.pop()!();
  container.remove();
});

function escape(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  container.dispatchEvent(e);
  return e;
}

/** A primary press on the button cell C2 (row 1, col 2), held by its claim. */
function holdButtonPress(): ReturnType<typeof vi.fn> {
  const run = vi.fn();
  const press = openCellPress({ clientX: 250, clientY: 30, button: 0, target: null }, deps);
  press.settle(actOnCellRelease(1, 2, run, { pressedLook: true }));
  return run;
}

describe("Escape while a claimed cell press is held is the press's alone", () => {
  // SABOTAGE: drop the held-press early return from handleGlobalKeyDown
  // (keybindings.ts) -> the binding runs too, red.
  it("cancels the press, and the dispatcher's Escape binding does NOT also run", async () => {
    const run = holdButtonPress();
    expect(isCellPressHeld()).toBe(true);
    const e = escape();
    await Promise.resolve();
    expect(isCellPressHeld(), "Escape did not cancel the held press").toBe(false);
    expect(deselect, "one Escape also deselected the object").not.toHaveBeenCalled();
    expect(e.defaultPrevented, "the press consumed its Escape").toBe(true);
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 250, clientY: 30, button: 0, buttons: 0 }));
    expect(run, "the cancelled press ran at its release").not.toHaveBeenCalled();
  });

  it("control: with no press held, the same Escape runs the binding", async () => {
    escape();
    await Promise.resolve();
    expect(deselect).toHaveBeenCalledTimes(1);
  });

  it("before the claim arrives nobody owns the press: Escape cancels it AND reaches the binding", async () => {
    const press = openCellPress({ clientX: 250, clientY: 30, button: 0, target: null }, deps);
    escape();
    await Promise.resolve();
    expect(deselect).toHaveBeenCalledTimes(1);
    const run = vi.fn();
    press.settle(actOnCellRelease(1, 2, run, { pressedLook: true }));
    expect(isCellPressHeld(), "a press Escape cancelled was armed by a late claim").toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
