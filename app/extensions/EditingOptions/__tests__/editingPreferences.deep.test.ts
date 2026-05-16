//! FILENAME: app/extensions/EditingOptions/__tests__/editingPreferences.deep.test.ts
// PURPOSE: Deep tests for editing preferences: all directions, rapid toggle, invalid fallback, persistence, immediate readback.

import { describe, it, expect, beforeEach } from "vitest";

// ============================================================================
// Replicate pure logic from editingPreferences
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

describe("Editing preferences (deep)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // --- All move directions with getMoveDelta ---

  describe("getMoveDelta for all directions", () => {
    const cases: [MoveDirection, [number, number]][] = [
      ["down", [1, 0]],
      ["up", [-1, 0]],
      ["right", [0, 1]],
      ["left", [0, -1]],
      ["none", [0, 0]],
    ];

    it.each(cases)("direction '%s' yields delta %j", (dir, expected) => {
      expect(getMoveDelta(dir)).toEqual(expected);
    });

    it("all deltas are orthogonal or zero (no diagonal)", () => {
      for (const dir of ["down", "up", "right", "left", "none"] as MoveDirection[]) {
        const [dr, dc] = getMoveDelta(dir);
        // At most one axis is non-zero
        expect(Math.abs(dr) + Math.abs(dc)).toBeLessThanOrEqual(1);
      }
    });

    it("down and up are inverses", () => {
      const [dr1, dc1] = getMoveDelta("down");
      const [dr2, dc2] = getMoveDelta("up");
      expect(dr1 + dr2).toBe(0);
      expect(dc1 + dc2).toBe(0);
    });

    it("left and right are inverses", () => {
      const [dr1, dc1] = getMoveDelta("right");
      const [dr2, dc2] = getMoveDelta("left");
      expect(dr1 + dr2).toBe(0);
      expect(dc1 + dc2).toBe(0);
    });
  });

  // --- Rapid toggle of moveAfterReturn ---

  describe("rapid toggle of moveAfterReturn", () => {
    it("toggling 100 times ends at correct state", () => {
      for (let i = 0; i < 100; i++) {
        setMoveAfterReturn(i % 2 === 0);
      }
      // i=99 is odd -> false
      expect(getMoveAfterReturn()).toBe(false);
    });

    it("toggling back and forth does not corrupt localStorage", () => {
      for (let i = 0; i < 50; i++) {
        setMoveAfterReturn(true);
        expect(getMoveAfterReturn()).toBe(true);
        setMoveAfterReturn(false);
        expect(getMoveAfterReturn()).toBe(false);
      }
    });
  });

  // --- Invalid direction fallback ---

  describe("invalid direction fallback", () => {
    it("falls back to 'down' for numeric string", () => {
      localStorage.setItem(KEYS.MOVE_DIRECTION, "42");
      expect(getMoveDirection()).toBe("down");
    });

    it("falls back to 'down' for uppercase variant", () => {
      localStorage.setItem(KEYS.MOVE_DIRECTION, "Down");
      expect(getMoveDirection()).toBe("down");
    });

    it("falls back to 'down' for whitespace-padded value", () => {
      localStorage.setItem(KEYS.MOVE_DIRECTION, " down ");
      expect(getMoveDirection()).toBe("down");
    });

    it("falls back to 'down' for 'diagonal'", () => {
      localStorage.setItem(KEYS.MOVE_DIRECTION, "diagonal");
      expect(getMoveDirection()).toBe("down");
    });

    it("falls back to 'down' for JSON object string", () => {
      localStorage.setItem(KEYS.MOVE_DIRECTION, '{"dir":"up"}');
      expect(getMoveDirection()).toBe("down");
    });
  });

  // --- Direction persistence across sessions ---

  describe("direction persistence across sessions (localStorage)", () => {
    it("direction survives clear-and-re-read cycle when not cleared", () => {
      setMoveDirection("left");
      // Simulate "new session" by reading from localStorage directly
      const raw = localStorage.getItem(KEYS.MOVE_DIRECTION);
      expect(raw).toBe("left");
      expect(getMoveDirection()).toBe("left");
    });

    it("moveAfterReturn survives separate reads", () => {
      setMoveAfterReturn(false);
      // Multiple independent reads
      expect(getMoveAfterReturn()).toBe(false);
      expect(getMoveAfterReturn()).toBe(false);
      expect(getMoveAfterReturn()).toBe(false);
    });

    it("both settings persist independently", () => {
      setMoveAfterReturn(false);
      setMoveDirection("right");

      expect(getMoveAfterReturn()).toBe(false);
      expect(getMoveDirection()).toBe("right");

      // Change one, other stays
      setMoveDirection("up");
      expect(getMoveAfterReturn()).toBe(false);
      expect(getMoveDirection()).toBe("up");
    });

    it("cycling through all directions preserves last set", () => {
      const dirs: MoveDirection[] = ["down", "up", "left", "right", "none"];
      for (const d of dirs) {
        setMoveDirection(d);
      }
      expect(getMoveDirection()).toBe("none");
    });
  });

  // --- Set direction then immediately read back ---

  describe("set direction then immediately read back", () => {
    it("each direction reads back immediately after set", () => {
      for (const dir of ["down", "up", "left", "right", "none"] as MoveDirection[]) {
        setMoveDirection(dir);
        expect(getMoveDirection()).toBe(dir);
      }
    });

    it("set moveAfterReturn reads back immediately", () => {
      setMoveAfterReturn(true);
      expect(getMoveAfterReturn()).toBe(true);
      setMoveAfterReturn(false);
      expect(getMoveAfterReturn()).toBe(false);
    });

    it("set direction + getMoveDelta in sequence is consistent", () => {
      setMoveDirection("right");
      expect(getMoveDelta(getMoveDirection())).toEqual([0, 1]);

      setMoveDirection("up");
      expect(getMoveDelta(getMoveDirection())).toEqual([-1, 0]);
    });
  });
});
