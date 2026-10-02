//! FILENAME: app/src/api/__tests__/keybindings.spaceAndPlus.test.ts
// PURPOSE: Space and "+" are keys a shortcut can be RECORDED on, so they must be
//          keys a shortcut can FIRE on -- and the Settings conflict check must
//          not present the grid's own Space keys as free (M8 S9).
// CONTEXT: The combo grammar splits on "+" and TRIMS every part. A keystroke on
//          the space bar (event.key " ") was recorded by eventToCombo as
//          "Ctrl+ ", which parses to an EMPTY key; "+" was recorded as
//          "Ctrl++", which splits to ["Ctrl", "", ""] -- an empty key again.
//          Settings saved either combination and neither ever fired. The fix
//          gives the two keys NAMES ("Space", "Plus"): eventToCombo writes the
//          name, parseCombo canonicalises it (and reads a literal "Ctrl++" as
//          Plus), and the matchers compare the keystroke's " " / "+" against
//          the name's character -- "+" before the SYMBOL tier reads it, because
//          "+" is a layout symbol (US types it with Shift). Space stays out of
//          the tolerant tiers: whitespace is not a layout symbol and the
//          physical-key tier takes only letters and digits.
//
//          The grid answers Space, Shift+Space, Ctrl+Space and Ctrl+Shift+Space
//          itself (core/hooks/useGridKeyboard.ts, the Spacebar block) and the
//          registry holds none of them. The dispatcher is a window-capture
//          listener, so a user's binding on one now takes the key before the
//          grid -- the user's choice -- but findConflicts, which Settings reads,
//          must name the grid's key rather than call the combination free. With
//          nothing bound, the keystroke must still reach the grid untouched.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  addCustomKeybinding,
  eventToCombo,
  findConflicts,
  formatCombo,
  getAllKeybindings,
  getEffectiveCombo,
  handleGlobalKeyDown,
  initKeybindings,
  isListedKeybinding,
  matchesEvent,
  matchesEventOnLayout,
  matchesEventOnPhysicalKey,
  parseCombo,
  registerKeybinding,
  removeCustomKeybinding,
  resetAllKeybindings,
  setUserKeybinding,
} from "../keybindings";
import { CommandRegistry } from "../commands";

const ran: string[] = [];
const COMMANDS = ["test.space", "test.plus", "test.shiftPlus", "hyperlinks.insert"];
const cleanups: (() => void)[] = [];

beforeAll(() => {
  initKeybindings();
});

beforeEach(() => {
  ran.length = 0;
  localStorage.clear();
  resetAllKeybindings();
  for (const id of COMMANDS) CommandRegistry.register(id, () => void ran.push(id));
  focusGrid();
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  for (const id of COMMANDS) CommandRegistry.unregister(id);
  for (const b of getAllKeybindings()) if (b.source === "user") removeCustomKeybinding(b.id);
  resetAllKeybindings();
  document.body.innerHTML = "";
});

/** The grid container has the keyboard (isGridFocused). */
function focusGrid(): void {
  const el = document.createElement("div");
  el.setAttribute("data-focus-container", "spreadsheet");
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
}

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

/** One keystroke through the REAL dispatcher (handleGlobalKeyDown). */
async function press(init: KeyboardEventInit): Promise<{ handled: boolean; event: KeyboardEvent }> {
  const event = key(init);
  Object.defineProperty(event, "target", { value: document.activeElement ?? document.body });
  const handled = handleGlobalKeyDown(event);
  await Promise.resolve();
  await Promise.resolve();
  return { handled, event };
}

function bind(id: string, combo: string): void {
  cleanups.push(
    registerKeybinding({ id, combo, commandId: id, label: id, category: "Test", source: "extension" }),
  );
}

const SPACE = { key: " ", code: "Space" } as const;
const PLUS = { key: "+", code: "Equal" } as const;

// ---------------------------------------------------------------------------
// Space
// ---------------------------------------------------------------------------

