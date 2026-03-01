//! FILENAME: app/extensions/Review/components/CommentPanelOverlay.tsx
// PURPOSE: Floating comment thread panel overlay.
// CONTEXT: Opens when user creates/edits a threaded comment. Shows thread with replies.

import React, { useEffect, useRef, useState, useCallback } from "react";
import type { OverlayProps } from "../../../src/api";
import type { Comment, CommentReply } from "../../../src/api";
import {
  getComment,
  updateComment,
  deleteComment,
  resolveComment,
  addReply,
  deleteReply,
  hideOverlay,
  emitAppEvent,
  AppEvents,
  restoreFocusToGrid,
  DEFAULT_COMMENT_AUTHOR,
} from "../../../src/api";
import { refreshAnnotationState } from "../lib/annotationStore";

// ============================================================================
// Styles
// ============================================================================

const panelStyle: React.CSSProperties = {
  position: "absolute",
  backgroundColor: "#FFFFFF",
  border: "1px solid #E0E0E0",
  borderRadius: 6,
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
  width: 320,
  maxHeight: 400,
  display: "flex",
  flexDirection: "column",
  zIndex: 1000,
  overflow: "hidden",
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  fontSize: 13,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "8px 12px",
  borderBottom: "1px solid #E8E8E8",
  backgroundColor: "#FAFAFA",
};

const threadStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "8px 12px",
};

const messageStyle: React.CSSProperties = {
  marginBottom: 12,
  paddingBottom: 8,
  borderBottom: "1px solid #F0F0F0",
};

const authorStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 12,
  color: "#333",
};

const timestampStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#999",
  marginLeft: 8,
};

const contentStyle: React.CSSProperties = {
  marginTop: 4,
  color: "#444",
  lineHeight: "1.4",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const resolvedBadgeStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 10,
  backgroundColor: "#E8F5E9",
  color: "#2E7D32",
  fontSize: 10,
  fontWeight: 600,
  marginLeft: 8,
};

const replyInputContainerStyle: React.CSSProperties = {
  borderTop: "1px solid #E8E8E8",
  padding: "8px 12px",
  backgroundColor: "#FAFAFA",
};

const replyInputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid #DDD",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 12,
  outline: "none",
  resize: "none",
  fontFamily: "inherit",
  minHeight: 36,
  boxSizing: "border-box",
};

const buttonStyle: React.CSSProperties = {
  border: "none",
  borderRadius: 4,
  padding: "4px 12px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
};

const postButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#4A86C8",
  color: "#FFF",
  marginTop: 6,
};

const menuButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 16,
  color: "#888",
  padding: "0 4px",
};

const deleteButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: "transparent",
  color: "#D32F2F",
  fontSize: 11,
  padding: "2px 6px",
};

// ============================================================================
// Component
// ============================================================================

interface CommentPanelData {
  row: number;
  col: number;
  commentId?: string;
  mode: "create" | "edit";
}

