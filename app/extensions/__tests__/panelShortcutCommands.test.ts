//! FILENAME: app/extensions/__tests__/panelShortcutCommands.test.ts
// PURPOSE: The five built-in shortcuts that named commands NOTHING registered
//          -- Ctrl+Shift+H (Search), Ctrl+Shift+E (File Explorer), Ctrl+Shift+X
//          (Extensions), Ctrl+P (Print), Ctrl+Shift+N (Notebook) -- run EXACTLY
//          ONCE through a REGISTERED command, and a remap in Settings MOVES
//          them (the new key runs it, the old key no longer does).
// CONTEXT: D2 (wave B; BUG-0183 class). The registry's built-ins named
//          search.openFindReplace, fileExplorer.toggle, extensionsManager.toggle,
//          print.preview and scriptNotebook.toggle; the dispatcher matched the
//          key, took it and executed nothing, and the key "worked" only
//          because each extension ran its own hard-coded window listener beside
//          it -- which a remap could never take away. Driven through the REAL
//          dispatcher (initKeybindings) and the REAL extensions' activation;
//          only the final actions are doubled, so each press can be counted.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const h = vi.hoisted(() => {
  const effects: string[] = [];
  return {
    effects,
    effect: (name: string) => {
      effects.push(name);
    },
  };
});

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface: "grid" }),
}));
// Print's first act is the Before-Print verdict: that call is the witness, and
// answering "cancelled" keeps the print window from opening.
vi.mock("@api/lifecycleGuards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/lifecycleGuards")>()),
  checkLifecycleGuards: vi.fn(async () => {
    h.effect("print");
    return true;
  }),
}));

import { CommandRegistry } from "@api/commands";
import {
  initKeybindings,
  getKeybinding,
  setUserKeybinding,
  resetAllKeybindings,
} from "@api/keybindings";
import type { ExtensionModule } from "@api/contract";
import SearchExtension from "../Search";
import FileExplorerExtension from "../FileExplorer";
import ExtensionsManagerExtension from "../ExtensionsManager";
import PrintExtension from "../Print";
import ScriptNotebookExtension from "../ScriptNotebook";

const EXTENSIONS: ExtensionModule[] = [
  SearchExtension,
  FileExplorerExtension,
  ExtensionsManagerExtension,
  PrintExtension,
  ScriptNotebookExtension,
];

/**
 * A context whose every door is inert, except `commands` (REAL) and the
 * Activity Bar's toggle, which records the view it toggled.
 */
function context(): never {
  const inert = (path: string): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => {
        if (prop === "then") return undefined;
        if (path === "" && prop === "commands") {
          return {
            register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
              CommandRegistry.register(id, fn, opts as never),
            unregister: (id: string) => CommandRegistry.unregister(id),
            execute: (id: string, args?: unknown) => CommandRegistry.execute(id, args),
          };
        }
        return inert(`${path}.${String(prop)}`);
      },
      apply: (_t, _this, args: unknown[]) => {
        if (path === ".ui.activityBar.toggle") h.effect(`toggle:${String(args[0])}`);
        if (path === ".invokeBackend") return Promise.resolve(null);
        return () => {};
      },
    });
  return inert("") as never;
}

/** [binding id, default keydown, a remap target combo + keydown, the effect] */
const SHORTCUTS: [string, KeyboardEventInit, string, KeyboardEventInit, string][] = [
  ["ext.search.findReplace", { key: "H", ctrlKey: true, shiftKey: true }, "Ctrl+Alt+Shift+1", { key: "1", ctrlKey: true, altKey: true, shiftKey: true }, "toggle:search"],
  ["ext.fileExplorer.toggle", { key: "E", ctrlKey: true, shiftKey: true }, "Ctrl+Alt+Shift+2", { key: "2", ctrlKey: true, altKey: true, shiftKey: true }, "toggle:explorer"],
  ["ext.extensionsManager.toggle", { key: "X", ctrlKey: true, shiftKey: true }, "Ctrl+Alt+Shift+3", { key: "3", ctrlKey: true, altKey: true, shiftKey: true }, "toggle:extensions"],
  ["ext.print", { key: "p", ctrlKey: true }, "Ctrl+Alt+Shift+4", { key: "4", ctrlKey: true, altKey: true, shiftKey: true }, "print"],
  ["ext.scriptNotebook.toggle", { key: "N", ctrlKey: true, shiftKey: true }, "Ctrl+Alt+Shift+5", { key: "5", ctrlKey: true, altKey: true, shiftKey: true }, "toggle:script-notebook"],
];

async function press(init: KeyboardEventInit): Promise<KeyboardEvent> {
  const target = document.activeElement ?? document.body;
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  return e;
}

beforeAll(async () => {
  initKeybindings();
  for (const ext of EXTENSIONS) await ext.activate(context());
});

afterAll(async () => {
  for (const ext of EXTENSIONS) await ext.deactivate?.();
});

beforeEach(() => {
  resetAllKeybindings();
  h.effects.length = 0;
  document.body.innerHTML = "";
  const button = document.createElement("button");
  document.body.appendChild(button);
  button.focus();
});

describe("the five panel/print shortcuts are REGISTERED commands", () => {
  for (const [id] of SHORTCUTS) {
    it(`${id}: the command its binding names is registered`, () => {
      const binding = getKeybinding(id);
      expect(binding, `${id} is not a registry binding`).toBeDefined();
      expect(
        CommandRegistry.has(binding!.commandId),
        `${id} points at '${binding!.commandId}', which nothing registers`,
      ).toBe(true);
    });
  }
});

describe("the default key runs it exactly once", () => {
  for (const [id, init, , , effect] of SHORTCUTS) {
    it(`${id}: one ${effect}`, async () => {
      const e = await press(init);
      expect(h.effects, `${id} did not run exactly once`).toEqual([effect]);
      expect(e.defaultPrevented, "the browser's own action for the key was not suppressed").toBe(true);
    });
  }

  it("they are app-global (the Ctrl+S class): Ctrl+Shift+H still toggles Search with a text field focused", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await press({ key: "H", ctrlKey: true, shiftKey: true });
    expect(h.effects).toEqual(["toggle:search"]);
  });
});

describe("a remap in Settings MOVES the shortcut", () => {
  for (const [id, init, combo, remapped, effect] of SHORTCUTS) {
    it(`${id}: the old key does nothing, the new key (${combo}) runs it once`, async () => {
      setUserKeybinding(id, combo);
      await press(init);
      expect(h.effects, `the old key still ran ${id} after a remap`).toEqual([]);
      await press(remapped);
      expect(h.effects).toEqual([effect]);
    });
  }
});

describe("deactivation takes the commands away", () => {
  it("each extension unregisters the command it registered", async () => {
    const ids = SHORTCUTS.map(([id]) => getKeybinding(id)!.commandId);
    for (const ext of EXTENSIONS) await ext.deactivate?.();
    try {
      expect(ids.filter((c) => CommandRegistry.has(c))).toEqual([]);
    } finally {
      for (const ext of EXTENSIONS) await ext.activate(context());
    }
  });
});
