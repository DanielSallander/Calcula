//! FILENAME: app/src/api/__tests__/keybindings.externalEdit.test.ts
// PURPOSE: While an EXTERNAL edit session is live (a floating grid's cell edit,
//          hosted by the formula bar or parked on another sheet while it picks
//          a reference), the keyboard dispatcher must not run grid actions or
//          workbook undo -- even with the keyboard on the grid's own container.
//
// CONTEXT: `handleGlobalKeyDown` is capture-phase on `window`: it runs before
//          the two Core doors that route a live session's keys (useGridKeyboard's
//          gate and the container's fallback branch in useSpreadsheetEditing)
//          and stopPropagation()s on a match. It knew nothing about the
//          session, so with the grid container focused during a live session --
//          parked with the formula bar hidden, or after a right-press on an
//          object during a bar-hosted edit -- Delete ran
//          core.edit.clearContents over the VIEWED sheet's selection, Ctrl+V
//          pasted into it and Ctrl+Z undid a workbook action, all while the
//          formula edit stayed open. The Core doors' own unit tests fire keys
//          straight at the doors and never see this dispatcher.
//
//          THE POSITIVE CONTROLS MATTER AS MUCH AS THE REFUSALS: the same keys
//          still dispatch with no session, and truly global shortcuts (Ctrl+S)
//          still fire during one.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  handleGlobalKeyDown,
  initKeybindings,
  registerKeybinding,
  resetAllKeybindings,
} from "../keybindings";
import { CommandRegistry } from "../commands";
import {
  __resetExternalEditForTests,
  setExternalSessionParked,
} from "../../core/lib/formulaEditTarget";
import {
  createFakeExternalEdit,
  type FakeExternalEdit,
} from "../../core/lib/__tests__/helpers/fakeExternalEdit";

let container: HTMLElement;
let fake: FakeExternalEdit;

const registered: string[] = [];
function spyCommand(commandId: string) {
  const spy = vi.fn();
  CommandRegistry.register(commandId, spy);
  registered.push(commandId);
  return spy;
}

/** A keydown whose `target` is the container, WITHOUT dispatching it (the
 *  window listener installed by initKeybindings would otherwise fire twice). */
function keyOnContainer(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(ev, "target", { value: container, configurable: true });
  return ev;
}

/** Drive the real dispatcher with the grid container focused. */
async function press(
  init: KeyboardEventInit,
  commandId: string,
): Promise<{ handled: boolean; executed: boolean; prevented: boolean }> {
  const spy = spyCommand(commandId);
  container.focus();
  const ev = keyOnContainer(init);
  const handled = handleGlobalKeyDown(ev);
  await Promise.resolve();
  return { handled, executed: spy.mock.calls.length > 0, prevented: ev.defaultPrevented };
}

const DELETE = { key: "Delete" } as const;
const CTRL_V = { key: "v", ctrlKey: true } as const;
const CTRL_X = { key: "x", ctrlKey: true } as const;
const CTRL_D = { key: "d", ctrlKey: true } as const;
const CTRL_Z = { key: "z", ctrlKey: true } as const;
const CTRL_Y = { key: "y", ctrlKey: true } as const;
const CTRL_1 = { key: "1", ctrlKey: true } as const;
const CTRL_S = { key: "s", ctrlKey: true } as const;

beforeAll(() => {
  initKeybindings();
});

beforeEach(() => {
  localStorage.clear();
  resetAllKeybindings();
  __resetExternalEditForTests();
  container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = 0;
  document.body.appendChild(container);
  fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=Sheet1!E2" });
});

afterEach(() => {
  for (const id of registered.splice(0)) CommandRegistry.unregister(id);
  __resetExternalEditForTests();
  container.remove();
  document.body.tabIndex = -1;
  document.body.focus();
  vi.restoreAllMocks();
});

