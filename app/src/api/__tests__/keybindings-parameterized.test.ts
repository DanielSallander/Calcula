import { describe, it, expect, beforeEach } from "vitest";
import { parseCombo, formatCombo, matchesEvent, eventToCombo } from "../keybindings";

// ============================================================================
// Helpers
// ============================================================================

function makeKeyEvent(opts: {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: opts.key,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    metaKey: opts.metaKey ?? false,
  });
}

// ============================================================================
// parseCombo - 80 combos
// ============================================================================

describe("parseCombo", () => {
  // Simple letter keys (26)
  it.each(
    "abcdefghijklmnopqrstuvwxyz".split("").map((k) => [k, { key: k, ctrl: false, shift: false, alt: false, meta: false }])
  )("parses simple key '%s'", (combo, expected) => {
    expect(parseCombo(combo as string)).toEqual(expected);
  });

  // Digit keys (10)
  it.each(
    "0123456789".split("").map((k) => [k, { key: k, ctrl: false, shift: false, alt: false, meta: false }])
  )("parses digit key '%s'", (combo, expected) => {
    expect(parseCombo(combo as string)).toEqual(expected);
  });

  // Function keys (12)
  it.each(
    Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { key: `F${i + 1}`, ctrl: false, shift: false, alt: false, meta: false }])
  )("parses function key '%s'", (combo, expected) => {
    expect(parseCombo(combo as string)).toEqual(expected);
  });

  // Named keys (8)
  it.each([
    ["Enter", { key: "Enter", ctrl: false, shift: false, alt: false, meta: false }],
    ["Escape", { key: "Escape", ctrl: false, shift: false, alt: false, meta: false }],
    ["Tab", { key: "Tab", ctrl: false, shift: false, alt: false, meta: false }],
    ["Space", { key: "Space", ctrl: false, shift: false, alt: false, meta: false }],
    ["Backspace", { key: "Backspace", ctrl: false, shift: false, alt: false, meta: false }],
    ["Delete", { key: "Delete", ctrl: false, shift: false, alt: false, meta: false }],
    ["Home", { key: "Home", ctrl: false, shift: false, alt: false, meta: false }],
    ["End", { key: "End", ctrl: false, shift: false, alt: false, meta: false }],
  ] as const)("parses named key '%s'", (combo, expected) => {
    expect(parseCombo(combo)).toEqual(expected);
  });

  // Arrow keys (4)
  it.each([
    ["ArrowUp", { key: "ArrowUp", ctrl: false, shift: false, alt: false, meta: false }],
    ["ArrowDown", { key: "ArrowDown", ctrl: false, shift: false, alt: false, meta: false }],
    ["ArrowLeft", { key: "ArrowLeft", ctrl: false, shift: false, alt: false, meta: false }],
    ["ArrowRight", { key: "ArrowRight", ctrl: false, shift: false, alt: false, meta: false }],
  ] as const)("parses arrow key '%s'", (combo, expected) => {
    expect(parseCombo(combo)).toEqual(expected);
  });

  // PageUp/PageDown (2)
  it.each([
    ["PageUp", { key: "PageUp", ctrl: false, shift: false, alt: false, meta: false }],
    ["PageDown", { key: "PageDown", ctrl: false, shift: false, alt: false, meta: false }],
  ] as const)("parses '%s'", (combo, expected) => {
    expect(parseCombo(combo)).toEqual(expected);
  });

  // Modifier combos (18)
  it.each([
    ["Ctrl+a", { key: "a", ctrl: true, shift: false, alt: false, meta: false }],
    ["Ctrl+Z", { key: "Z", ctrl: true, shift: false, alt: false, meta: false }],
    ["Shift+Tab", { key: "Tab", ctrl: false, shift: true, alt: false, meta: false }],
    ["Alt+F4", { key: "F4", ctrl: false, shift: false, alt: true, meta: false }],
    ["Meta+s", { key: "s", ctrl: false, shift: false, alt: false, meta: true }],
    ["Ctrl+Shift+B", { key: "B", ctrl: true, shift: true, alt: false, meta: false }],
    ["Ctrl+Alt+Delete", { key: "Delete", ctrl: true, shift: false, alt: true, meta: false }],
    ["Ctrl+Shift+Alt+P", { key: "P", ctrl: true, shift: true, alt: true, meta: false }],
    ["Ctrl+Shift+Alt+Meta+X", { key: "X", ctrl: true, shift: true, alt: true, meta: true }],
    ["Control+c", { key: "c", ctrl: true, shift: false, alt: false, meta: false }],
    ["Cmd+v", { key: "v", ctrl: false, shift: false, alt: false, meta: true }],
    ["Ctrl+1", { key: "1", ctrl: true, shift: false, alt: false, meta: false }],
    ["Ctrl+F12", { key: "F12", ctrl: true, shift: false, alt: false, meta: false }],
    ["Shift+ArrowUp", { key: "ArrowUp", ctrl: false, shift: true, alt: false, meta: false }],
    ["Alt+Shift+ArrowRight", { key: "ArrowRight", ctrl: false, shift: true, alt: true, meta: false }],
    ["Ctrl+Enter", { key: "Enter", ctrl: true, shift: false, alt: false, meta: false }],
    ["Ctrl+Shift+Enter", { key: "Enter", ctrl: true, shift: true, alt: false, meta: false }],
    ["Meta+Shift+Z", { key: "Z", ctrl: false, shift: true, alt: false, meta: true }],
  ] as const)("parses modifier combo '%s'", (combo, expected) => {
    expect(parseCombo(combo)).toEqual(expected);
  });
});

