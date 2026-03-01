//! FILENAME: app/extensions/Review/components/CommentsSidebar.tsx
// PURPOSE: Task pane sidebar showing all comments and notes on the current sheet.
// CONTEXT: Opened via Review menu "Show All Comments" or the comments button.

import React, { useEffect, useState, useCallback } from "react";
import type { Comment, Note, TaskPaneViewProps } from "../../../src/api";
import {
  getAllComments,
  getAllNotes,
  resolveComment,
  deleteComment,
  deleteNote,
  showOverlay,
  emitAppEvent,
  AppEvents,
} from "../../../src/api";
import { refreshAnnotationState } from "../lib/annotationStore";

// ============================================================================
// Styles
// ============================================================================

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  fontSize: 12,
  backgroundColor: "#FAFAFA",
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  borderBottom: "1px solid #E0E0E0",
  backgroundColor: "#FFF",
};

const tabStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  textAlign: "center",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
  color: "#666",
  borderBottom: "2px solid transparent",
  transition: "all 0.15s",
};

const activeTabStyle: React.CSSProperties = {
  ...tabStyle,
  color: "#4A86C8",
  borderBottomColor: "#4A86C8",
};

const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 8,
};

const itemStyle: React.CSSProperties = {
  backgroundColor: "#FFF",
  border: "1px solid #E8E8E8",
  borderRadius: 4,
  padding: "8px 10px",
  marginBottom: 6,
  cursor: "pointer",
  transition: "border-color 0.15s",
};

const cellRefStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#4A86C8",
  fontWeight: 600,
  marginBottom: 4,
};

const previewTextStyle: React.CSSProperties = {
  color: "#444",
  lineHeight: "1.3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const metaStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginTop: 4,
  fontSize: 10,
  color: "#999",
};

const actionBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 10,
  padding: "2px 4px",
  color: "#888",
};

const emptyStyle: React.CSSProperties = {
  textAlign: "center",
  padding: "24px 12px",
  color: "#999",
  fontSize: 12,
};

// ============================================================================
// Helpers
// ============================================================================

function indexToColLetter(index: number): string {
  let col = "";
  let i = index;
  while (i >= 0) {
    col = String.fromCharCode(65 + (i % 26)) + col;
    i = Math.floor(i / 26) - 1;
  }
  return col;
}