describe("Space in the key grammar", () => {
  it.each([
    [{ ...SPACE }, "Space"],
    [{ ...SPACE, shiftKey: true }, "Shift+Space"],
    [{ ...SPACE, ctrlKey: true }, "Ctrl+Space"],
    [{ ...SPACE, ctrlKey: true, shiftKey: true }, "Ctrl+Shift+Space"],
    [{ ...SPACE, ctrlKey: true, altKey: true }, "Ctrl+Alt+Space"],
  ] as const)("a keystroke on the space bar is recorded as %j -> '%s', and that combination matches it", (init, combo) => {
    const ev = key(init);
    const recorded = eventToCombo(ev);
    expect(recorded, "eventToCombo recorded the space bar as a character the grammar trims away").toBe(combo);
    // What the Settings box shows (it formats what it recorded).
    expect(formatCombo(recorded!)).toBe(combo);
    expect(matchesEvent(recorded!, ev), "the recorded combination does not match the keystroke it was recorded from").toBe(true);
  });

  it("'Space' matches a bare Space and only a bare one; the modifiers still have to agree", () => {
    expect(matchesEvent("Space", key(SPACE))).toBe(true);
    expect(matchesEvent("Ctrl+Space", key({ ...SPACE, ctrlKey: true }))).toBe(true);
    expect(matchesEvent("Shift+Space", key({ ...SPACE, shiftKey: true }))).toBe(true);
    expect(matchesEvent("Space", key({ ...SPACE, ctrlKey: true }))).toBe(false);
    expect(matchesEvent("Ctrl+Space", key(SPACE))).toBe(false);
    expect(matchesEvent("Ctrl+Space", key({ ...SPACE, ctrlKey: true, shiftKey: true }))).toBe(false);
    // Not every key: the name stands for the space bar, nothing else.
    expect(matchesEvent("Ctrl+Space", key({ key: "s", ctrlKey: true }))).toBe(false);
  });

  it("the name is case-insensitive and canonicalised ('ctrl+SPACE' is Ctrl+Space)", () => {
    expect(parseCombo("ctrl+SPACE")).toEqual({ key: "Space", ctrl: true, shift: false, alt: false, meta: false });
    expect(formatCombo("ctrl+SPACE")).toBe("Ctrl+Space");
    expect(matchesEvent("ctrl+space", key({ ...SPACE, ctrlKey: true }))).toBe(true);
  });

  it("a space bar never reaches the tolerant tiers (whitespace is no layout symbol; the physical tier takes letters and digits)", () => {
    const ctrlAltSpace = key({ ...SPACE, ctrlKey: true, altKey: true });
    expect(matchesEventOnLayout("Ctrl+Space", ctrlAltSpace, { altGr: true })).toBe(false);
    expect(matchesEventOnLayout("Space", key({ ...SPACE, shiftKey: true }), { altGr: true })).toBe(false);
    expect(matchesEventOnPhysicalKey("Ctrl+Space", key({ ...SPACE, ctrlKey: true }), { typing: false })).toBe(false);
  });

  it("a binding on Ctrl+Space runs its command through the dispatcher and takes the key", async () => {
    bind("test.space", "Ctrl+Space");
    const { handled, event } = await press({ ...SPACE, ctrlKey: true });
    expect(ran, "a Ctrl+Space binding never fired").toEqual(["test.space"]);
    expect(handled).toBe(true);
    expect(event.defaultPrevented, "the key was not taken: the grid would ALSO select the column").toBe(true);
    // Only that combination.
    ran.length = 0;
    await press({ ...SPACE, ctrlKey: true, shiftKey: true });
    await press(SPACE);
    expect(ran).toEqual([]);
  });

  it("the window listener the app installs hears it too (initKeybindings' capture listener)", async () => {
    bind("test.space", "Ctrl+Space");
    const ev = key({ ...SPACE, ctrlKey: true });
    document.activeElement!.dispatchEvent(ev);
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toEqual(["test.space"]);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("a shortcut RECORDED from the keystroke the way Settings records it fires on that keystroke", async () => {
    // KeybindingsPage: eventToCombo -> formatCombo -> setUserKeybinding.
    const recorded = formatCombo(eventToCombo(key({ ...SPACE, ctrlKey: true }))!);
    setUserKeybinding("ext.hyperlinks.insert", recorded);
    expect(getEffectiveCombo("ext.hyperlinks.insert")).toBe("Ctrl+Space");
    await press({ ...SPACE, ctrlKey: true });
    expect(ran, "the shortcut Settings saved on Ctrl+Space never fired").toEqual(["hyperlinks.insert"]);
    // Positive control: the remap moved it (Ctrl+K no longer runs it).
    ran.length = 0;
    await press({ key: "k", code: "KeyK", keyCode: 75, ctrlKey: true });
    expect(ran).toEqual([]);
  });

  it("with nothing bound, every Space keystroke is left to the grid (not handled, not prevented)", async () => {
    for (const init of [SPACE, { ...SPACE, shiftKey: true }, { ...SPACE, ctrlKey: true }, { ...SPACE, ctrlKey: true, shiftKey: true }]) {
      const { handled, event } = await press(init);
      expect(handled, `${JSON.stringify(init)} was taken from the grid`).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(ran).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Plus
// ---------------------------------------------------------------------------

describe("'+' in the key grammar ('Plus')", () => {
  it("Ctrl and the plus key is recorded as 'Ctrl+Plus', and that combination matches it", () => {
    const ev = key({ ...PLUS, ctrlKey: true });
    const recorded = eventToCombo(ev);
    expect(recorded, "eventToCombo recorded '+' as a separator").toBe("Ctrl+Plus");
    expect(formatCombo(recorded!)).toBe("Ctrl+Plus");
    expect(matchesEvent(recorded!, ev)).toBe(true);
    expect(matchesEvent("Plus", key(PLUS))).toBe(true);
    expect(matchesEvent("Ctrl+Plus", key({ key: "=", code: "Equal", ctrlKey: true }))).toBe(false);
  });

  it("US layout: Ctrl+Shift+= types '+', recorded as 'Ctrl+Shift+Plus', which matches it exactly", () => {
    const ev = key({ ...PLUS, ctrlKey: true, shiftKey: true });
    expect(eventToCombo(ev)).toBe("Ctrl+Shift+Plus");
    expect(matchesEvent("Ctrl+Shift+Plus", ev)).toBe(true);
  });

  it("a literal '+' key is read as Plus ('Ctrl++', '+', 'Ctrl+Shift++'); a trailing separator names no key", () => {
    expect(parseCombo("Ctrl++")).toEqual(parseCombo("Ctrl+Plus"));
    expect(parseCombo("Ctrl++")).toEqual({ key: "Plus", ctrl: true, shift: false, alt: false, meta: false });
    expect(parseCombo("+")).toEqual({ key: "Plus", ctrl: false, shift: false, alt: false, meta: false });
    expect(parseCombo("Ctrl+Shift++")).toEqual({ key: "Plus", ctrl: true, shift: true, alt: false, meta: false });
    expect(formatCombo("Ctrl++")).toBe("Ctrl+Plus");
    expect(matchesEvent("Ctrl++", key({ ...PLUS, ctrlKey: true }))).toBe(true);
    // One empty part is a malformed combination, not the plus key.
    expect(parseCombo("Ctrl+").key).toBe("");
    expect(parseCombo("Ctrl+ ").key).toBe("");
  });

  it("a binding on Ctrl+Plus runs through the dispatcher (sv-SE: '+' has its own key)", async () => {
    bind("test.plus", "Ctrl+Plus");
    const { handled, event } = await press({ ...PLUS, ctrlKey: true });
    expect(ran, "a Ctrl+Plus binding never fired").toEqual(["test.plus"]);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("THE SYMBOL TIER: Ctrl+Plus is heard from US Ctrl+Shift+= (the layout's Shift), but only after the exact tier missed", async () => {
    const usKeystroke = key({ ...PLUS, ctrlKey: true, shiftKey: true });
    expect(matchesEvent("Ctrl+Plus", usKeystroke)).toBe(false);
    expect(matchesEventOnLayout("Ctrl+Plus", usKeystroke, { altGr: true }), "'Plus' was not read as the '+' symbol").toBe(true);
    bind("test.plus", "Ctrl+Plus");
    await press({ ...PLUS, ctrlKey: true, shiftKey: true });
    expect(ran).toEqual(["test.plus"]);
  });

  it("THE SYMBOL TIER: Ctrl+Shift+Plus still requires the Shift it names, and an exact binding wins the tie", async () => {
    expect(matchesEventOnLayout("Ctrl+Shift+Plus", key({ ...PLUS, ctrlKey: true }), { altGr: true })).toBe(false);
    expect(matchesEventOnLayout("Ctrl+Shift+Plus", key({ ...PLUS, ctrlKey: true, shiftKey: true }), { altGr: true })).toBe(true);
    // An AltGr-typed "+" (Ctrl+Alt on Windows) is heard off a text field.
    expect(matchesEventOnLayout("Ctrl+Plus", key({ ...PLUS, ctrlKey: true, altKey: true }), { altGr: true })).toBe(true);
    bind("test.plus", "Ctrl+Plus");
    bind("test.shiftPlus", "Ctrl+Shift+Plus");
    await press({ ...PLUS, ctrlKey: true, shiftKey: true });
    expect(ran, "the tolerant tier took the keystroke from the binding that names it exactly").toEqual(["test.shiftPlus"]);
    ran.length = 0;
    await press({ ...PLUS, ctrlKey: true });
    expect(ran).toEqual(["test.plus"]);
  });

  it("'Ctrl++' and 'Ctrl+Plus' are the same combination to the conflict check", () => {
    bind("test.plus", "Ctrl+Plus");
    expect(findConflicts("Ctrl++").map((b) => b.id)).toEqual(["test.plus"]);
  });
});

// ---------------------------------------------------------------------------
// The conflict check Settings reads
// ---------------------------------------------------------------------------

describe("Settings' conflict check names the grid's own Space keys", () => {
  it.each([
    ["Ctrl+Space", "Select Entire Column"],
    ["Shift+Space", "Select Entire Row"],
    ["Ctrl+Shift+Space", "Select All"],
    ["Space", "Toggle Check Box"],
  ] as const)("%s is not presented as free: it conflicts with the grid's %s", (combo, what) => {
    // The page's own expression (KeybindingsPage.tsx).
    const labels = findConflicts(combo).filter(isListedKeybinding).map((b) => b.label);
    expect(labels.length, `${combo} was presented as FREE`).toBe(1);
    expect(labels[0]).toContain(what);
    // ...and only that combination's row.
    expect(findConflicts(combo.replace("Space", "Enter"))).toEqual([]);
  });

  it("a remap's own row (excludeId) still sees the grid's key; the grid's rows are not shortcut-list rows", () => {
    const { binding } = addCustomKeybinding("Ctrl+Space", "test.space", "Mine");
    const labels = findConflicts("Ctrl+Space", binding.id).map((b) => b.label);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("Select Entire Column");
    expect(getAllKeybindings().some((b) => b.commandId === "" && b.source === "built-in")).toBe(false);
  });

  it("the grid's rows are reported, never dispatched: Ctrl+Space with nothing bound is the grid's", async () => {
    expect(findConflicts("Ctrl+Space")).toHaveLength(1);
    const { handled } = await press({ ...SPACE, ctrlKey: true });
    expect(handled).toBe(false);
  });
});
