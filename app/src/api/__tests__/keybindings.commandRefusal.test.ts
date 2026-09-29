//! FILENAME: app/src/api/__tests__/keybindings.commandRefusal.test.ts
// PURPOSE: A feature can REFUSE A COMMAND ID -- whatever combination the user
//          has it on -- and the refusal follows a remap in Settings.
// CONTEXT: BUG-0199 (K3). FloatingRange once refused the grid's
//          selection-acting keys by binding their DEFAULT combinations: a user
//          who moved Copy from Ctrl+C to Ctrl+Shift+Q copied Core's hidden cell
//          with the new key, while the old key -- no longer Copy -- showed a
//          refusal. `registerCommandRefusal` asks at the dispatcher's winner:
//          the command, not the keys. FloatingRange used it in wave B (E7) and
//          needs it no longer (W18, wave C): every command that acts on the
//          selection now asks the selection owner in its own door
//          (@api/selectionOwner). The seam stays for a feature whose "not now"
//          has no door of its own to live in -- Slicer and ControlsPane refuse
//          Undo/Redo with it while a gesture lands (@api/objectGeometry).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import {
  handleGlobalKeyDown,
  initKeybindings,
  registerCommandRefusal,
  setUserKeybinding,
  resetAllKeybindings,
} from "../keybindings";
import { CommandRegistry, setCommandRecorderHook } from "../commands";
import { registerToastSink, type ToastPayload } from "../notifications";

const copy = vi.fn();
const toasts: ToastPayload[] = [];
const cleanups: (() => void)[] = [];
let refusing = true;

beforeAll(() => {
  initKeybindings();
});

beforeEach(() => {
  copy.mockReset();
  toasts.length = 0;
  refusing = true;
  registerToastSink((t) => toasts.push(t));
  CommandRegistry.register("core.clipboard.copy", copy);
  resetAllKeybindings();
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  CommandRegistry.unregister("core.clipboard.copy");
  resetAllKeybindings();
  document.body.innerHTML = "";
});

function focusGrid(): void {
  const el = document.createElement("div");
  el.setAttribute("data-focus-container", "spreadsheet");
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
}

function press(init: KeyboardEventInit): { handled: boolean; event: KeyboardEvent } {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: document.activeElement ?? document.body });
  return { handled: handleGlobalKeyDown(event), event };
}

function refuseCopy(): void {
  cleanups.push(
    registerCommandRefusal({
      commandIds: ["core.clipboard.copy"],
      refuse: () => (refusing ? "Copy is not available for my object's cells yet." : null),
    }),
  );
}

describe("refusing a command id", () => {
  it("the bound key is refused: the command does not run, one sentence, the key is taken", async () => {
    refuseCopy();
    focusGrid();
    const { handled, event } = press({ key: "c", ctrlKey: true });
    await Promise.resolve();
    expect(copy, "the refused command ran").not.toHaveBeenCalled();
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(toasts.map((t) => t.message)).toEqual(["Copy is not available for my object's cells yet."]);
  });

  it("the refusal FOLLOWS A REMAP: the new key is refused, the old key is no longer the command's", async () => {
    refuseCopy();
    setUserKeybinding("core.copy", "Ctrl+Shift+Q");
    focusGrid();
    const moved = press({ key: "q", ctrlKey: true, shiftKey: true });
    await Promise.resolve();
    expect(copy, "a remapped Copy reached the command past the refusal").not.toHaveBeenCalled();
    expect(moved.handled).toBe(true);
    expect(toasts.length).toBe(1);
    const old = press({ key: "c", ctrlKey: true });
    expect(old.handled, "the old default is not Copy any more, so nothing refuses it").toBe(false);
    expect(old.event.defaultPrevented).toBe(false);
    expect(toasts.length).toBe(1);
  });

  it("no other window key listener acts on a refused key (an extension's own listener for it)", () => {
    refuseCopy();
    focusGrid();
    const other = vi.fn();
    window.addEventListener("keydown", other, true);
    cleanups.push(() => window.removeEventListener("keydown", other, true));
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(other).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it("a refusal that says null lets the command run", async () => {
    refuseCopy();
    refusing = false;
    focusGrid();
    press({ key: "c", ctrlKey: true });
    await Promise.resolve();
    expect(copy).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });

  it("a refusal that THROWS does not refuse (a broken extension cannot take a key away)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(
      registerCommandRefusal({
        commandIds: ["core.clipboard.copy"],
        refuse: () => {
          throw new Error("boom");
        },
      }),
    );
    focusGrid();
    press({ key: "c", ctrlKey: true });
    await Promise.resolve();
    expect(copy).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("the dispatcher's own rules still come first: a grid-scoped command off the grid is not matched, so native Ctrl+C is untouched", () => {
    refuseCopy();
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    const { handled, event } = press({ key: "c", ctrlKey: true });
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(toasts).toEqual([]);
  });

  it("the cleanup removes the refusal", async () => {
    refuseCopy();
    cleanups.pop()!();
    focusGrid();
    press({ key: "c", ctrlKey: true });
    await Promise.resolve();
    expect(copy).toHaveBeenCalledTimes(1);
  });
});

// Found live 2026-09-29 (e2e fixall-edit W15): only the KEYBOARD asked the
// refusals. Undo on the ribbon, the Edit menu or the Quick Access Toolbar goes
// through CommandRegistry.execute, and it reached the backend while a slicer
// click was still landing.
describe("every other door refuses too (CommandRegistry.execute)", () => {
  it("a refused command run by id runs nothing and says the sentence once per call", async () => {
    refuseCopy();
    await CommandRegistry.execute("core.clipboard.copy");
    expect(copy, "the ribbon/menu door ran a refused command").not.toHaveBeenCalled();
    expect(toasts.map((t) => t.message)).toEqual(["Copy is not available for my object's cells yet."]);
    await CommandRegistry.execute("core.clipboard.copy");
    expect(toasts.length).toBe(2);
  });

  it("a refused KEY still says it once: the dispatcher refuses it itself and never reaches execute", async () => {
    refuseCopy();
    focusGrid();
    press({ key: "c", ctrlKey: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(toasts.length).toBe(1);
  });

  it("a refusal that says null lets execute run the command", async () => {
    refuseCopy();
    refusing = false;
    await CommandRegistry.execute("core.clipboard.copy");
    expect(copy).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });

  it("a refused command inside another records nothing, so it cannot close the enclosing command's recorder scope", async () => {
    refuseCopy();
    const phases: string[] = [];
    setCommandRecorderHook((id, phase) => phases.push(`${id}:${phase}`));
    CommandRegistry.register("test.outer", async () => {
      await CommandRegistry.execute("core.clipboard.copy");
    });
    try {
      await CommandRegistry.execute("test.outer");
    } finally {
      setCommandRecorderHook(null);
      CommandRegistry.unregister("test.outer");
    }
    expect(phases).toEqual(["test.outer:before", "test.outer:after"]);
    expect(copy).not.toHaveBeenCalled();
  });
});
