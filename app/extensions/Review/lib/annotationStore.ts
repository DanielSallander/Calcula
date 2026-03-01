//! FILENAME: app/extensions/Review/lib/annotationStore.ts
// PURPOSE: Local state cache for annotation indicators (comments and notes).
// CONTEXT: Caches indicator data fetched from the backend for fast per-cell lookup
//          during the render loop. Refreshed on sheet change or annotation mutations.

import type { CommentIndicator, NoteIndicator } from "../../../src/api";
import {
  getCommentIndicators,
  getNoteIndicators,
} from "../../../src/api";

// ============================================================================
// Internal State
// ============================================================================

/** Map of "row,col" -> CommentIndicator for fast lookup during render */
let commentIndicatorMap = new Map<string, CommentIndicator>();

/** Map of "row,col" -> NoteIndicator for fast lookup during render */
let noteIndicatorMap = new Map<string, NoteIndicator>();

/** Whether "Show All Notes" is toggled on */
let showAllNotesActive = false;

/** Whether "Show All Comments" is toggled on */
let showAllCommentsActive = false;

// ============================================================================
// Key helpers
// ============================================================================

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Refresh the annotation indicator cache from the backend.
 * Called on initial load, sheet change, and after annotation mutations.
 */
export async function refreshAnnotationState(): Promise<void> {
  try {
    const [comments, notes] = await Promise.all([
      getCommentIndicators(),
      getNoteIndicators(),
    ]);

    commentIndicatorMap = new Map<string, CommentIndicator>();
    for (const indicator of comments) {
      commentIndicatorMap.set(cellKey(indicator.row, indicator.col), indicator);
    }

    noteIndicatorMap = new Map<string, NoteIndicator>();
    for (const indicator of notes) {
      noteIndicatorMap.set(cellKey(indicator.row, indicator.col), indicator);
    }
  } catch (error) {
    console.error("[Review] Failed to refresh annotation state:", error);
  }
}

/**
 * Get the comment indicator at a specific cell, if any.
 */
export function getCommentIndicatorAt(
  row: number,
  col: number
): CommentIndicator | undefined {
  return commentIndicatorMap.get(cellKey(row, col));
}

/**
 * Get the note indicator at a specific cell, if any.
 */
export function getNoteIndicatorAt(
  row: number,
  col: number
): NoteIndicator | undefined {
  return noteIndicatorMap.get(cellKey(row, col));
}

/**
 * Check if a cell has any annotation (comment or note).
 */
export function hasAnnotationAt(row: number, col: number): boolean {
  const key = cellKey(row, col);
  return commentIndicatorMap.has(key) || noteIndicatorMap.has(key);
}

/**
 * Get all comment indicators (for navigation).
 */
export function getAllCommentIndicatorsCached(): CommentIndicator[] {
  return Array.from(commentIndicatorMap.values());
}

/**
 * Get all note indicators (for navigation).
 */
export function getAllNoteIndicatorsCached(): NoteIndicator[] {
  return Array.from(noteIndicatorMap.values());
}

/**
 * Invalidate the annotation cache (forces next render to re-fetch).
 */
export function invalidateAnnotationCache(): void {
  commentIndicatorMap.clear();
  noteIndicatorMap.clear();
}

/**
 * Reset the annotation store (on extension unload).
 */
export function resetAnnotationStore(): void {
  commentIndicatorMap.clear();
  noteIndicatorMap.clear();
  showAllNotesActive = false;
  showAllCommentsActive = false;
}

/**
 * Toggle "Show All Notes" state.
 */
export function setShowAllNotes(active: boolean): void {
  showAllNotesActive = active;
}

/**
 * Get "Show All Notes" toggle state.
 */
export function getShowAllNotes(): boolean {
  return showAllNotesActive;
}

/**
 * Toggle "Show All Comments" state.
 */
export function setShowAllComments(active: boolean): void {
  showAllCommentsActive = active;
}

/**
 * Get "Show All Comments" toggle state.
 */
export function getShowAllComments(): boolean {
  return showAllCommentsActive;
}
