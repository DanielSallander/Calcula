//! FILENAME: app/extensions/Controls/lib/floatingStore.ts
// PURPOSE: In-memory store for floating (non-embedded) control positions.
// CONTEXT: Follows the same pattern as Charts' chartStore.ts.
//          Manages floating control state and syncs to the grid overlay system.

import {
  removeGridRegionsByType,
  replaceGridRegionsByType,
  type GridRegion,
} from "@api/gridOverlays";
import { getDesignMode } from "./designMode";

// ============================================================================
// Types
// ============================================================================

export interface FloatingControl {
  /** Unique ID: "control-{sheet}-{row}-{col}" */
  id: string;
  sheetIndex: number;
  /** Anchor cell row (for metadata lookup) */
  row: number;
  /** Anchor cell column (for metadata lookup) */
  col: number;
  /** X position in sheet pixels (relative to cell A1 top-left) */
  x: number;
  /** Y position in sheet pixels */
  y: number;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Control type (e.g., "button") */
  controlType: string;
}

export interface ControlGroup {
  /** Unique group ID */
  id: string;
  /** IDs of controls that belong to this group */
  memberIds: string[];
}

// ============================================================================
// Store State
// ============================================================================

let floatingControls: FloatingControl[] = [];

/** Map of group ID -> ControlGroup */
const controlGroups: Map<string, ControlGroup> = new Map();

/** Reverse lookup: control ID -> group ID */
const controlToGroup: Map<string, string> = new Map();

/** Counter for generating unique group IDs */
let groupIdCounter = 0;

// ============================================================================
// Store Operations
// ============================================================================

/** Build a unique ID for a floating control. */
export function makeFloatingControlId(sheetIndex: number, row: number, col: number): string {
  return `control-${sheetIndex}-${row}-${col}`;
}

/** Add a floating control to the store. */
export function addFloatingControl(ctrl: FloatingControl): void {
  // Remove existing with same ID first
  floatingControls = floatingControls.filter((c) => c.id !== ctrl.id);
  floatingControls.push(ctrl);
}

/** Remove a floating control by ID. Also removes it from any group. */
export function removeFloatingControl(id: string): void {
  floatingControls = floatingControls.filter((c) => c.id !== id);
  removeControlFromGroups(id);
}

/** Get a floating control by ID. */
export function getFloatingControl(id: string): FloatingControl | null {
  return floatingControls.find((c) => c.id === id) ?? null;
}

/** Get all floating controls. */
export function getAllFloatingControls(): FloatingControl[] {
  return [...floatingControls];
}

/** Get floating controls for a specific sheet. */
export function getFloatingControlsForSheet(sheetIndex: number): FloatingControl[] {
  return floatingControls.filter((c) => c.sheetIndex === sheetIndex);
}

/** Move a floating control to a new position. */
export function moveFloatingControl(id: string, x: number, y: number): void {
  const ctrl = floatingControls.find((c) => c.id === id);
  if (ctrl) {
    ctrl.x = x;
    ctrl.y = y;
  }
}

/** Resize a floating control (full bounds update for all-corner resize). */
export function resizeFloatingControl(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const ctrl = floatingControls.find((c) => c.id === id);
  if (ctrl) {
    ctrl.x = x;
    ctrl.y = y;
    ctrl.width = width;
    ctrl.height = height;
  }
}

/** Reset the entire floating store (used during extension deactivation). */
export function resetFloatingStore(): void {
  floatingControls = [];
  controlGroups.clear();
  controlToGroup.clear();
  groupIdCounter = 0;
  removeGridRegionsByType("floating-control");
}

// ============================================================================
// Z-Order Operations
// ============================================================================

/**
 * Get the set of control IDs to operate on for z-order changes.
 * If the control belongs to a group, return all group members.
 */
function getZOrderIds(controlId: string): string[] {
  const groupId = controlToGroup.get(controlId);
  if (groupId) {
    const group = controlGroups.get(groupId);
    if (group) return [...group.memberIds];
  }
  return [controlId];
}

/**
 * Bring a floating control (and its group members) to the front (highest z-order).
 * Moves the controls to the end of the array so they render last (on top).
 */
export function bringToFront(controlId: string): void {
  const ids = new Set(getZOrderIds(controlId));
  const moved = floatingControls.filter((c) => ids.has(c.id));
  floatingControls = floatingControls.filter((c) => !ids.has(c.id));
  floatingControls.push(...moved);
}