function cellRef(row: number, colNum: number): string {
  return `${indexToColLetter(colNum)}${row + 1}`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

// ============================================================================
// Component
// ============================================================================

type Tab = "comments" | "notes";

const CommentsSidebar: React.FC<TaskPaneViewProps> = () => {
  const [activeTab, setActiveTab] = useState<Tab>("comments");
  const [comments, setComments] = useState<Comment[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [showResolved, setShowResolved] = useState(true);

  const loadData = useCallback(async () => {
    const [c, n] = await Promise.all([getAllComments(), getAllNotes()]);
    // Sort by position (row-major)
    c.sort((a, b) => a.row - b.row || a.col - b.col);
    n.sort((a, b) => a.row - b.row || a.col - b.col);
    setComments(c);
    setNotes(n);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Listen for annotation changes
  useEffect(() => {
    function handleChange() {
      loadData();
    }
    window.addEventListener("app:annotations-changed", handleChange);
    return () =>
      window.removeEventListener("app:annotations-changed", handleChange);
  }, [loadData]);

  const handleCommentClick = (comment: Comment) => {
    // Navigate to cell
    emitAppEvent(AppEvents.NAVIGATE_TO_CELL, {
      row: comment.row,
      col: comment.col,
    });
    // Open comment panel
    showOverlay("comment-panel", {
      data: {
        row: comment.row,
        col: comment.col,
        commentId: comment.id,
        mode: "edit",
      },
      anchorRect: { x: 0, y: 0, width: 0, height: 0 },
    });
  };

  const handleNoteClick = (note: Note) => {
    emitAppEvent(AppEvents.NAVIGATE_TO_CELL, {
      row: note.row,
      col: note.col,
    });
    showOverlay("note-editor", {
      data: {
        row: note.row,
        col: note.col,
        noteId: note.id,
        mode: "edit",
      },
      anchorRect: { x: 0, y: 0, width: 0, height: 0 },
    });
  };

  const handleResolveComment = async (
    e: React.MouseEvent,
    comment: Comment
  ) => {
    e.stopPropagation();
    await resolveComment(comment.id, !comment.resolved);
    await refreshAnnotationState();
    emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
    emitAppEvent(AppEvents.GRID_REFRESH);
    loadData();
  };

  const handleDeleteComment = async (
    e: React.MouseEvent,
    comment: Comment
  ) => {
    e.stopPropagation();
    await deleteComment(comment.id);
    await refreshAnnotationState();
    emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
    emitAppEvent(AppEvents.GRID_REFRESH);
    loadData();
  };

  const handleDeleteNote = async (e: React.MouseEvent, note: Note) => {
    e.stopPropagation();
    await deleteNote(note.id);
    await refreshAnnotationState();
    emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
    emitAppEvent(AppEvents.GRID_REFRESH);
    loadData();
  };

  const filteredComments = showResolved
    ? comments
    : comments.filter((c) => !c.resolved);

  return (
    <div style={containerStyle}>
      {/* Tab bar */}
      <div style={tabBarStyle}>
        <div
          style={activeTab === "comments" ? activeTabStyle : tabStyle}
          onClick={() => setActiveTab("comments")}
        >
          Comments ({comments.length})
        </div>
        <div
          style={activeTab === "notes" ? activeTabStyle : tabStyle}
          onClick={() => setActiveTab("notes")}
        >
          Notes ({notes.length})
        </div>
      </div>

      {/* Content */}
      <div style={listStyle}>
        {activeTab === "comments" && (
          <>
            {/* Filter bar */}
            <div
              style={{
                padding: "4px 0 8px",
                fontSize: 11,
                color: "#888",
              }}
            >
              <label style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={showResolved}
                  onChange={(e) => setShowResolved(e.target.checked)}
                  style={{ marginRight: 4 }}
                />
                Show resolved
              </label>
            </div>

            {filteredComments.length === 0 ? (
              <div style={emptyStyle}>No comments on this sheet.</div>
            ) : (
              filteredComments.map((comment) => (
                <div
                  key={comment.id}
                  style={{
                    ...itemStyle,
                    borderLeftColor: comment.resolved ? "#A0A0A0" : "#7B68EE",
                    borderLeftWidth: 3,
                    opacity: comment.resolved ? 0.7 : 1,
                  }}
                  onClick={() => handleCommentClick(comment)}
                >
                  <div style={cellRefStyle}>
                    {cellRef(comment.row, comment.col)}
                  </div>
                  <div style={previewTextStyle}>
                    {comment.content || "(empty)"}
                  </div>
                  <div style={metaStyle}>
                    <span>
                      {comment.authorName} -{" "}
                      {formatTimestamp(comment.createdAt)}
                      {comment.replies.length > 0 &&
                        ` - ${comment.replies.length} replies`}
                    </span>
                    <span>
                      <button
                        style={actionBtnStyle}
                        onClick={(e) => handleResolveComment(e, comment)}
                        title={comment.resolved ? "Reopen" : "Resolve"}
                      >
                        {comment.resolved ? "Reopen" : "Resolve"}
                      </button>
                      <button
                        style={{ ...actionBtnStyle, color: "#D32F2F" }}
                        onClick={(e) => handleDeleteComment(e, comment)}
                        title="Delete"
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                </div>
              ))
            )}
          </>
        )}

        {activeTab === "notes" && (
          <>
            {notes.length === 0 ? (
              <div style={emptyStyle}>No notes on this sheet.</div>
            ) : (
              notes.map((note) => (
                <div
                  key={note.id}
                  style={{
                    ...itemStyle,
                    borderLeftColor: "#FF0000",
                    borderLeftWidth: 3,
                  }}
                  onClick={() => handleNoteClick(note)}
                >
                  <div style={cellRefStyle}>
                    {cellRef(note.row, note.col)}
                  </div>
                  <div style={previewTextStyle}>
                    {note.content || "(empty)"}
                  </div>
                  <div style={metaStyle}>
                    <span>
                      {note.authorName} - {formatTimestamp(note.createdAt)}
                    </span>
                    <button
                      style={{ ...actionBtnStyle, color: "#D32F2F" }}
                      onClick={(e) => handleDeleteNote(e, note)}
                      title="Delete"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default CommentsSidebar;
