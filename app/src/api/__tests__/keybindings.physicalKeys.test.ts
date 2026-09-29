//! FILENAME: app/src/api/__tests__/keybindings.physicalKeys.test.ts
// PURPOSE: A LETTER or DIGIT shortcut (Ctrl+Alt+M, Ctrl+1, Ctrl+Z) is heard by
//          the key that carries that letter or digit, even when the layout
//          makes the keystroke type another character -- without taking a
//          keystroke from an exact binding, and without taking an AltGr
//          character that is being TYPED.
// CONTEXT: D4/D1 review (wave B). On sv-SE and de-DE, Windows turns Ctrl+Alt
//          into AltGr when it generates the character, and AltGr+M types the
//          micro sign: Ctrl+Alt+M arrives as key "µ" with Ctrl+Alt (code
//          "KeyM"). The registry matched letters by the typed character only
//          and its layout tier takes SYMBOL combos only, so New Comment was a
//          dead key there. The same match left AZERTY's Ctrl+1 (typed Ctrl+&)
//          and every Ctrl+letter on a non-Latin layout (Ctrl+Z typed Ctrl+я)
//          dead. Excel binds the KEY -- Windows' virtual-key code -- not the
//          character; the dispatcher's third tier does the same
//          (matchesEventOnPhysicalKey), asked only when neither the exact nor
//          the symbol tier matched.
//          The Settings capture box recorded the same keystroke by its
//          character, upper-cased: sv-SE Ctrl+Alt+M became "Ctrl+Alt+Μ"
//          (a GREEK capital mu), a combination no keystroke can ever match.
//          It now records the key a letter was typed on (eventToCombo).

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  handleGlobalKeyDown,
  initKeybindings,
  registerKeybinding,
  resetAllKeybindings,
  matchesEventOnPhysicalKey,
  eventToCombo,
  setUserKeybinding,
} from "../keybindings";
import { CommandRegistry } from "../commands";

const ran: string[] = [];
const COMMANDS = [
  "review.newComment",
  "test.ctrlAltQ",
  "test.ctrlAltZ",
  "test.ctrlAltY",
  "test.altDigit",
  "test.ctrlShiftK",
  "test.ctrlA",
  "test.exact",
  "test.shiftM",
  "test.always",
];
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

async function press(init: KeyboardEventInit & { keyCode?: number }): Promise<{ handled: boolean; event: KeyboardEvent }> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  // jsdom ignores keyCode in the init dictionary; a real Chromium keystroke carries it.
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
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

