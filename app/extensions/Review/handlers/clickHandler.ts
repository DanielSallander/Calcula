//! FILENAME: app/extensions/Review/handlers/clickHandler.ts
// PURPOSE: Cell click interceptor for annotation indicators.
// CONTEXT: When a user clicks on a cell with an annotation, opens the editor overlay.

import {
  showOverlay,
  getComment,
  getNote,
} from "../../../src/api";
import {
  getCommentIndicatorAt,
  getNoteIndicatorAt,
} from "../lib/annotationStore";
import { hidePreview } from "./hoverHandler";

/**
 * Cell click interceptor callback.
 * Registered via registerCellClickInterceptor.
 * Returns true if the click was handled (prevents default cell selection behavior).
 */
export async function handleAnnotationClick(
  row: number,
  col: number,
  event: { clientX: number; clientY: number }
): Promise<boolean> {
  // Check if this cell has an annotation
  const hasCommentIndicator = getCommentIndicatorAt(row, col);
  const hasNoteIndicator = getNoteIndicatorAt(row, col);

  if (!hasCommentIndicator && !hasNoteIndicator) {
    return false;
  }

  // Hide any hover preview
  hidePreview();

  // Open the appropriate editor
  if (hasCommentIndicator) {
    const comment = await getComment(row, col);
    if (comment) {
      showOverlay("comment-panel", {
        data: {
          row,
          col,
          commentId: comment.id,
          mode: "edit",
        },
        anchorRect: {
          x: event.clientX,
          y: event.clientY,
          width: 0,
          height: 0,
        },
      });
      // Don't intercept - still allow cell selection
      return false;
    }
  } else if (hasNoteIndicator) {
    const note = await getNote(row, col);
    if (note) {
      showOverlay("note-editor", {
        data: {
          row,
          col,
          noteId: note.id,
          mode: "edit",
        },
        anchorRect: {
          x: event.clientX,
          y: event.clientY,
          width: 0,
          height: 0,
        },
      });
      // Don't intercept - still allow cell selection
      return false;
    }
  }

  return false;
}