const CommentPanelOverlay: React.FC<OverlayProps> = ({
  data,
  anchorRect,
}) => {
  const panelData = data as unknown as CommentPanelData;
  const { row, col, mode } = panelData;

  const [comment, setComment] = useState<Comment | null>(null);
  const [replyText, setReplyText] = useState("");
  const [editingContent, setEditingContent] = useState("");
  const [isEditingMain, setIsEditingMain] = useState(mode === "create");
  const [showMenu, setShowMenu] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  // Load comment
  useEffect(() => {
    async function loadComment() {
      const c = await getComment(row, col);
      if (c) {
        setComment(c);
        setEditingContent(c.content);
        if (mode === "create" && !c.content) {
          setIsEditingMain(true);
        }
      }
    }
    loadComment();
  }, [row, col, mode]);

  // Focus on mount
  useEffect(() => {
    if (isEditingMain && editInputRef.current) {
      editInputRef.current.focus();
    } else if (replyInputRef.current) {
      replyInputRef.current.focus();
    }
  }, [isEditingMain, comment]);

  const closePanel = useCallback(() => {
    hideOverlay("comment-panel");
    restoreFocusToGrid();
  }, []);

  // Handle click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        closePanel();
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [closePanel]);

  // Save main content
  const saveMainContent = async () => {
    if (!comment || !editingContent.trim()) return;
    await updateComment({ commentId: comment.id, content: editingContent });
    const updated = await getComment(row, col);
    setComment(updated);
    setIsEditingMain(false);
    await refreshAnnotationState();
    emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
    emitAppEvent(AppEvents.GRID_REFRESH);
  };

  // Post reply
  const postReply = async () => {
    if (!comment || !replyText.trim()) return;
    await addReply({
      commentId: comment.id,
      authorEmail: DEFAULT_COMMENT_AUTHOR.email,
      authorName: DEFAULT_COMMENT_AUTHOR.name,
      content: replyText,
    });
    setReplyText("");
    const updated = await getComment(row, col);
    setComment(updated);
    await refreshAnnotationState();
    emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
  };

  // Resolve/reopen
  const toggleResolve = async () => {
    if (!comment) return;
    await resolveComment(comment.id, !comment.resolved);
    const updated = await getComment(row, col);
    setComment(updated);
    setShowMenu(false);
    await refreshAnnotationState();
    emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
    emitAppEvent(AppEvents.GRID_REFRESH);
  };

  // Delete entire comment
  const handleDelete = async () => {
    if (!comment) return;
    await deleteComment(comment.id);
    await refreshAnnotationState();
    emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
    emitAppEvent(AppEvents.GRID_REFRESH);
    closePanel();
  };

  // Delete a reply
  const handleDeleteReply = async (replyId: string) => {
    if (!comment) return;
    await deleteReply(comment.id, replyId);
    const updated = await getComment(row, col);
    setComment(updated);
    await refreshAnnotationState();
    emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
  };

  // Format timestamp
  const formatTime = (iso: string): string => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  };

  // Handle key events
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePanel();
    }
    e.stopPropagation();
  };

  // Position
  const posX = anchorRect?.x ?? 100;
  const posY = anchorRect?.y ?? 100;
  let left = posX + 10;
  let top = posY + 10;
  if (typeof window !== "undefined") {
    if (left + 320 > window.innerWidth - 20) {
      left = Math.max(10, posX - 330);
    }
    if (top + 400 > window.innerHeight - 20) {
      top = Math.max(10, window.innerHeight - 420);
    }
  }

  if (!comment) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      style={{ ...panelStyle, left, top }}
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div style={headerStyle}>
        <span style={{ fontWeight: 600, fontSize: 12 }}>
          Comment
          {comment.resolved && <span style={resolvedBadgeStyle}>Resolved</span>}
        </span>
        <div>
          <button
            style={menuButtonStyle}
            onClick={() => setShowMenu(!showMenu)}
            title="More options"
          >
            ...
          </button>
          <button style={menuButtonStyle} onClick={closePanel} title="Close">
            x
          </button>
        </div>
      </div>

      {/* Menu dropdown */}
      {showMenu && (
        <div
          style={{
            position: "absolute",
            right: 12,
            top: 36,
            backgroundColor: "#FFF",
            border: "1px solid #DDD",
            borderRadius: 4,
            boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
            zIndex: 1001,
            minWidth: 140,
          }}
        >
          <div
            style={{ padding: "6px 12px", cursor: "pointer", fontSize: 12 }}
            onClick={toggleResolve}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "#F5F5F5")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "transparent")
            }
          >
            {comment.resolved ? "Reopen" : "Resolve"}
          </div>
          <div
            style={{
              padding: "6px 12px",
              cursor: "pointer",
              fontSize: 12,
              color: "#D32F2F",
            }}
            onClick={handleDelete}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "#FFF0F0")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "transparent")
            }
          >
            Delete thread
          </div>
        </div>
      )}

      {/* Thread */}
      <div style={threadStyle}>
        {/* Main comment */}
        <div style={messageStyle}>
          <div>
            <span style={authorStyle}>{comment.authorName}</span>
            <span style={timestampStyle}>{formatTime(comment.createdAt)}</span>
          </div>
          {isEditingMain ? (
            <div style={{ marginTop: 4 }}>
              <textarea
                ref={editInputRef}
                style={{ ...replyInputStyle, minHeight: 50 }}
                value={editingContent}
                onChange={(e) => setEditingContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    saveMainContent();
                  }
                }}
              />
              <button style={postButtonStyle} onClick={saveMainContent}>
                Save
              </button>
            </div>
          ) : (
            <div
              style={{ ...contentStyle, cursor: "pointer" }}
              onClick={() => {
                if (!comment.resolved) {
                  setIsEditingMain(true);
                  setEditingContent(comment.content);
                }
              }}
            >
              {comment.content || "(click to add text)"}
            </div>
          )}
        </div>

        {/* Replies */}
        {comment.replies.map((reply: CommentReply) => (
          <div key={reply.id} style={messageStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <span style={authorStyle}>{reply.authorName}</span>
                <span style={timestampStyle}>
                  {formatTime(reply.createdAt)}
                </span>
              </div>
              <button
                style={deleteButtonStyle}
                onClick={() => handleDeleteReply(reply.id)}
                title="Delete reply"
              >
                x
              </button>
            </div>
            <div style={contentStyle}>{reply.content}</div>
          </div>
        ))}
      </div>

      {/* Reply input (hidden when resolved) */}
      {!comment.resolved && (
        <div style={replyInputContainerStyle}>
          <textarea
            ref={replyInputRef}
            style={replyInputStyle}
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Reply..."
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                postReply();
              }
            }}
          />
          <button
            style={{
              ...postButtonStyle,
              opacity: replyText.trim() ? 1 : 0.5,
            }}
            onClick={postReply}
            disabled={!replyText.trim()}
          >
            Post
          </button>
        </div>
      )}
    </div>
  );
};

export default CommentPanelOverlay;
