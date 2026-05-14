import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseCombo, formatCombo, eventToCombo, matchesEvent, findConflicts } from "../keybindings";

describe("keybindings - pure functions", () => {
  describe("parseCombo", () => {
    it("parses simple key", () => {
      expect(parseCombo("F2")).toEqual({
        key: "F2",
        ctrl: false,
        shift: false,
        alt: false,
        meta: false,
      });
    });

    it("parses Ctrl+key", () => {
      const result = parseCombo("Ctrl+C");
      expect(result.ctrl).toBe(true);
      expect(result.key).toBe("C");
    });

    it("parses Ctrl+Shift+key", () => {
      const result = parseCombo("Ctrl+Shift+L");
      expect(result.ctrl).toBe(true);
      expect(result.shift).toBe(true);
      expect(result.key).toBe("L");
    });

    it("parses Alt+key", () => {
      const result = parseCombo("Alt+;");
      expect(result.alt).toBe(true);
      expect(result.key).toBe(";");
    });

    it("parses all modifiers", () => {
      const result = parseCombo("Ctrl+Alt+Shift+Meta+X");
      expect(result.ctrl).toBe(true);
      expect(result.alt).toBe(true);
      expect(result.shift).toBe(true);
      expect(result.meta).toBe(true);
      expect(result.key).toBe("X");
    });

    it("handles lowercase modifier names", () => {
      const result = parseCombo("ctrl+shift+b");
      expect(result.ctrl).toBe(true);
      expect(result.shift).toBe(true);
      expect(result.key).toBe("b");
    });

    it("parses multi-word keys like ArrowRight", () => {
      const result = parseCombo("Alt+Shift+ArrowRight");
      expect(result.alt).toBe(true);
      expect(result.shift).toBe(true);
      expect(result.key).toBe("ArrowRight");
    });

    it("handles Delete key", () => {
      const result = parseCombo("Delete");
      expect(result.key).toBe("Delete");
      expect(result.ctrl).toBe(false);
    });
  });

  describe("formatCombo", () => {
    it("normalizes casing", () => {
      expect(formatCombo("ctrl+shift+b")).toBe("Ctrl+Shift+B");
    });

    it("preserves multi-char key names", () => {
      expect(formatCombo("Ctrl+F2")).toBe("Ctrl+F2");
    });

    it("capitalizes single char keys", () => {
      expect(formatCombo("Ctrl+c")).toBe("Ctrl+C");
    });

    it("orders modifiers consistently", () => {
      expect(formatCombo("Shift+Ctrl+A")).toBe("Ctrl+Shift+A");
    });

    it("formats Delete key", () => {
      expect(formatCombo("Delete")).toBe("Delete");
    });
  });

  describe("eventToCombo", () => {
    function makeEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
      return {
        key: "a",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ...overrides,
      } as KeyboardEvent;
    }

    it("converts simple key event", () => {
      expect(eventToCombo(makeEvent({ key: "F2" }))).toBe("F2");
    });

    it("converts Ctrl+C", () => {
      expect(eventToCombo(makeEvent({ key: "c", ctrlKey: true }))).toBe("Ctrl+C");
    });

    it("converts Ctrl+Shift+L", () => {
      expect(
        eventToCombo(makeEvent({ key: "l", ctrlKey: true, shiftKey: true }))
      ).toBe("Ctrl+Shift+L");
    });

    it("returns null for pure modifier key", () => {
      expect(eventToCombo(makeEvent({ key: "Control" }))).toBeNull();
      expect(eventToCombo(makeEvent({ key: "Shift" }))).toBeNull();
      expect(eventToCombo(makeEvent({ key: "Alt" }))).toBeNull();
      expect(eventToCombo(makeEvent({ key: "Meta" }))).toBeNull();
    });
  });

  describe("matchesEvent", () => {
    function makeEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
      return {
        key: "a",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ...overrides,
      } as KeyboardEvent;
    }

    it("matches simple key", () => {
      expect(matchesEvent("F2", makeEvent({ key: "F2" }))).toBe(true);
    });

    it("matches Ctrl+C", () => {
      expect(
        matchesEvent("Ctrl+C", makeEvent({ key: "c", ctrlKey: true }))
      ).toBe(true);
    });

    it("does not match when modifier differs", () => {
      expect(
        matchesEvent("Ctrl+C", makeEvent({ key: "c", ctrlKey: false }))
      ).toBe(false);
    });

    it("does not match when extra modifier is pressed", () => {
      expect(
        matchesEvent(
          "Ctrl+C",
          makeEvent({ key: "c", ctrlKey: true, shiftKey: true })
        )
      ).toBe(false);
    });

    it("case-insensitive key matching", () => {
      expect(
        matchesEvent("Ctrl+C", makeEvent({ key: "C", ctrlKey: true }))
      ).toBe(true);
    });
  });
});
