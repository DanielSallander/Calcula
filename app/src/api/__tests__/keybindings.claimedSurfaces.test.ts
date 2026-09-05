//! FILENAME: app/src/api/__tests__/keybindings.claimedSurfaces.test.ts
// PURPOSE: The keyboard dispatcher must honour a POINTER CLAIM, and must honour
//          it in three different ways depending on what the binding says about
//          itself.
//
// CONTEXT: M3 put two surfaces INSIDE the grid's own DOM subtree — a shape's
//          declared hit rectangles and a form the user places on a sheet. Core
//          honours the claim at three doors (mousedown, dblclick, both key
//          handlers), but `handleGlobalKeyDown` is a CAPTURE-phase listener on
//          `window`: the outermost position there is. It runs before every one
//          of those doors and calls preventDefault()+stopPropagation(), so its
//          answer is final.
//
//          Measured against this same real dispatcher and the real
//          DEFAULT_KEYBINDINGS, with a card carrying `data-pointer-claim` inside
//          `[data-focus-container="spreadsheet"]`:
//            - Delete with a <select> focused -> ["core.edit.clearContents"],
//              defaultPrevented: true. The user's selected CELLS were cleared.
//            - Delete with a <button> focused -> the same.
//            - Ctrl+V inside a claimed plain <input> -> ["core.clipboard.paste"]
//              and the native paste into the field was cancelled.
//            - Ctrl+Z with a form button focused -> core.edit.undo.
//
//          Two questions answered wrongly. `isGridFocused()` is
//          `activeElement.closest('[data-focus-container="spreadsheet"]')`, and
//          that attribute is on the container every on-grid card lives inside.
//          `isEditing()` is the very tag list whose incompleteness caused the
//          Core defect — <select> and <button> are "not editing", so
//          context:"not-editing" bindings matched.
//
//          THE POSITIVE CONTROL MATTERS AS MUCH AS THE REFUSALS. A blanket "a
//          claim swallows every shortcut" would break Ctrl+S, so this file
//          asserts Save still fires from inside a claim, and that every refused
//          combination still behaves normally with focus genuinely in the grid.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { handleGlobalKeyDown, initKeybindings, resetAllKeybindings } from "../keybindings";
import { CommandRegistry } from "../commands";
import { POINTER_CLAIM_ATTR } from "../pointerClaims";

// ---------------------------------------------------------------------------
// The real on-grid shape: a claimed card INSIDE the spreadsheet focus container
// ---------------------------------------------------------------------------

interface Fixture {
  container: HTMLElement;
  card: HTMLElement;
  select: HTMLSelectElement;
  button: HTMLButtonElement;
  input: HTMLInputElement;
}

let fixture: Fixture;

function buildFixture(): Fixture {
  const container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = -1;

  const card = document.createElement("div");
  card.setAttribute(POINTER_CLAIM_ATTR, "form:card-1");

  const select = document.createElement("select");
  const opt = document.createElement("option");
  opt.value = "a";
  select.appendChild(opt);

  const button = document.createElement("button");
  button.type = "button";

  const input = document.createElement("input");
  input.type = "text";

  card.append(select, button, input);
  container.appendChild(card);
  document.body.appendChild(container);
  return { container, card, select, button, input };
}

/** A keydown whose `target` is `el`, WITHOUT dispatching it (the window
 *  listener installed by initKeybindings would otherwise fire a second time). */
function keyOn(el: Element, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(ev, "target", { value: el, configurable: true });
  return ev;
}

const registered: string[] = [];
function spyCommand(commandId: string) {
  const spy = vi.fn();
  CommandRegistry.register(commandId, spy);
  registered.push(commandId);
  return spy;
}

/** Drive the real dispatcher and report everything the caller needs to judge. */
async function press(
  target: HTMLElement,
  init: KeyboardEventInit,
  commandId: string,
): Promise<{ handled: boolean; executed: boolean; prevented: boolean }> {
  const spy = spyCommand(commandId);
  target.focus();
  const ev = keyOn(target, init);
  const pd = vi.spyOn(ev, "preventDefault");
  const handled = handleGlobalKeyDown(ev);
  await Promise.resolve();
  return { handled, executed: spy.mock.calls.length > 0, prevented: pd.mock.calls.length > 0 };
}

const DELETE = { key: "Delete" } as const;
const CTRL_Z = { key: "z", ctrlKey: true } as const;
const CTRL_V = { key: "v", ctrlKey: true } as const;
const CTRL_S = { key: "s", ctrlKey: true } as const;