// ============================================================================
// formatCombo - 50 combos
// ============================================================================

describe("formatCombo", () => {
  it.each([
    // Single char keys normalize to uppercase
    ["a", "A"],
    ["z", "Z"],
    ["m", "M"],
    ["1", "1"],
    ["0", "0"],
    // Named keys capitalize first letter
    ["Enter", "Enter"],
    ["escape", "Escape"],
    ["tab", "Tab"],
    ["backspace", "Backspace"],
    ["delete", "Delete"],
    // Multi-char keys
    ["ArrowUp", "ArrowUp"],
    ["ArrowDown", "ArrowDown"],
    ["ArrowLeft", "ArrowLeft"],
    ["ArrowRight", "ArrowRight"],
    ["PageUp", "PageUp"],
    ["PageDown", "PageDown"],
    ["Home", "Home"],
    ["End", "End"],
    ["F1", "F1"],
    ["F12", "F12"],
    // Modifier normalization
    ["ctrl+a", "Ctrl+A"],
    ["CTRL+A", "Ctrl+A"],
    ["Ctrl+A", "Ctrl+A"],
    ["shift+b", "Shift+B"],
    ["alt+c", "Alt+C"],
    ["meta+d", "Meta+D"],
    ["cmd+e", "Meta+E"],
    ["control+f", "Ctrl+F"],
    // Modifier ordering: Ctrl, Alt, Shift, Meta
    ["Ctrl+Shift+B", "Ctrl+Shift+B"],
    ["Shift+Ctrl+B", "Ctrl+Shift+B"],
    ["Alt+Ctrl+X", "Ctrl+Alt+X"],
    ["Meta+Alt+Ctrl+Shift+Z", "Ctrl+Alt+Shift+Meta+Z"],
    ["Shift+Alt+Ctrl+Meta+1", "Ctrl+Alt+Shift+Meta+1"],
    // Complex combos
    ["Ctrl+Shift+Alt+Delete", "Ctrl+Alt+Shift+Delete"],
    ["ctrl+shift+enter", "Ctrl+Shift+Enter"],
    ["Ctrl+F12", "Ctrl+F12"],
    ["Alt+F4", "Alt+F4"],
    ["Shift+ArrowUp", "Shift+ArrowUp"],
    ["Ctrl+Shift+ArrowRight", "Ctrl+Shift+ArrowRight"],
    ["Alt+Shift+ArrowLeft", "Alt+Shift+ArrowLeft"],
    // Edge cases
    ["Ctrl+,", "Ctrl+,"],
    ["Ctrl+]", "Ctrl+]"],
    ["Ctrl+[", "Ctrl+["],
    ["Alt+;", "Alt+;"],
    ["Ctrl+Shift+L", "Ctrl+Shift+L"],
    ["Ctrl+Shift+E", "Ctrl+Shift+E"],
    ["Ctrl+Shift+X", "Ctrl+Shift+X"],
    ["Ctrl+Shift+N", "Ctrl+Shift+N"],
    ["Ctrl+Alt+M", "Ctrl+Alt+M"],
  ] as const)("formatCombo('%s') => '%s'", (input, expected) => {
    expect(formatCombo(input)).toBe(expected);
  });
});

