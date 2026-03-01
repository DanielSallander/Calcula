//! FILENAME: app/extensions/Review/handlers/reviewMenuBuilder.ts
// PURPOSE: Register comment and note items into the existing Review menu.
// CONTEXT: The Review menu already exists (registered by the Protection extension).
//          We add annotation-related items using registerMenuItem.

import {
  registerMenuItem,
  emitAppEvent,
  AppEvents,
  showOverlay,
  hideOverlay,
  openTaskPane,
  addComment,
  deleteComment,
  getAllComments,
  clearAllComments,
  addNote,
  clearAllNotes,
  showAllNotes as showAllNotesApi,
  DEFAULT_COMMENT_AUTHOR,
  DEFAULT_NOTE_AUTHOR,
} from "../../../src/api";
import type { MenuItemDefinition } from "../../../src/api";
import {
  refreshAnnotationState,
  getShowAllNotes,
  setShowAllNotes,
  getShowAllComments,
  setShowAllComments,
} from "../lib/annotationStore";

// ============================================================================
// State
// ============================================================================

let currentSelection: { row: number; col: number } | null = null;

export function setCurrentSelectionForMenu(
  sel: { row: number; col: number } | null
): void {
  currentSelection = sel;
}

// ============================================================================
// Menu Actions
// ============================================================================

async function newComment(): Promise<void> {
  if (!currentSelection) return;
  const { row, col } = currentSelection;

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

async function newNote(): Promise<void> {
  if (!currentSelection) return;
  const { row, col } = currentSelection;

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

async function toggleShowAllNotes(): Promise<void> {
  const newState = !getShowAllNotes();
  setShowAllNotes(newState);
  await showAllNotesApi(newState);
  await refreshAnnotationState();
  emitAppEvent(AppEvents.GRID_REFRESH);
}

function toggleShowAllComments(): void {
  const newState = !getShowAllComments();
  setShowAllComments(newState);
  if (newState) {
    openTaskPane("comments-pane", {});
  }
}

async function deleteAllComments(): Promise<void> {
  await clearAllComments();
  await refreshAnnotationState();
  emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
  emitAppEvent(AppEvents.GRID_REFRESH);
}

async function deleteAllNotes(): Promise<void> {
  await clearAllNotes();
  await refreshAnnotationState();
  emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
  emitAppEvent(AppEvents.GRID_REFRESH);
}

// ============================================================================
// Registration
// ============================================================================

/** Register annotation menu items into the existing "review" menu. */
export function registerReviewMenuItems(): void {
  const items: MenuItemDefinition[] = [
    {
      id: "review:annotations-sep",
      label: "",
      separator: true,
    },
    {
      id: "review:newComment",
      label: "New Comment",
      shortcut: "Ctrl+Alt+M",
      action: newComment,
    },
    {
      id: "review:newNote",
      label: "New Note",
      shortcut: "Shift+F2",
      action: newNote,
    },
    {
      id: "review:sep2",
      label: "",
      separator: true,
    },
    {
      id: "review:showAllComments",
      label: "Show All Comments",
      action: toggleShowAllComments,
    },
    {
      id: "review:showAllNotes",
      label: "Show All Notes",
      action: toggleShowAllNotes,
    },
    {
      id: "review:sep3",
      label: "",
      separator: true,
    },
    {
      id: "review:deleteAllComments",
      label: "Delete All Comments in Sheet",
      action: deleteAllComments,
    },
    {
      id: "review:deleteAllNotes",
      label: "Delete All Notes in Sheet",
      action: deleteAllNotes,
    },
  ];

  for (const item of items) {
    registerMenuItem("review", item);
  }
}