beforeAll(() => {
  initKeybindings();
});

beforeEach(() => {
  localStorage.clear();
  resetAllKeybindings();
  fixture = buildFixture();
});

afterEach(() => {
  for (const id of registered.splice(0)) CommandRegistry.unregister(id);
  fixture.container.remove();
  document.body.tabIndex = -1;
  document.body.focus();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GRID-SCOPED bindings are refused inside a claim
// ---------------------------------------------------------------------------

describe("a claimed surface is not the grid — grid-scoped commands", () => {
  it("Delete with a claimed <select> focused does NOT clear the sheet's cells", async () => {
    const r = await press(fixture.select, DELETE, "core.edit.clearContents");
    expect(r.executed).toBe(false);
    expect(r.handled).toBe(false);
    expect(r.prevented).toBe(false);
  });

  it("Delete with a claimed <button> focused does NOT clear the sheet's cells", async () => {
    const r = await press(fixture.button, DELETE, "core.edit.clearContents");
    expect(r.executed).toBe(false);
    expect(r.prevented).toBe(false);
  });

  it("Ctrl+V inside a claimed <input> does NOT paste into the sheet, and does NOT preventDefault", async () => {
    // The `prevented` half is the whole point: the native paste into the field
    // is what the user asked for, and cancelling it is how even the text control
    // Core's own tag list certifies as working was broken here.
    const r = await press(fixture.input, CTRL_V, "core.clipboard.paste");
    expect(r.executed).toBe(false);
    expect(r.prevented).toBe(false);
  });

  it("the CLAIM is what refuses it — the same DOM without the attribute clears the cells", async () => {
    // Isolates the cause. Focus is inside `[data-focus-container="spreadsheet"]`
    // in BOTH cases, so this cannot pass by accident of focus scoping.
    fixture.card.removeAttribute(POINTER_CLAIM_ATTR);
    const r = await press(fixture.select, DELETE, "core.edit.clearContents");
    expect(r.executed).toBe(true);
    expect(r.prevented).toBe(true);
  });

  it("a claim on the event TARGET refuses even when activeElement is elsewhere", async () => {
    const spy = spyCommand("core.edit.clearContents");
    document.body.tabIndex = -1;
    document.body.focus();
    const ev = keyOn(fixture.select, DELETE);
    expect(handleGlobalKeyDown(ev)).toBe(false);
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// EDITING-SENSITIVE bindings (context: "not-editing") are refused inside a claim
// ---------------------------------------------------------------------------

describe("a claimed surface owns its own undo — editing-sensitive commands", () => {
  it("Ctrl+Z with a claimed form <button> focused does NOT undo the workbook", async () => {
    const r = await press(fixture.button, CTRL_Z, "core.edit.undo");
    expect(r.executed).toBe(false);
    expect(r.prevented).toBe(false);
  });

  it("Ctrl+Z inside a claimed <select> does NOT undo the workbook", async () => {
    const r = await press(fixture.select, CTRL_Z, "core.edit.undo");
    expect(r.executed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TRULY GLOBAL bindings still fire — the control that stops an over-broad guard
// ---------------------------------------------------------------------------

describe("a claim does not swallow an app-global shortcut", () => {
  it("Ctrl+S saves from inside a claimed <input>", async () => {
    const r = await press(fixture.input, CTRL_S, "core.file.save");
    expect(r.executed).toBe(true);
    expect(r.handled).toBe(true);
  });

  it("Ctrl+S saves from inside a claimed <button>", async () => {
    const r = await press(fixture.button, CTRL_S, "core.file.save");
    expect(r.executed).toBe(true);
  });

  it("Ctrl+F still opens Find from inside a claim", async () => {
    const r = await press(fixture.select, { key: "f", ctrlKey: true }, "core.edit.find");
    expect(r.executed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ...and nothing changed with focus genuinely in the grid
// ---------------------------------------------------------------------------

describe("focus genuinely in the grid — every one of those still behaves normally", () => {
  it.each([
    ["Delete", DELETE, "core.edit.clearContents"],
    ["Ctrl+Z", CTRL_Z, "core.edit.undo"],
    ["Ctrl+V", CTRL_V, "core.clipboard.paste"],
    ["Ctrl+S", CTRL_S, "core.file.save"],
  ])("%s executes %s", async (_label, init, commandId) => {
    const r = await press(fixture.container, init as KeyboardEventInit, commandId);
    expect(r.executed).toBe(true);
    expect(r.handled).toBe(true);
    expect(r.prevented).toBe(true);
  });
});