/**
 * Send a floating control (and its group members) to the back (lowest z-order).
 * Moves the controls to the beginning of the array so they render first (behind everything).
 */
export function sendToBack(controlId: string): void {
  const ids = new Set(getZOrderIds(controlId));
  const moved = floatingControls.filter((c) => ids.has(c.id));
  floatingControls = floatingControls.filter((c) => !ids.has(c.id));
  floatingControls.unshift(...moved);
}

/**
 * Move a floating control (and its group members) one step forward in z-order.
 */
export function bringForward(controlId: string): void {
  const ids = new Set(getZOrderIds(controlId));
  // Find the highest index of the group in the array
  let maxIdx = -1;
  for (let i = 0; i < floatingControls.length; i++) {
    if (ids.has(floatingControls[i].id)) maxIdx = i;
  }
  if (maxIdx < 0 || maxIdx === floatingControls.length - 1) return;

  // Find the next control after the group that's not in the group
  const nextIdx = maxIdx + 1;
  if (ids.has(floatingControls[nextIdx].id)) return;

  // Move the non-group control before the group
  const [nonGroupCtrl] = floatingControls.splice(nextIdx, 1);
  let minIdx = floatingControls.length;
  for (let i = 0; i < floatingControls.length; i++) {
    if (ids.has(floatingControls[i].id)) { minIdx = i; break; }
  }
  floatingControls.splice(minIdx, 0, nonGroupCtrl);
}

/**
 * Move a floating control (and its group members) one step backward in z-order.
 */
export function sendBackward(controlId: string): void {
  const ids = new Set(getZOrderIds(controlId));
  // Find the lowest index of the group in the array
  let minIdx = floatingControls.length;
  for (let i = 0; i < floatingControls.length; i++) {
    if (ids.has(floatingControls[i].id)) { minIdx = i; break; }
  }
  if (minIdx <= 0) return;

  // Move the control before the group to after the group
  const prevIdx = minIdx - 1;
  if (ids.has(floatingControls[prevIdx].id)) return;

  const [nonGroupCtrl] = floatingControls.splice(prevIdx, 1);
  let maxIdx = -1;
  for (let i = 0; i < floatingControls.length; i++) {
    if (ids.has(floatingControls[i].id)) maxIdx = i;
  }
  floatingControls.splice(maxIdx + 1, 0, nonGroupCtrl);
}

// ============================================================================
// Group Operations
// ============================================================================

/**
 * Create a group from the given control IDs.
 * Returns the new group ID.
 * Controls that already belong to another group are removed from that group first.
 */
export function groupControls(controlIds: string[]): string {
  if (controlIds.length < 2) {
    throw new Error("Cannot group fewer than 2 controls");
  }

  // Remove controls from any existing groups
  for (const ctrlId of controlIds) {
    const existingGroupId = controlToGroup.get(ctrlId);
    if (existingGroupId) {
      ungroupControls(existingGroupId);
    }
  }

  groupIdCounter++;
  const groupId = `group-${groupIdCounter}`;

  const group: ControlGroup = {
    id: groupId,
    memberIds: [...controlIds],
  };

  controlGroups.set(groupId, group);
  for (const ctrlId of controlIds) {
    controlToGroup.set(ctrlId, groupId);
  }

  return groupId;
}

/**
 * Dissolve a group, returning the member IDs.
 * The controls themselves are not affected, only the grouping is removed.
 */
export function ungroupControls(groupId: string): string[] {
  const group = controlGroups.get(groupId);
  if (!group) return [];

  const memberIds = [...group.memberIds];

  // Clear reverse lookup
  for (const ctrlId of memberIds) {
    controlToGroup.delete(ctrlId);
  }

  controlGroups.delete(groupId);
  return memberIds;
}

/**
 * Find the group a control belongs to.
 * Returns the group ID or null if the control is not grouped.
 */
export function getGroupForControl(controlId: string): string | null {
  return controlToGroup.get(controlId) ?? null;
}

/**
 * Get all control IDs in a group.
 */
export function getGroupMembers(groupId: string): string[] {
  const group = controlGroups.get(groupId);
  return group ? [...group.memberIds] : [];
}

/**
 * Get the ControlGroup object by ID.
 */
export function getControlGroup(groupId: string): ControlGroup | null {
  return controlGroups.get(groupId) ?? null;
}