// ============================================================================
// matchesEvent - 100 pairs (50 matching, 50 non-matching)
// ============================================================================

describe("matchesEvent", () => {
  describe("matching pairs (should return true)", () => {
    it.each([
      // Simple keys
      ["a", { key: "a" }],
      ["b", { key: "b" }],
      ["z", { key: "z" }],
      ["0", { key: "0" }],
      ["9", { key: "9" }],
      ["F1", { key: "F1" }],
      ["F5", { key: "F5" }],
      ["F12", { key: "F12" }],
      ["Enter", { key: "Enter" }],
      ["Escape", { key: "Escape" }],
      ["Tab", { key: "Tab" }],
      ["Delete", { key: "Delete" }],
      ["Backspace", { key: "Backspace" }],
      ["ArrowUp", { key: "ArrowUp" }],
      ["ArrowDown", { key: "ArrowDown" }],
      ["ArrowLeft", { key: "ArrowLeft" }],
      ["ArrowRight", { key: "ArrowRight" }],
      ["Home", { key: "Home" }],
      ["End", { key: "End" }],
      ["PageUp", { key: "PageUp" }],
      // Case insensitive matching
      ["A", { key: "a" }],
      ["a", { key: "A" }],
      // Modifier combos
      ["Ctrl+C", { key: "c", ctrlKey: true }],
      ["Ctrl+V", { key: "v", ctrlKey: true }],
      ["Ctrl+X", { key: "x", ctrlKey: true }],
      ["Ctrl+Z", { key: "z", ctrlKey: true }],
      ["Ctrl+Y", { key: "y", ctrlKey: true }],
      ["Ctrl+S", { key: "s", ctrlKey: true }],
      ["Ctrl+A", { key: "a", ctrlKey: true }],
      ["Ctrl+F", { key: "f", ctrlKey: true }],
      ["Shift+Tab", { key: "Tab", shiftKey: true }],
      ["Alt+F4", { key: "F4", altKey: true }],
      ["Meta+S", { key: "s", metaKey: true }],
      // Multi-modifier combos
      ["Ctrl+Shift+B", { key: "b", ctrlKey: true, shiftKey: true }],
      ["Ctrl+Shift+L", { key: "l", ctrlKey: true, shiftKey: true }],
      ["Ctrl+Shift+V", { key: "v", ctrlKey: true, shiftKey: true }],
      ["Ctrl+Alt+Delete", { key: "Delete", ctrlKey: true, altKey: true }],
      ["Ctrl+Alt+M", { key: "m", ctrlKey: true, altKey: true }],
      ["Alt+Shift+ArrowRight", { key: "ArrowRight", altKey: true, shiftKey: true }],
      ["Alt+Shift+ArrowLeft", { key: "ArrowLeft", altKey: true, shiftKey: true }],
      ["Ctrl+Shift+Alt+P", { key: "p", ctrlKey: true, shiftKey: true, altKey: true }],
      ["Ctrl+1", { key: "1", ctrlKey: true }],
      ["Ctrl+,", { key: ",", ctrlKey: true }],
      ["Ctrl+]", { key: "]", ctrlKey: true }],
      ["Ctrl+[", { key: "[", ctrlKey: true }],
      ["Alt+;", { key: ";", altKey: true }],
      ["Ctrl+Enter", { key: "Enter", ctrlKey: true }],
      ["Ctrl+Shift+Enter", { key: "Enter", ctrlKey: true, shiftKey: true }],
      ["Shift+ArrowUp", { key: "ArrowUp", shiftKey: true }],
    ] as const)("matchesEvent('%s', event) => true", (combo, eventOpts) => {
      const event = makeKeyEvent(eventOpts as Parameters<typeof makeKeyEvent>[0]);
      expect(matchesEvent(combo, event)).toBe(true);
    });
  });

  describe("non-matching pairs (should return false)", () => {
    it.each([
      // Wrong key
      ["a", { key: "b" }],
      ["Enter", { key: "Escape" }],
      ["F1", { key: "F2" }],
      ["ArrowUp", { key: "ArrowDown" }],
      ["Tab", { key: "Enter" }],
      ["Delete", { key: "Backspace" }],
      ["Home", { key: "End" }],
      ["PageUp", { key: "PageDown" }],
      ["0", { key: "1" }],
      ["z", { key: "a" }],
      // Missing modifier
      ["Ctrl+C", { key: "c" }],
      ["Ctrl+V", { key: "v" }],
      ["Shift+Tab", { key: "Tab" }],
      ["Alt+F4", { key: "F4" }],
      ["Meta+S", { key: "s" }],
      ["Ctrl+Shift+B", { key: "b", ctrlKey: true }],
      ["Ctrl+Shift+B", { key: "b", shiftKey: true }],
      ["Ctrl+Alt+Delete", { key: "Delete", ctrlKey: true }],
      ["Ctrl+Alt+Delete", { key: "Delete", altKey: true }],
      ["Alt+Shift+ArrowRight", { key: "ArrowRight", altKey: true }],
      // Extra modifier
      ["a", { key: "a", ctrlKey: true }],
      ["b", { key: "b", shiftKey: true }],
      ["c", { key: "c", altKey: true }],
      ["d", { key: "d", metaKey: true }],
      ["Enter", { key: "Enter", ctrlKey: true }],
      ["F1", { key: "F1", shiftKey: true }],
      ["Ctrl+C", { key: "c", ctrlKey: true, shiftKey: true }],
      ["Ctrl+C", { key: "c", ctrlKey: true, altKey: true }],
      ["Ctrl+C", { key: "c", ctrlKey: true, metaKey: true }],
      ["Shift+Tab", { key: "Tab", shiftKey: true, ctrlKey: true }],
      // Wrong key with correct modifiers
      ["Ctrl+C", { key: "v", ctrlKey: true }],
      ["Ctrl+Shift+B", { key: "c", ctrlKey: true, shiftKey: true }],
      ["Alt+F4", { key: "F5", altKey: true }],
      ["Ctrl+1", { key: "2", ctrlKey: true }],
      ["Ctrl+Enter", { key: "Escape", ctrlKey: true }],
      // Wrong modifier type
      ["Ctrl+A", { key: "a", altKey: true }],
      ["Shift+A", { key: "a", ctrlKey: true }],
      ["Alt+A", { key: "a", metaKey: true }],
      ["Meta+A", { key: "a", shiftKey: true }],
      ["Ctrl+Shift+A", { key: "a", ctrlKey: true, altKey: true }],
      // Completely different
      ["Ctrl+Z", { key: "y", shiftKey: true }],
      ["Alt+F4", { key: "Escape", ctrlKey: true }],
      ["Ctrl+Shift+L", { key: "k", altKey: true, metaKey: true }],
      ["Delete", { key: "d" }],
      ["Backspace", { key: "b" }],
      ["ArrowUp", { key: "u" }],
      ["ArrowDown", { key: "d" }],
      ["ArrowLeft", { key: "l" }],
      ["ArrowRight", { key: "r" }],
      ["Ctrl+Shift+Alt+Meta+X", { key: "x", ctrlKey: true, shiftKey: true, altKey: true }],
    ] as const)("matchesEvent('%s', event) => false", (combo, eventOpts) => {
      const event = makeKeyEvent(eventOpts as Parameters<typeof makeKeyEvent>[0]);
      expect(matchesEvent(combo, event)).toBe(false);
    });
  });
});

