//! FILENAME: app/extensions/Review/handlers/contextMenuBuilder.ts
// PURPOSE: Register right-click context menu items for notes and comments.
// CONTEXT: Adds "New Note", "New Comment", "Edit/Delete", "Resolve" items
//          to the grid context menu.

import {
  gridExtensions,
  showOverlay,
  emitAppEvent,
  AppEvents,
  addComment,
  deleteComment,
  resolveComment,
  getComment,
  addNote,
  deleteNote,
  getNote,
  convertNoteToComment,
  DEFAULT_COMMENT_AUTHOR,
  DEFAULT_NOTE_AUTHOR,
} from "../../../src/api";
import type { GridContextMenuItem, GridMenuContext } from "../../../src/api";
import {
  getCommentIndicatorAt,
  getNoteIndicatorAt,
  refreshAnnotationState,
} from "../lib/annotationStore";

// ============================================================================
// Constants
// ============================================================================

const ANNOTATION_GROUP = "annotations";
const ANNOTATION_ORDER_BASE = 700;

// ============================================================================
// Registration
// ============================================================================

export function registerAnnotationContextMenuItems(): void {
  const items: GridContextMenuItem[] = [
    // New Comment
    {
      id: "ctx:newComment",
      label: "New Comment",
      group: ANNOTATION_GROUP,
      order: ANNOTATION_ORDER_BASE,
      visible: (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return false;
        const { row, col } = ctx.clickedCell;
        return !getCommentIndicatorAt(row, col) && !getNoteIndicatorAt(row, col);
      },
      onClick: async (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return;
        const { row, col } = ctx.clickedCell;

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
      },
    },

    // New Note
    {
      id: "ctx:newNote",
      label: "New Note",
      group: ANNOTATION_GROUP,
      order: ANNOTATION_ORDER_BASE + 1,
      visible: (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return false;
        const { row, col } = ctx.clickedCell;
        return !getCommentIndicatorAt(row, col) && !getNoteIndicatorAt(row, col);
      },
      onClick: async (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return;
        const { row, col } = ctx.clickedCell;

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
      },
    },

    // Edit Comment
    {
      id: "ctx:editComment",
      label: "Edit Comment",
      group: ANNOTATION_GROUP,
      order: ANNOTATION_ORDER_BASE + 10,
      visible: (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return false;
        return !!getCommentIndicatorAt(ctx.clickedCell.row, ctx.clickedCell.col);
      },
      onClick: async (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return;
        const { row, col } = ctx.clickedCell;
        const comment = await getComment(row, col);
        if (comment) {
          showOverlay("comment-panel", {
            data: { row, col, commentId: comment.id, mode: "edit" },
            anchorRect: { x: 0, y: 0, width: 0, height: 0 },
          });
        }
      },
    },

    // Delete Comment
    {
      id: "ctx:deleteComment",
      label: "Delete Comment",
      group: ANNOTATION_GROUP,
      order: ANNOTATION_ORDER_BASE + 11,
      visible: (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return false;
        return !!getCommentIndicatorAt(ctx.clickedCell.row, ctx.clickedCell.col);
      },
      onClick: async (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return;
        const { row, col } = ctx.clickedCell;
        const comment = await getComment(row, col);
        if (comment) {
          await deleteComment(comment.id);
          await refreshAnnotationState();
          emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
          emitAppEvent(AppEvents.GRID_REFRESH);
        }
      },
    },

    // Resolve / Reopen Comment
    {
      id: "ctx:resolveComment",
      label: (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return "Resolve Comment";
        const indicator = getCommentIndicatorAt(ctx.clickedCell.row, ctx.clickedCell.col);
        return indicator?.resolved ? "Reopen Comment" : "Resolve Comment";
      },
      group: ANNOTATION_GROUP,
      order: ANNOTATION_ORDER_BASE + 12,
      visible: (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return false;
        return !!getCommentIndicatorAt(ctx.clickedCell.row, ctx.clickedCell.col);
      },
      separatorAfter: true,
      onClick: async (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return;
        const { row, col } = ctx.clickedCell;
        const comment = await getComment(row, col);
        if (comment) {
          await resolveComment(comment.id, !comment.resolved);
          await refreshAnnotationState();
          emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
          emitAppEvent(AppEvents.GRID_REFRESH);
        }
      },
    },

    // Edit Note
    {
      id: "ctx:editNote",
      label: "Edit Note",
      group: ANNOTATION_GROUP,
      order: ANNOTATION_ORDER_BASE + 20,
      visible: (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return false;
        return !!getNoteIndicatorAt(ctx.clickedCell.row, ctx.clickedCell.col);
      },
      onClick: async (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return;
        const { row, col } = ctx.clickedCell;
        const note = await getNote(row, col);
        if (note) {
          showOverlay("note-editor", {
            data: { row, col, noteId: note.id, mode: "edit" },
            anchorRect: { x: 0, y: 0, width: 0, height: 0 },
          });
        }
      },
    },

    // Delete Note
    {
      id: "ctx:deleteNote",
      label: "Delete Note",
      group: ANNOTATION_GROUP,
      order: ANNOTATION_ORDER_BASE + 21,
      visible: (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return false;
        return !!getNoteIndicatorAt(ctx.clickedCell.row, ctx.clickedCell.col);
      },
      onClick: async (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return;
        const { row, col } = ctx.clickedCell;
        const note = await getNote(row, col);
        if (note) {
          await deleteNote(note.id);
          await refreshAnnotationState();
          emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
          emitAppEvent(AppEvents.GRID_REFRESH);
        }
      },
    },

    // Convert Note to Comment
    {
      id: "ctx:convertNoteToComment",
      label: "Convert Note to Comment",
      group: ANNOTATION_GROUP,
      order: ANNOTATION_ORDER_BASE + 22,
      visible: (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return false;
        return !!getNoteIndicatorAt(ctx.clickedCell.row, ctx.clickedCell.col);
      },
      separatorAfter: true,
      onClick: async (ctx: GridMenuContext) => {
        if (!ctx.clickedCell) return;
        const { row, col } = ctx.clickedCell;
        const note = await getNote(row, col);
        if (note) {
          await convertNoteToComment(note.id, DEFAULT_COMMENT_AUTHOR.email);
          await refreshAnnotationState();
          emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
          emitAppEvent(AppEvents.GRID_REFRESH);
        }
      },
    },
  ];

  gridExtensions.registerContextMenuItems(items);
}

export function unregisterAnnotationContextMenuItems(): void {
  const ids = [
    "ctx:newComment",
    "ctx:newNote",
    "ctx:editComment",
    "ctx:deleteComment",
    "ctx:resolveComment",
    "ctx:editNote",
    "ctx:deleteNote",
    "ctx:convertNoteToComment",
  ];
  for (const id of ids) {
    gridExtensions.unregisterContextMenuItem(id);
  }
}
