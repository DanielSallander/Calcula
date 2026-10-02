//! FILENAME: app/src/api/__tests__/keybindings.bareKeyRefusal.test.ts
// PURPOSE: A user shortcut on a BARE printable key -- Space, Enter, a letter, a
//          digit, a symbol, with no modifier -- is REFUSED, with a sentence
//          that says why, at both doors a user shortcut is written through
//          (a remap and a new custom shortcut), before anything is stored.
// CONTEXT: Owner call 23 (2026-10-02). Since M8 S9 a user's binding on a key
//          the grid owns WINS, with a warning in Settings -- the user's choice
//          on a combination such as Ctrl+Space. A binding on a bare key is not
//          that choice: the dispatcher is a window-capture listener, so a bare
//          "A" (context "always") took every "a" typed into a dialog's text
//          field, and a bare Space every space. "Not while editing" would not
//          have saved it: typing a letter into a CELL starts in ready mode,
//          which is not editing, so a "not-editing" bare "A" still took the
//          first letter of every cell entry. So the binding is refused, and
//          the user is told to hold Ctrl or Alt with the key.
//          Everything here runs the REAL registry and dispatcher.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import {
  addCustomKeybinding,
  bareKeyShortcutRefusal,
  getAllKeybindings,
  getEffectiveCombo,
  handleGlobalKeyDown,
  hasUserOverride,
  initKeybindings,
  removeCustomKeybinding,
  resetAllKeybindings,
  setUserKeybinding,
} from "../keybindings";
import { CommandRegistry } from "../commands";

const ran: string[] = [];

beforeAll(() => {
  initKeybindings();
});

beforeEach(() => {
  ran.length = 0;
  localStorage.clear();
  resetAllKeybindings();
  CommandRegistry.register("test.mine", () => void ran.push("test.mine"));
});

afterEach(() => {
  CommandRegistry.unregister("test.mine");
  for (const b of getAllKeybindings()) if (b.source === "user") removeCustomKeybinding(b.id);
  resetAllKeybindings();
  localStorage.clear();
  document.body.innerHTML = "";
});

/** Every bare printable key the rule covers, as Settings records it (eventToCombo + formatCombo). */
const BARE = ["Space", "Enter", "A", "z", "7", "0", ";", "/", "Plus", "+", "-", "="] as const;

/** Keys that stay bindable: a modifier held, or a bare key that types nothing. */
const ALLOWED = [
  "Ctrl+Space",
  "Ctrl+Enter",
  "Alt+Enter",
  "Ctrl+A",
  "Alt+7",
  "Ctrl+Plus",
  "Meta+A",
  "Ctrl+Shift+Space",
  "F2",
  "F12",
  "Delete",
  "Tab",
  "ArrowUp",
  "PageDown",
] as const;

describe("bareKeyShortcutRefusal: which combinations are refused", () => {
  it.each(BARE)("%s on its own is refused", (combo) => {
    expect(bareKeyShortcutRefusal(combo), `${combo} was accepted as a shortcut`).not.toBeNull();
  });

  it.each(ALLOWED)("%s is not refused", (combo) => {
    expect(bareKeyShortcutRefusal(combo)).toBeNull();
  });

  it("casing and spacing do not change the answer (the grammar's own rules)", () => {
    for (const combo of ["space", " SPACE ", "enter", "a"]) {
      expect(bareKeyShortcutRefusal(combo), combo).not.toBeNull();
    }
    expect(bareKeyShortcutRefusal("ctrl+space")).toBeNull();
  });

  it("an empty combination is not this rule's business", () => {
    expect(bareKeyShortcutRefusal("")).toBeNull();
    expect(bareKeyShortcutRefusal("   ")).toBeNull();
  });
});

describe("the sentence says which key, why, and what to do instead", () => {
  it("Space: names the key, the typing it would take, and the way out", () => {
    const s = bareKeyShortcutRefusal("Space")!;
    expect(s).toContain("Space");
    expect(s).toMatch(/on its own/);
    expect(s).toMatch(/text field/);
    expect(s).toMatch(/Ctrl or Alt/);
  });

  it("Enter: says what Enter does there (confirms an entry), not that it types", () => {
    const s = bareKeyShortcutRefusal("Enter")!;
    expect(s).toContain("Enter");
    expect(s).toMatch(/confirm/);
    expect(s).toMatch(/Ctrl or Alt/);
  });

  it("a character is named in quotes as the user sees it (a letter upper case, a recorded 'Plus' as '+')", () => {
    expect(bareKeyShortcutRefusal("a")!).toMatch(/^"A" cannot be a shortcut on its own/);
    expect(bareKeyShortcutRefusal("Plus")!).toMatch(/^"\+" cannot/);
    expect(bareKeyShortcutRefusal("7")!).toMatch(/^"7" cannot/);
    expect(bareKeyShortcutRefusal("Space")!).toMatch(/^Space cannot/);
  });
});