describe("a letter shortcut whose key types another character", () => {
  it("sv-SE / de-DE: Ctrl+Alt+M (AltGr+M types the micro sign) runs New Comment once", async () => {
    const { handled, event } = await press({ key: "µ", code: "KeyM", keyCode: 77, ctrlKey: true, altKey: true });
    expect(ran, "Ctrl+Alt+M was a dead key on sv-SE").toEqual(["review.newComment"]);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("a synthetic keystroke with no keyCode is read by its code", async () => {
    await press({ key: "µ", code: "KeyM", ctrlKey: true, altKey: true });
    expect(ran).toEqual(["review.newComment"]);
  });

  it("de-DE: Ctrl+Alt+Q (AltGr+Q types @) reaches a Ctrl+Alt+Q binding", async () => {
    bind("test.ctrlAltQ", "Ctrl+Alt+Q");
    await press({ key: "@", code: "KeyQ", keyCode: 81, ctrlKey: true, altKey: true });
    expect(ran).toEqual(["test.ctrlAltQ"]);
  });

  it("the LAYOUT's letter decides, not the US position: QWERTZ's Z key (code KeyY) is Z", async () => {
    bind("test.ctrlAltZ", "Ctrl+Alt+Z");
    bind("test.ctrlAltY", "Ctrl+Alt+Y");
    await press({ key: "°", code: "KeyY", keyCode: 90, ctrlKey: true, altKey: true });
    expect(ran).toEqual(["test.ctrlAltZ"]);
  });

  it("a non-Latin layout: Ctrl+Shift+K typed as Ctrl+Shift+Л", async () => {
    bind("test.ctrlShiftK", "Ctrl+Shift+K");
    await press({ key: "Л", code: "KeyK", keyCode: 75, ctrlKey: true, shiftKey: true });
    expect(ran).toEqual(["test.ctrlShiftK"]);
  });
});

describe("a digit shortcut whose key types another character", () => {
  it("AZERTY: Alt+2 typed as Alt+é reaches an Alt+2 binding (the digit KEY, as Excel binds it)", async () => {
    bind("test.altDigit", "Alt+2");
    await press({ key: "é", code: "Digit2", keyCode: 50, altKey: true });
    expect(ran).toEqual(["test.altDigit"]);
  });
});

describe("what the physical tier must NOT do", () => {
  it("positive control: the US keystroke still matches exactly", async () => {
    await press({ key: "m", code: "KeyM", keyCode: 77, ctrlKey: true, altKey: true });
    expect(ran).toEqual(["review.newComment"]);
  });

  it("an EXACT binding for the typed character wins over the physical key", async () => {
    bind("test.exact", "Ctrl+Alt+µ");
    await press({ key: "µ", code: "KeyM", keyCode: 77, ctrlKey: true, altKey: true });
    expect(ran).toEqual(["test.exact"]);
  });

  it("modifiers must match EXACTLY: Ctrl+Alt+Shift+M is not Ctrl+Alt+M", async () => {
    const { handled } = await press({ key: "µ", code: "KeyM", keyCode: 77, ctrlKey: true, altKey: true, shiftKey: true });
    expect(ran).toEqual([]);
    expect(handled).toBe(false);
  });

  it("a Latin letter the layout typed is never re-read by position (AZERTY Ctrl+Q is on code KeyA)", async () => {
    bind("test.ctrlA", "Ctrl+A");
    const { handled } = await press({ key: "q", code: "KeyA", ctrlKey: true });
    expect(ran).toEqual([]);
    expect(handled).toBe(false);
  });

  it("a combo with no Ctrl/Alt/Meta is typing, never a physical match (Shift+ь is not Shift+M)", async () => {
    bind("test.shiftM", "Shift+M");
    const { handled } = await press({ key: "Ь", code: "KeyM", keyCode: 77, shiftKey: true });
    expect(ran).toEqual([]);
    expect(handled).toBe(false);
  });

  it("while TYPING, an AltGr character is text: an always-on Ctrl+Alt+Q is not run by AltGr+Q (@)", async () => {
    bind("test.always", "Ctrl+Alt+Q", "always");
    document.body.innerHTML = "";
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const typed = await press({ key: "@", code: "KeyQ", keyCode: 81, ctrlKey: true, altKey: true });
    expect(ran, "an AltGr-typed @ in a text field ran a shortcut").toEqual([]);
    expect(typed.event.defaultPrevented).toBe(false);
    // Positive control: the exact keystroke still reaches an always-on binding there.
    await press({ key: "q", code: "KeyQ", keyCode: 81, ctrlKey: true, altKey: true });
    expect(ran).toEqual(["test.always"]);
  });

  it("an IME composition keystroke is never read by position", async () => {
    const event = new KeyboardEvent("keydown", { key: "Process", code: "KeyM", ctrlKey: true, altKey: true, isComposing: true });
    expect(matchesEventOnPhysicalKey("Ctrl+Alt+M", event, { typing: false })).toBe(false);
  });
});

describe("matchesEventOnPhysicalKey: letters and digits only", () => {
  const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
  it.each([
    ["Ctrl+]", { key: "¤", code: "Digit9", ctrlKey: true, altKey: true }],
    ["Alt+Shift+ArrowRight", { key: "ArrowRight", code: "ArrowRight", altKey: true, shiftKey: true }],
    ["Shift+F2", { key: "F2", code: "F2", shiftKey: true }],
    ["Ctrl+Alt+M", { key: "µ", code: "KeyN", ctrlKey: true, altKey: true }],
    ["Ctrl+Alt+M", { key: "µ", code: "KeyM", ctrlKey: true, altKey: true, metaKey: true }],
  ] as const)("%s never matches %o", (combo, init) => {
    expect(matchesEventOnPhysicalKey(combo, ev(init), { typing: false })).toBe(false);
  });

  it("a Ctrl+Alt keystroke is read only when not typing", () => {
    const e = ev({ key: "µ", code: "KeyM", ctrlKey: true, altKey: true });
    expect(matchesEventOnPhysicalKey("Ctrl+Alt+M", e, { typing: false })).toBe(true);
    expect(matchesEventOnPhysicalKey("Ctrl+Alt+M", e, { typing: true })).toBe(false);
  });
});

describe("the Settings capture box records the KEY a letter was typed on", () => {
  const ev = (init: KeyboardEventInit & { keyCode?: number }) => {
    const event = new KeyboardEvent("keydown", init);
    if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
    return event;
  };

  it.each([
    ["sv-SE Ctrl+Alt+M (the micro sign)", "Ctrl+Alt+M", { key: "µ", code: "KeyM", keyCode: 77, ctrlKey: true, altKey: true }],
    ["a non-Latin Ctrl+Z (я)", "Ctrl+Z", { key: "я", code: "KeyZ", keyCode: 90, ctrlKey: true }],
    ["AZERTY Ctrl+2 (é)", "Ctrl+2", { key: "é", code: "Digit2", keyCode: 50, ctrlKey: true }],
  ] as const)("%s is recorded as %s", (_label, combo, init) => {
    expect(eventToCombo(ev(init))).toBe(combo);
  });

  it.each([
    ["US Ctrl+Alt+M", "Ctrl+Alt+M", { key: "m", code: "KeyM", keyCode: 77, ctrlKey: true, altKey: true }],
    ["a SYMBOL keeps its character (sv-SE Ctrl+AltGr+9)", "Ctrl+Alt+]", { key: "]", code: "Digit9", keyCode: 57, ctrlKey: true, altKey: true }],
    ["an AltGr symbol keeps its character (de-DE AltGr+Q)", "Ctrl+Alt+@", { key: "@", code: "KeyQ", keyCode: 81, ctrlKey: true, altKey: true }],
    ["a letter typed without Ctrl/Alt stays a letter", "Shift+Ö", { key: "ö", code: "Semicolon", keyCode: 192, shiftKey: true }],
  ] as const)("positive control: %s is recorded as %s", (_label, combo, init) => {
    expect(eventToCombo(ev(init))).toBe(combo);
  });

  it("a combination recorded on sv-SE runs when the same keys are pressed again", async () => {
    // The user first moves New Comment off Ctrl+Alt+M, then records Ctrl+Alt+M
    // (AltGr+M, the micro sign) for another command.
    setUserKeybinding("ext.review.newComment", "Ctrl+Shift+F11");
    bind("test.ctrlAltQ", "Ctrl+Shift+F12");
    const keystroke = { key: "µ", code: "KeyM", keyCode: 77, ctrlKey: true, altKey: true };
    const recorded = eventToCombo(ev(keystroke));
    setUserKeybinding("test.ctrlAltQ", recorded!);
    await press(keystroke);
    expect(ran, `the combination the capture box recorded (${recorded}) is a dead key`).toEqual(["test.ctrlAltQ"]);
  });
});