describe("a live external session: the grid is not the keyboard's target", () => {
  it.each([
    ["Delete", DELETE, "core.edit.clearContents"],
    ["Ctrl+V", CTRL_V, "core.clipboard.paste"],
    ["Ctrl+X", CTRL_X, "core.clipboard.cut"],
    ["Ctrl+D", CTRL_D, "core.edit.fillDown"],
    ["Ctrl+1", CTRL_1, "core.format.cells"],
  ])("%s with the grid container focused runs no grid action and does not preventDefault", async (_l, init, commandId) => {
    fake.register();
    const r = await press(init, commandId);
    expect(r.executed).toBe(false);
    expect(r.handled).toBe(false);
    expect(r.prevented).toBe(false);
  });

  it.each([
    ["Ctrl+Z", CTRL_Z, "core.edit.undo"],
    ["Ctrl+Y", CTRL_Y, "core.edit.redo"],
  ])("%s does not undo/redo a WORKBOOK action while the formula edit is open", async (_l, init, commandId) => {
    fake.register();
    const r = await press(init, commandId);
    expect(r.executed).toBe(false);
    expect(r.prevented).toBe(false);
  });

  it("a PARKED session is refused the same way (the formula-bar-hidden fallback state)", async () => {
    fake.register();
    setExternalSessionParked(0);
    const r = await press(DELETE, "core.edit.clearContents");
    expect(r.executed).toBe(false);
    expect(r.prevented).toBe(false);
  });

  it("a guarded extension binding (Charts'/Controls' Delete shape: not-editing + when) is refused too", async () => {
    const spy = spyCommand("test.object.delete");
    const off = registerKeybinding(
      {
        id: "test.object.delete",
        combo: "Delete",
        commandId: "test.object.delete",
        label: "Delete object",
        category: "Editing",
        context: "not-editing",
        source: "extension",
      },
      () => true,
    );
    try {
      fake.register();
      container.focus();
      const ev = keyOnContainer(DELETE);
      expect(handleGlobalKeyDown(ev)).toBe(false);
      await Promise.resolve();
      expect(spy).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
    } finally {
      off();
    }
  });

  it("the refused key FALLS THROUGH to the container's own listeners (the Core doors that route it to the session)", async () => {
    // Through the REAL window capture listener installed by initKeybindings.
    const clear = spyCommand("core.edit.clearContents");
    const reached = vi.fn();
    container.addEventListener("keydown", reached);
    try {
      fake.register();
      container.focus();
      const ev = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
      container.dispatchEvent(ev);
      await Promise.resolve();
      expect(clear).not.toHaveBeenCalled();
      expect(reached).toHaveBeenCalledTimes(1);
      expect(ev.defaultPrevented).toBe(false);

      // Control: with the session ended the dispatcher takes Delete again and
      // stops it before the container ever sees it.
      fake.session.cancel();
      const again = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
      container.dispatchEvent(again);
      await Promise.resolve();
      expect(clear).toHaveBeenCalledTimes(1);
      expect(reached).toHaveBeenCalledTimes(1);
      expect(again.defaultPrevented).toBe(true);
    } finally {
      container.removeEventListener("keydown", reached);
    }
  });
});

describe("the controls: no session, and the truly global shortcuts", () => {
  it.each([
    ["Delete", DELETE, "core.edit.clearContents"],
    ["Ctrl+V", CTRL_V, "core.clipboard.paste"],
    ["Ctrl+Z", CTRL_Z, "core.edit.undo"],
  ])("%s dispatches normally with the grid focused and NO session", async (_l, init, commandId) => {
    const r = await press(init, commandId);
    expect(r.executed).toBe(true);
    expect(r.handled).toBe(true);
    expect(r.prevented).toBe(true);
  });

  it("Ctrl+S still saves during a live session (a blanket refusal would break it)", async () => {
    fake.register();
    const r = await press(CTRL_S, "core.file.save");
    expect(r.executed).toBe(true);
    expect(r.prevented).toBe(true);
  });
});
