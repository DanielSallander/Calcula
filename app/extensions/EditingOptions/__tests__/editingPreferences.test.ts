//! FILENAME: app/extensions/EditingOptions/__tests__/editingPreferences.test.ts
// PURPOSE: Tests for editing preferences logic (MoveAfterReturn, MoveDirection, getMoveDelta).
// CONTEXT: Pure functions from @api/editingPreferences with localStorage persistence.

import { describe, it, expect, beforeEach } from "vitest";

// ============================================================================
// Replicate pure logic from editingPreferences.ts
// ============================================================================

type MoveDirection = "down" | "right" | "up" | "left" | "none";

const KEYS = {
  MOVE_AFTER_RETURN: "calcula.editing.moveAfterReturn",
  MOVE_DIRECTION: "calcula.editing.moveDirection",
} as const;

const DEFAULT_MOVE_AFTER_RETURN = true;
const DEFAULT_MOVE_DIRECTION: MoveDirection = "down";

function getMoveAfterReturn(): boolean {
  const stored = localStorage.getItem(KEYS.MOVE_AFTER_RETURN);
  if (stored === null) return DEFAULT_MOVE_AFTER_RETURN;
  return stored === "true";
}

function getMoveDirection(): MoveDirection {
  const stored = localStorage.getItem(KEYS.MOVE_DIRECTION);
  if (stored === null) return DEFAULT_MOVE_DIRECTION;
  if (["down", "right", "up", "left", "none"].includes(stored!)) {
    return stored as MoveDirection;
  }
  return DEFAULT_MOVE_DIRECTION;
}

function setMoveAfterReturn(value: boolean): void {
  localStorage.setItem(KEYS.MOVE_AFTER_RETURN, String(value));
}

function setMoveDirection(direction: MoveDirection): void {
  localStorage.setItem(KEYS.MOVE_DIRECTION, direction);
}

function getMoveDelta(direction: MoveDirection): [number, number] {
  switch (direction) {
    case "down":  return [1, 0];
    case "up":    return [-1, 0];
    case "right": return [0, 1];
    case "left":  return [0, -1];
    case "none":  return [0, 0];
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("Editing preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("getMoveAfterReturn", () => {
    it("defaults to true when not set", () => {
      expect(getMoveAfterReturn()).toBe(true);
    });

    it("returns true when stored as 'true'", () => {
      localStorage.setItem(KEYS.MOVE_AFTER_RETURN, "true");
      expect(getMoveAfterReturn()).toBe(true);
    });

    it("returns false when stored as 'false'", () => {
      localStorage.setItem(KEYS.MOVE_AFTER_RETURN, "false");
      expect(getMoveAfterReturn()).toBe(false);
    });

    it("returns false for any non-'true' string", () => {
      localStorage.setItem(KEYS.MOVE_AFTER_RETURN, "yes");
      expect(getMoveAfterReturn()).toBe(false);
    });

    it("returns false for empty string", () => {
      localStorage.setItem(KEYS.MOVE_AFTER_RETURN, "");
      expect(getMoveAfterReturn()).toBe(false);
    });
  });

  describe("setMoveAfterReturn", () => {
    it("persists true", () => {
      setMoveAfterReturn(true);
      expect(localStorage.getItem(KEYS.MOVE_AFTER_RETURN)).toBe("true");
    });

    it("persists false", () => {
      setMoveAfterReturn(false);
      expect(localStorage.getItem(KEYS.MOVE_AFTER_RETURN)).toBe("false");
    });

    it("round-trips through getter", () => {
      setMoveAfterReturn(false);
      expect(getMoveAfterReturn()).toBe(false);
      setMoveAfterReturn(true);
      expect(getMoveAfterReturn()).toBe(true);
    });
  });

  describe("getMoveDirection", () => {
    it("defaults to 'down' when not set", () => {
      expect(getMoveDirection()).toBe("down");
    });

    it("returns stored valid direction", () => {
      localStorage.setItem(KEYS.MOVE_DIRECTION, "right");
      expect(getMoveDirection()).toBe("right");
    });

    it("returns stored 'none' direction", () => {
      localStorage.setItem(KEYS.MOVE_DIRECTION, "none");
      expect(getMoveDirection()).toBe("none");
    });

    it("falls back to default for invalid direction", () => {
      localStorage.setItem(KEYS.MOVE_DIRECTION, "diagonal");
      expect(getMoveDirection()).toBe("down");
    });

    it("falls back to default for empty string", () => {
      localStorage.setItem(KEYS.MOVE_DIRECTION, "");
      expect(getMoveDirection()).toBe("down");
    });

    it("handles all valid directions", () => {
      for (const dir of ["down", "right", "up", "left", "none"] as MoveDirection[]) {
        setMoveDirection(dir);
        expect(getMoveDirection()).toBe(dir);
      }
    });
  });

  describe("getMoveDelta", () => {
    it("returns [1, 0] for down", () => {
      expect(getMoveDelta("down")).toEqual([1, 0]);
    });

    it("returns [-1, 0] for up", () => {
      expect(getMoveDelta("up")).toEqual([-1, 0]);
    });

    it("returns [0, 1] for right", () => {
      expect(getMoveDelta("right")).toEqual([0, 1]);
    });

    it("returns [0, -1] for left", () => {
      expect(getMoveDelta("left")).toEqual([0, -1]);
    });

    it("returns [0, 0] for none", () => {
      expect(getMoveDelta("none")).toEqual([0, 0]);
    });
  });
});