describe("setUserKeybinding refuses a bare key before storing anything", () => {
  it("throws the sentence; Copy keeps its key and nothing is persisted", () => {
    expect(() => setUserKeybinding("core.copy", "Space")).toThrow(bareKeyShortcutRefusal("Space")!);
    expect(getEffectiveCombo("core.copy")).toBe("Ctrl+C");
    expect(hasUserOverride("core.copy"), "the refused remap was stored").toBe(false);
    expect(localStorage.getItem("calcula.keybindings.overrides") ?? "").not.toContain("Space");
  });

  it.each(["Enter", "A", "1"])("%s is refused the same way", (combo) => {
    expect(() => setUserKeybinding("core.copy", combo)).toThrow(/on its own/);
    expect(hasUserOverride("core.copy")).toBe(false);
  });

  it("positive control: a combination with a modifier is stored", () => {
    expect(setUserKeybinding("core.copy", "Ctrl+Shift+Q")).toBeNull();
    expect(getEffectiveCombo("core.copy")).toBe("Ctrl+Shift+Q");
  });
});

describe("addCustomKeybinding refuses a bare key, whatever its context", () => {
  it.each(["always", "editing", "not-editing"] as const)("context %s: throws, and no row is added", (context) => {
    const before = getAllKeybindings().length;
    expect(() => addCustomKeybinding("Space", "test.mine", "Mine", "Custom", context)).toThrow(/on its own/);
    expect(getAllKeybindings().length, "the refused shortcut was registered").toBe(before);
    expect(localStorage.getItem("calcula.keybindings.custom") ?? "").not.toContain("Space");
  });

  it("a bare letter typed into a text field reaches the field: the refused binding never exists", () => {
    expect(() => addCustomKeybinding("A", "test.mine", "Mine")).toThrow();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const e = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    Object.defineProperty(e, "target", { value: input });
    expect(handleGlobalKeyDown(e), "a bare 'a' in a text field ran a shortcut").toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(ran).toEqual([]);
  });

  it("positive control: Ctrl+Space is added (a key the grid owns: warned in Settings, never refused)", () => {
    const { binding } = addCustomKeybinding("Ctrl+Space", "test.mine", "Mine");
    expect(getAllKeybindings().some((b) => b.id === binding.id)).toBe(true);
  });
});

// A bare-key shortcut STORED before the rule existed is the same binding the
// doors now refuse: loaded verbatim, a stored bare "A" still took every "a"
// typed into a text field, and Settings showed it with no sentence. Both
// loaders drop it -- said on the console -- so the next save writes it out.
describe("a bare-key shortcut stored before the rule is dropped when the bindings load", () => {
  const CUSTOM_KEY = "calcula.keybindings.custom";
  const OVERRIDES_KEY = "calcula.keybindings.overrides";
  const seed = () => {
    localStorage.setItem(
      CUSTOM_KEY,
      JSON.stringify([
        { id: "user.custom.old.bareA", combo: "A", commandId: "test.mine", label: "Old bare A", category: "Custom", context: "always" },
        { id: "user.custom.old.kept", combo: "Ctrl+Alt+K", commandId: "test.mine", label: "Old Ctrl+Alt+K", category: "Custom", context: "always" },
      ]),
    );
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify({ "core.copy": "Space", "core.paste": "Ctrl+Shift+Y" }));
  };
  const typedInto = (input: HTMLInputElement, key: string) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    Object.defineProperty(e, "target", { value: input });
    return { handled: handleGlobalKeyDown(e), prevented: e.defaultPrevented };
  };

  it("a stored bare 'A' shortcut and a stored bare Space remap are not in effect after init; the modified ones are", () => {
    seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      initKeybindings();
      expect(getAllKeybindings().some((b) => b.id === "user.custom.old.bareA"), "the stored bare 'A' was registered").toBe(false);
      expect(hasUserOverride("core.copy"), "the stored bare Space remap was loaded").toBe(false);
      expect(getEffectiveCombo("core.copy")).toBe("Ctrl+C");
      // Said, never silent: each dropped binding is named with the rule's sentence.
      const said = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(said).toContain("Old bare A");
      expect(said).toContain(bareKeyShortcutRefusal("A")!);
      expect(said).toContain("core.copy");
      expect(said).toContain(bareKeyShortcutRefusal("Space")!);
    } finally {
      warn.mockRestore();
    }
    // Positive control: what the rule does not cover loads as before.
    expect(getAllKeybindings().some((b) => b.id === "user.custom.old.kept")).toBe(true);
    expect(getEffectiveCombo("core.paste")).toBe("Ctrl+Shift+Y");

    // The behaviour the rule exists for: typing reaches the text field.
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    for (const key of ["a", " "]) {
      const { handled, prevented } = typedInto(input, key);
      expect(handled, `a bare ${JSON.stringify(key)} in a text field ran a stored shortcut`).toBe(false);
      expect(prevented).toBe(false);
    }
    expect(ran).toEqual([]);
  });

  it("the next save writes the dropped bindings out of storage", () => {
    seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      initKeybindings();
    } finally {
      warn.mockRestore();
    }
    setUserKeybinding("core.cut", "Ctrl+Shift+X");
    const { binding } = addCustomKeybinding("Ctrl+Alt+J", "test.mine", "New");
    const overrides = JSON.parse(localStorage.getItem(OVERRIDES_KEY) ?? "{}") as Record<string, string>;
    expect(overrides["core.copy"], "the bare Space remap survived a save").toBeUndefined();
    expect(overrides["core.paste"]).toBe("Ctrl+Shift+Y");
    const custom = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]") as Array<{ id: string }>;
    expect(custom.map((c) => c.id)).not.toContain("user.custom.old.bareA");
    expect(custom.map((c) => c.id)).toEqual(expect.arrayContaining(["user.custom.old.kept", binding.id]));
  });
});
