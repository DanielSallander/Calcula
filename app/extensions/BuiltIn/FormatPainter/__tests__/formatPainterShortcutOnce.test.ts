//! FILENAME: app/extensions/BuiltIn/FormatPainter/__tests__/formatPainterShortcutOnce.test.ts
// PURPOSE: Ctrl+Shift+C starts Format Painter EXACTLY ONCE, through the
//          registry's binding -- wherever the keyboard is that is not an edit --
//          and a user's remap moves it (the old key no longer starts it).
// CONTEXT: BUG-0199 (K3). The registry bound Ctrl+Shift+C to
//          `core.format.painter` (grid-scoped) AND the extension ran the same
//          command from its own window-capture listener. With the grid focused
//          both fired: two captures of the source, two sets of listeners, the
//          painter "started twice". Off the grid only the listener fired, so
//          the painter also could not be remapped. Driven through the REAL
//          dispatcher (initKeybindings) and the real command registry; only
//          the painter logic is doubled.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const activate = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../formatPainterLogic", () => ({
  activateFormatPainter: (...a: unknown[]) => activate(...a),
  deactivateFormatPainter: vi.fn(),
}));
vi.mock("../formatPainterState", () => ({ isFormatPainterActive: () => false }));
vi.mock("@api/ui", () => ({ registerMenuItem: vi.fn(), unregisterMenuItem: vi.fn() }));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export name
  ExtensionRegistry: { onSelectionChange: () => () => {} },
}));

import extension from "../index";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { initKeybindings, setUserKeybinding, resetUserKeybinding } from "@api/keybindings";
import { setGlobalIsEditing } from "@api/editing";

function stubContext(): never {
  return {
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn),
      unregister: (id: string) => CommandRegistry.unregister(id),
      execute: (id: string) => CommandRegistry.execute(id),
    },
  } as never;
}
function focus(el: HTMLElement): HTMLElement {
  document.body.appendChild(el);
  el.focus();
  return el;
}
function gridContainer(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-focus-container", "spreadsheet");
  el.tabIndex = 0;
  return el;
}
async function press(init: KeyboardEventInit): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  await Promise.resolve();
  await Promise.resolve();
  return e;
}
const CTRL_SHIFT_C = { key: "C", ctrlKey: true, shiftKey: true };

beforeAll(() => {
  initKeybindings();
});
beforeEach(() => {
  activate.mockClear();
  extension.activate(stubContext());
});
afterEach(() => {
  extension.deactivate();
  CommandRegistry.unregister(CoreCommands.FORMAT_PAINTER);
  CommandRegistry.unregister(CoreCommands.FORMAT_PAINTER_LOCK);
  resetUserKeybinding("core.formatPainter");
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("Ctrl+Shift+C starts Format Painter once", () => {
  it("grid focused: ONE start (the binding and the extension's own listener used to both fire)", async () => {
    focus(gridContainer());
    const e = await press(CTRL_SHIFT_C);
    expect(activate, "Format Painter started more than once for one keystroke").toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("a ribbon button focused (not a text field): still one start", async () => {
    focus(document.createElement("button"));
    await press(CTRL_SHIFT_C);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("in a text field it does not start (native key), and the key is not taken", async () => {
    focus(document.createElement("input"));
    const e = await press(CTRL_SHIFT_C);
    expect(activate).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("during Core's own cell edit it does not start", async () => {
    setGlobalIsEditing(true);
    focus(document.createElement("textarea"));
    await press(CTRL_SHIFT_C);
    expect(activate).not.toHaveBeenCalled();
  });

  it("a remap MOVES it: the new key starts it once, the old key no longer does", async () => {
    setUserKeybinding("core.formatPainter", "Ctrl+Alt+P");
    focus(gridContainer());
    await press(CTRL_SHIFT_C);
    expect(activate, "the old default still started the painter after a remap").not.toHaveBeenCalled();
    await press({ key: "p", ctrlKey: true, altKey: true });
    expect(activate).toHaveBeenCalledTimes(1);
  });
});
