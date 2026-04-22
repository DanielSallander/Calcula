//! FILENAME: app/src/api/editingPreferences.ts
// PURPOSE: Global editing preferences accessible from both Core and Extensions.
// CONTEXT: Stores user preferences for editing behavior (MoveAfterReturn, etc.)
//          Uses localStorage for persistence. Core reads these via getter functions.

// ============================================================================
// Types
// ============================================================================

export type MoveDirection = "down" | "right" | "up" | "left" | "none";

// ============================================================================
// Storage Keys
// ============================================================================

const KEYS = {
  MOVE_AFTER_RETURN: "calcula.editing.moveAfterReturn",
  MOVE_DIRECTION: "calcula.editing.moveDirection",
} as const;

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_MOVE_AFTER_RETURN = true;
const DEFAULT_MOVE_DIRECTION: MoveDirection = "down";

// ============================================================================
// Getters (safe for Core to call)
// ============================================================================

/** Whether pressing Enter after editing moves the active cell. */
export function getMoveAfterReturn(): boolean {
  const stored = localStorage.getItem(KEYS.MOVE_AFTER_RETURN);
  if (stored === null) return DEFAULT_MOVE_AFTER_RETURN;
  return stored === "true";
}

/** The direction to move after pressing Enter. */
export function getMoveDirection(): MoveDirection {
  const stored = localStorage.getItem(KEYS.MOVE_DIRECTION);
  if (stored === null) return DEFAULT_MOVE_DIRECTION;
  if (["down", "right", "up", "left", "none"].includes(stored)) {
    return stored as MoveDirection;
  }
  return DEFAULT_MOVE_DIRECTION;
}

// ============================================================================
// Setters
// ============================================================================

/** Set whether pressing Enter moves the active cell. */
export function setMoveAfterReturn(value: boolean): void {
  localStorage.setItem(KEYS.MOVE_AFTER_RETURN, String(value));
}

/** Set the direction to move after pressing Enter. */
export function setMoveDirection(direction: MoveDirection): void {
  localStorage.setItem(KEYS.MOVE_DIRECTION, direction);
}

// ============================================================================
// Helper: compute delta from direction
// ============================================================================

/** Convert a MoveDirection to [deltaRow, deltaCol]. */
export function getMoveDelta(direction: MoveDirection): [number, number] {
  switch (direction) {
    case "down":  return [1, 0];
    case "up":    return [-1, 0];
    case "right": return [0, 1];
    case "left":  return [0, -1];
    case "none":  return [0, 0];
  }
}