// ============================================================================
// eventToCombo - 40 keyboard events
// ============================================================================

describe("eventToCombo", () => {
  // Returns null for pure modifier keys (4)
  it.each([
    ["Control"],
    ["Shift"],
    ["Alt"],
    ["Meta"],
  ] as const)("returns null for pure modifier key '%s'", (key) => {
    const event = makeKeyEvent({ key });
    expect(eventToCombo(event)).toBeNull();
  });

  // Simple keys (12)
  it.each([
    [{ key: "a" }, "A"],
    [{ key: "z" }, "Z"],
    [{ key: "0" }, "0"],
    [{ key: "9" }, "9"],
    [{ key: "F1" }, "F1"],
    [{ key: "F12" }, "F12"],
    [{ key: "Enter" }, "Enter"],
    [{ key: "Escape" }, "Escape"],
    [{ key: "Tab" }, "Tab"],
    [{ key: "ArrowUp" }, "ArrowUp"],
    [{ key: "Delete" }, "Delete"],
    [{ key: "Backspace" }, "Backspace"],
  ] as const)("eventToCombo({key: '%s'}) => '%s'", (eventOpts, expected) => {
    const event = makeKeyEvent(eventOpts as Parameters<typeof makeKeyEvent>[0]);
    expect(eventToCombo(event)).toBe(expected);
  });

  // With modifiers (24)
  it.each([
    [{ key: "c", ctrlKey: true }, "Ctrl+C"],
    [{ key: "v", ctrlKey: true }, "Ctrl+V"],
    [{ key: "x", ctrlKey: true }, "Ctrl+X"],
    [{ key: "z", ctrlKey: true }, "Ctrl+Z"],
    [{ key: "s", ctrlKey: true }, "Ctrl+S"],
    [{ key: "a", ctrlKey: true }, "Ctrl+A"],
    [{ key: "Tab", shiftKey: true }, "Shift+Tab"],
    [{ key: "F4", altKey: true }, "Alt+F4"],
    [{ key: "s", metaKey: true }, "Meta+S"],
    [{ key: "b", ctrlKey: true, shiftKey: true }, "Ctrl+Shift+B"],
    [{ key: "l", ctrlKey: true, shiftKey: true }, "Ctrl+Shift+L"],
    [{ key: "v", ctrlKey: true, shiftKey: true }, "Ctrl+Shift+V"],
    [{ key: "Delete", ctrlKey: true, altKey: true }, "Ctrl+Alt+Delete"],
    [{ key: "m", ctrlKey: true, altKey: true }, "Ctrl+Alt+M"],
    [{ key: "ArrowRight", altKey: true, shiftKey: true }, "Alt+Shift+ArrowRight"],
    [{ key: "ArrowLeft", altKey: true, shiftKey: true }, "Alt+Shift+ArrowLeft"],
    [{ key: "p", ctrlKey: true, shiftKey: true, altKey: true }, "Ctrl+Alt+Shift+P"],
    [{ key: "x", ctrlKey: true, shiftKey: true, altKey: true, metaKey: true }, "Ctrl+Alt+Shift+Meta+X"],
    [{ key: "1", ctrlKey: true }, "Ctrl+1"],
    [{ key: ",", ctrlKey: true }, "Ctrl+,"],
    [{ key: "Enter", ctrlKey: true }, "Ctrl+Enter"],
    [{ key: "Enter", ctrlKey: true, shiftKey: true }, "Ctrl+Shift+Enter"],
    [{ key: "ArrowUp", shiftKey: true }, "Shift+ArrowUp"],
    [{ key: ";", altKey: true }, "Alt+;"],
  ] as const)("eventToCombo(event) => '%s'", (eventOpts, expected) => {
    const event = makeKeyEvent(eventOpts as Parameters<typeof makeKeyEvent>[0]);
    expect(eventToCombo(event)).toBe(expected);
  });
});
