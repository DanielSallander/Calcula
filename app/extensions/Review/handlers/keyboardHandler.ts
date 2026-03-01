//! FILENAME: app/extensions/Review/handlers/keyboardHandler.ts
// PURPOSE: Keyboard shortcuts for annotation actions.
// CONTEXT: Ctrl+Alt+M for new comment, Shift+F2 for new/edit note.

import {
  showOverlay,
  addComment,
  addNote,
  getComment,
  getNote,
  emitAppEvent,
  AppEvents,
  DEFAULT_COMMENT_AUTHOR,
  DEFAULT_NOTE_AUTHOR,
} from "../../../src/api";
import { refreshAnnotationState } from "../lib/annotationStore";

// ============================================================================
// State
// ============================================================================

let currentActiveCell: { row: number; col: number } | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

// ============================================================================
// Public API
// ============================================================================

export function setActiveCellForKeyboard(
  cell: { row: number; col: number } | null
): void {
  currentActiveCell = cell;
}

export function registerKeyboardShortcuts(): void {
  keydownHandler = handleKeyDown;
  window.addEventListener("keydown", keydownHandler, true);
}

export function unregisterKeyboardShortcuts(): void {
  if (keydownHandler) {
    window.removeEventListener("keydown", keydownHandler, true);
    keydownHandler = null;
  }
}

// ============================================================================
// Internal
// ============================================================================

async function handleKeyDown(e: KeyboardEvent): Promise<void> {
  if (!currentActiveCell) return;

  // Don't intercept if an input/textarea/contenteditable is focused
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      (active as HTMLElement).isContentEditable)
  ) {
    return;
  }

  const { row, col } = currentActiveCell;

  // Ctrl+Alt+M: New Comment
  if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "m") {
    e.preventDefault();
    e.stopPropagation();

    // Check if cell already has a comment
    const existing = await getComment(row, col);
    if (existing) {
      // Open existing comment for editing
      showOverlay("comment-panel", {
        data: { row, col, commentId: existing.id, mode: "edit" },
        anchorRect: { x: 0, y: 0, width: 0, height: 0 },
      });
      return;
    }

    // Create new comment
    const result = await addComment({
      row,
      col,
      authorEmail: DEFAULT_COMMENT_AUTHOR.email,
      authorName: DEFAULT_COMMENT_AUTHOR.name,
      content: "",
    });

    if (result.success && result.comment) {
      await refreshAnnotationState();
      emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
      emitAppEvent(AppEvents.GRID_REFRESH);
      showOverlay("comment-panel", {
        data: { row, col, commentId: result.comment.id, mode: "create" },
        anchorRect: { x: 0, y: 0, width: 0, height: 0 },
      });
    }
    return;
  }

  // Shift+F2: New/Edit Note
  if (e.shiftKey && e.key === "F2") {
    e.preventDefault();
    e.stopPropagation();

    // Check if cell has an existing note
    const existingNote = await getNote(row, col);
    if (existingNote) {
      showOverlay("note-editor", {
        data: { row, col, noteId: existingNote.id, mode: "edit" },
        anchorRect: { x: 0, y: 0, width: 0, height: 0 },
      });
      return;
    }

    // Check if cell has a comment instead
    const existingComment = await getComment(row, col);
    if (existingComment) {
      showOverlay("comment-panel", {
        data: { row, col, commentId: existingComment.id, mode: "edit" },
        anchorRect: { x: 0, y: 0, width: 0, height: 0 },
      });
      return;
    }

    // Create new note
    const result = await addNote({
      row,
      col,
      authorName: DEFAULT_NOTE_AUTHOR.name,
      content: "",
    });

    if (result.success && result.note) {
      await refreshAnnotationState();
      emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
      emitAppEvent(AppEvents.GRID_REFRESH);
      showOverlay("note-editor", {
        data: { row, col, noteId: result.note.id, mode: "create" },
        anchorRect: { x: 0, y: 0, width: 0, height: 0 },
      });
    }
    return;
  }
}
