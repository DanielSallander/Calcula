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

    it("rejects when alt is extra", () => {
      expect(
        matchesEvent("Ctrl+C", makeEvent({ key: "c", ctrlKey: true, altKey: true }))
      ).toBe(false);
    });

    it("rejects when meta is extra", () => {
      expect(
        matchesEvent("Ctrl+C", makeEvent({ key: "c", ctrlKey: true, metaKey: true }))
      ).toBe(false);
    });

    it("matches Ctrl+Shift+Alt+F12", () => {
      expect(
        matchesEvent(
          "Ctrl+Shift+Alt+F12",
          makeEvent({ key: "F12", ctrlKey: true, shiftKey: true, altKey: true })
        )
      ).toBe(true);
    });

    it("does not match Ctrl+Shift+Alt+F12 without alt", () => {
      expect(
        matchesEvent(
          "Ctrl+Shift+Alt+F12",
          makeEvent({ key: "F12", ctrlKey: true, shiftKey: true, altKey: false })
        )
      ).toBe(false);
    });

    it("matches Meta+X", () => {
      expect(
        matchesEvent("Meta+X", makeEvent({ key: "x", metaKey: true }))
      ).toBe(true);
    });

    it("matches Escape without modifiers", () => {
      expect(matchesEvent("Escape", makeEvent({ key: "Escape" }))).toBe(true);
    });

    it("rejects Escape when ctrl is pressed", () => {
      expect(
        matchesEvent("Escape", makeEvent({ key: "Escape", ctrlKey: true }))
      ).toBe(false);
    });

    it("matches Tab", () => {
      expect(matchesEvent("Tab", makeEvent({ key: "Tab" }))).toBe(true);
    });

    it("matches Enter", () => {
      expect(matchesEvent("Enter", makeEvent({ key: "Enter" }))).toBe(true);
    });

    it("parseCombo trims whitespace so space literal cannot be used as combo", () => {
      // " " gets trimmed to "" by parseCombo, so space must use "Space" name
      const parsed = parseCombo(" ");
      expect(parsed.key).toBe("");
    });

    it("matches Backspace", () => {
      expect(matchesEvent("Backspace", makeEvent({ key: "Backspace" }))).toBe(true);
    });

    it("matches arrow keys with modifiers", () => {
      expect(
        matchesEvent(
          "Ctrl+Shift+ArrowUp",
          makeEvent({ key: "ArrowUp", ctrlKey: true, shiftKey: true })
        )
      ).toBe(true);
      expect(
        matchesEvent(
          "Ctrl+ArrowDown",
          makeEvent({ key: "ArrowDown", ctrlKey: true })
        )
      ).toBe(true);
    });

    it("Ctrl+A matches Ctrl+a (case insensitive)", () => {
      expect(
        matchesEvent("Ctrl+A", makeEvent({ key: "a", ctrlKey: true }))
      ).toBe(true);
      expect(
        matchesEvent("Ctrl+a", makeEvent({ key: "A", ctrlKey: true }))
      ).toBe(true);
    });

    it("matches all four modifiers simultaneously", () => {
      expect(
        matchesEvent(
          "Ctrl+Alt+Shift+Meta+X",
          makeEvent({ key: "x", ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })
        )
      ).toBe(true);
    });

    it("does not match when all modifiers expected but one missing", () => {
      expect(
        matchesEvent(
          "Ctrl+Alt+Shift+Meta+X",
          makeEvent({ key: "x", ctrlKey: true, altKey: true, shiftKey: true, metaKey: false })
        )
      ).toBe(false);
    });
  });

  describe("parseCombo - extended", () => {
    it("parses Ctrl+Shift+Alt+F12", () => {
      const result = parseCombo("Ctrl+Shift+Alt+F12");
      expect(result).toEqual({
        key: "F12",
        ctrl: true,
        shift: true,
        alt: true,
        meta: false,
      });
    });

    it("parses Cmd as Meta alias", () => {
      const result = parseCombo("Cmd+Q");
      expect(result.meta).toBe(true);
      expect(result.key).toBe("Q");
    });

    it("parses Control as Ctrl alias", () => {
      const result = parseCombo("Control+S");
      expect(result.ctrl).toBe(true);
      expect(result.key).toBe("S");
    });

    it("parses Escape standalone", () => {
      expect(parseCombo("Escape")).toEqual({
        key: "Escape",
        ctrl: false,
        shift: false,
        alt: false,
        meta: false,
      });
    });

    it("parses Tab standalone", () => {
      expect(parseCombo("Tab").key).toBe("Tab");
    });

    it("parses Enter standalone", () => {
      expect(parseCombo("Enter").key).toBe("Enter");
    });

    it("parses Space standalone", () => {
      expect(parseCombo("Space").key).toBe("Space");
    });

    it("parses Backspace standalone", () => {
      expect(parseCombo("Backspace").key).toBe("Backspace");
    });

    it("parses Ctrl+ArrowLeft", () => {
      const result = parseCombo("Ctrl+ArrowLeft");
      expect(result.ctrl).toBe(true);
      expect(result.key).toBe("ArrowLeft");
    });
  });

  describe("formatCombo - extended", () => {
    it("formats all modifiers in canonical order", () => {
      expect(formatCombo("Meta+Shift+Alt+Ctrl+Z")).toBe("Ctrl+Alt+Shift+Meta+Z");
    });

    it("formats Escape", () => {
      expect(formatCombo("Escape")).toBe("Escape");
    });

    it("formats ArrowDown preserving case", () => {
      expect(formatCombo("Ctrl+arrowdown")).toBe("Ctrl+Arrowdown");
    });

    it("formats single char key to uppercase", () => {
      expect(formatCombo("a")).toBe("A");
    });
  });

  describe("eventToCombo - extended", () => {
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

    it("converts all modifiers + key", () => {
      expect(
        eventToCombo(
          makeEvent({ key: "z", ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })
        )
      ).toBe("Ctrl+Alt+Shift+Meta+Z");
    });

    it("converts Escape key event", () => {
      expect(eventToCombo(makeEvent({ key: "Escape" }))).toBe("Escape");
    });

    it("converts ArrowRight event", () => {
      expect(eventToCombo(makeEvent({ key: "ArrowRight" }))).toBe("ArrowRight");
    });

    it("converts Meta+Tab", () => {
      expect(eventToCombo(makeEvent({ key: "Tab", metaKey: true }))).toBe("Meta+Tab");
    });
  });

  describe("findConflicts", () => {
    it("returns empty array when no bindings registered", () => {
      // findConflicts works against the registry which is empty in test context
      expect(findConflicts("Ctrl+Z")).toEqual([]);
    });
  });
});