/**
 * Get all groups.
 */
export function getAllGroups(): ControlGroup[] {
  return [...controlGroups.values()];
}

/**
 * Compute the bounding rectangle of a group from its members.
 * Returns { x, y, width, height } in sheet pixels, or null if no members found.
 */
export function getGroupBounds(groupId: string): { x: number; y: number; width: number; height: number } | null {
  const group = controlGroups.get(groupId);
  if (!group || group.memberIds.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const memberId of group.memberIds) {
    const ctrl = floatingControls.find((c) => c.id === memberId);
    if (!ctrl) continue;

    minX = Math.min(minX, ctrl.x);
    minY = Math.min(minY, ctrl.y);
    maxX = Math.max(maxX, ctrl.x + ctrl.width);
    maxY = Math.max(maxY, ctrl.y + ctrl.height);
  }

  if (minX === Infinity) return null;

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Move all members of a group by the given delta.
 */
export function moveGroupControls(groupId: string, deltaX: number, deltaY: number): void {
  const group = controlGroups.get(groupId);
  if (!group) return;

  for (const memberId of group.memberIds) {
    const ctrl = floatingControls.find((c) => c.id === memberId);
    if (ctrl) {
      ctrl.x = Math.max(0, ctrl.x + deltaX);
      ctrl.y = Math.max(0, ctrl.y + deltaY);
    }
  }
}

/**
 * Resize all members of a group proportionally.
 * The group bounds change from (oldBounds) to (newBounds), and each member
 * is scaled/repositioned accordingly.
 */
export function resizeGroupControls(
  groupId: string,
  oldBounds: { x: number; y: number; width: number; height: number },
  newBounds: { x: number; y: number; width: number; height: number },
): void {
  const group = controlGroups.get(groupId);
  if (!group || oldBounds.width === 0 || oldBounds.height === 0) return;

  const scaleX = newBounds.width / oldBounds.width;
  const scaleY = newBounds.height / oldBounds.height;

  for (const memberId of group.memberIds) {
    const ctrl = floatingControls.find((c) => c.id === memberId);
    if (!ctrl) continue;

    // Compute relative position within old bounds
    const relX = ctrl.x - oldBounds.x;
    const relY = ctrl.y - oldBounds.y;

    // Apply scale
    ctrl.x = newBounds.x + relX * scaleX;
    ctrl.y = newBounds.y + relY * scaleY;
    ctrl.width = Math.max(10, ctrl.width * scaleX);
    ctrl.height = Math.max(10, ctrl.height * scaleY);
  }
}

/**
 * When a control is removed from the store, also remove it from any group.
 * If the group drops below 2 members, dissolve the group.
 */
function removeControlFromGroups(controlId: string): void {
  const groupId = controlToGroup.get(controlId);
  if (!groupId) return;

  const group = controlGroups.get(groupId);
  if (!group) {
    controlToGroup.delete(controlId);
    return;
  }

  group.memberIds = group.memberIds.filter((id) => id !== controlId);
  controlToGroup.delete(controlId);

  // If fewer than 2 members remain, dissolve the group
  if (group.memberIds.length < 2) {
    for (const remainingId of group.memberIds) {
      controlToGroup.delete(remainingId);
    }
    controlGroups.delete(groupId);
  }
}

// ============================================================================
// Grid Overlay Sync
// ============================================================================

/**
 * Sync all floating controls to the grid overlay system.
 * Call this after any mutation (add, move, resize, remove).
 *
 * Floating controls use the `floating` field on GridRegion for pixel positioning.
 * Cell-based fields (startRow, etc.) are set to 0 since they're unused.
 */
export function syncFloatingControlRegions(): void {
  const regions: GridRegion[] = floatingControls.map((ctrl) => ({
    id: ctrl.id,
    type: "floating-control",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: {
      x: ctrl.x,
      y: ctrl.y,
      width: ctrl.width,
      height: ctrl.height,
    },
    data: {
      sheetIndex: ctrl.sheetIndex,
      row: ctrl.row,
      col: ctrl.col,
      controlType: ctrl.controlType,
      movable: getDesignMode() || ctrl.controlType === "shape" || ctrl.controlType === "image",
      resizable: getDesignMode() || ctrl.controlType === "shape" || ctrl.controlType === "image",
    },
  }));

  replaceGridRegionsByType("floating-control", regions);
}
