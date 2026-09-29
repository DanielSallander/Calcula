//! FILENAME: app/extensions/Review/handlers/keyboardHandler.ts
// PURPOSE: The New Comment / New Note actions on the active cell, and the
//          commands the keybinding registry's Ctrl+Alt+M and Shift+F2 run.
// CONTEXT: The registry named `review.newComment` long before anything
//          registered it (BUG-0183), so Ctrl+Alt+M worked only through a
//          window listener here -- which also kept Ctrl+Alt+M after a remap in
//          Settings. The registry is now the ONE keyboard path ("not-editing":
//          never in a text field, a claim or a cell edit), and the listener is
//          gone with its census row.

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
} from "@api";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { refreshAnnotationState } from "../lib/annotationStore";

// ============================================================================
// State
// ============================================================================

let currentActiveCell: { row: number; col: number } | null = null;

// ============================================================================
// Public API
// ============================================================================

export function setActiveCellForKeyboard(
  cell: { row: number; col: number } | null
): void {
  currentActiveCell = cell;
}

// ============================================================================
// Commands
// ============================================================================

/** New Comment at the active cell (Ctrl+Alt+M): edit the cell's comment if it has one. */
export const REVIEW_NEW_COMMENT_COMMAND = "review.newComment";
/** New Note at the active cell (Shift+F2): edit the cell's note, or its comment, if it has one. */
export const REVIEW_NEW_NOTE_COMMAND = "review.newNote";

/** Register both commands. Returns the cleanup. */
export function registerReviewCommands(commands: {
  register(id: string, handler: () => unknown): void;
  unregister(id: string): void;
}): () => void {
  commands.register(REVIEW_NEW_COMMENT_COMMAND, () => newCommentAtActiveCell());
  commands.register(REVIEW_NEW_NOTE_COMMAND, () => newNoteAtActiveCell());
  return () => {
    commands.unregister(REVIEW_NEW_COMMENT_COMMAND);
    commands.unregister(REVIEW_NEW_NOTE_COMMAND);
  };
}

/** New Comment: open the cell's comment for editing, or create one. */
export async function newCommentAtActiveCell(): Promise<void> {
  // Core's active cell is HIDDEN while something else owns the selection (a
  // floating grid's selected cell): refuse, once (D4, BUG-0185 class).
  if (refuseIfSelectionOwned("New Comment")) return;
  if (!currentActiveCell) return;
  const { row, col } = currentActiveCell;

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
}

/** New Note: open the cell's note (or its comment) for editing, or create a note. */
export async function newNoteAtActiveCell(): Promise<void> {
  if (refuseIfSelectionOwned("New Note")) return;
  if (!currentActiveCell) return;
  const { row, col } = currentActiveCell;

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
}
