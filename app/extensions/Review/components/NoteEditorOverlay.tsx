//! FILENAME: app/extensions/Review/components/NoteEditorOverlay.tsx
// PURPOSE: Floating yellow sticky-note editor overlay.
// CONTEXT: Opens when user creates/edits a note. Supports content editing and resizing.

import React, { useEffect, useRef, useState, useCallback } from "react";
import type { OverlayProps } from "../../../src/api";
import {
  updateNote,
  getNote,
  resizeNote,
  hideOverlay,
  emitAppEvent,
  AppEvents,
  restoreFocusToGrid,
} from "../../../src/api";
import { refreshAnnotationState } from "../lib/annotationStore";

// ============================================================================
// Constants
// ============================================================================

const MIN_WIDTH = 120;
const MIN_HEIGHT = 60;
const DEFAULT_WIDTH = 200;
const DEFAULT_HEIGHT = 100;

// ============================================================================
// Styles
// ============================================================================

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  backgroundColor: "#FFFFA5",
  border: "1px solid #D4D400",
  borderRadius: 2,
  boxShadow: "2px 2px 6px rgba(0, 0, 0, 0.2)",
  display: "flex",
  flexDirection: "column",
  zIndex: 1000,
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "4px 6px",
  fontSize: 11,
  color: "#666",
  backgroundColor: "#F5F5A0",
  borderBottom: "1px solid #D4D400",
  cursor: "default",
  userSelect: "none",
};

const textareaStyle: React.CSSProperties = {
  flex: 1,
  border: "none",
  outline: "none",
  resize: "none",
  backgroundColor: "transparent",
  fontFamily: "Tahoma, Arial, sans-serif",
  fontSize: 12,
  lineHeight: "1.4",
  padding: "4px 6px",
  color: "#333",
};

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 14,
  color: "#888",
  padding: "0 2px",
  lineHeight: 1,
};

const resizeHandleStyle: React.CSSProperties = {
  position: "absolute",
  right: 0,
  bottom: 0,
  width: 12,
  height: 12,
  cursor: "nwse-resize",
};

// ============================================================================
// Component
// ============================================================================

interface NoteEditorData {
  row: number;
  col: number;
  noteId?: string;
  mode: "create" | "edit";
}

const NoteEditorOverlay: React.FC<OverlayProps> = ({ data, anchorRect }) => {
  const editorData = data as unknown as NoteEditorData;
  const { row, col, noteId, mode } = editorData;

  const [content, setContent] = useState("");
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [authorName, setAuthorName] = useState("");
  const [currentNoteId, setCurrentNoteId] = useState(noteId || "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });

  // Load note content
  useEffect(() => {
    async function loadNote() {
      if (!currentNoteId && noteId) {
        setCurrentNoteId(noteId);
      }

      const nId = noteId || currentNoteId;
      if (!nId) return;

      const note = await getNote(row, col);
      if (note) {
        setContent(note.content);
        setWidth(note.width);
        setHeight(note.height);
        setAuthorName(note.authorName);
        setCurrentNoteId(note.id);
      }
    }
    loadNote();
  }, [row, col, noteId]);

  // Focus textarea on mount
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      if (mode === "edit") {
        textareaRef.current.setSelectionRange(
          textareaRef.current.value.length,
          textareaRef.current.value.length
        );
      }
    }
  }, [mode]);

  // Save and close
  const saveAndClose = useCallback(async () => {
    if (currentNoteId && content.trim()) {
      await updateNote({ noteId: currentNoteId, content });
      await refreshAnnotationState();
      emitAppEvent(AppEvents.ANNOTATIONS_CHANGED);
      emitAppEvent(AppEvents.GRID_REFRESH);
    }
    hideOverlay("note-editor");
    restoreFocusToGrid();
  }, [currentNoteId, content]);

  // Handle click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        saveAndClose();
      }
    }
    // Delay to avoid immediate close from the click that opened us
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [saveAndClose]);

  // Handle Escape key
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        saveAndClose();
      }
      // Prevent grid shortcuts while editing
      e.stopPropagation();
    },
    [saveAndClose]
  );

  // Resize handlers
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      isResizing.current = true;
      resizeStart.current = { x: e.clientX, y: e.clientY, w: width, h: height };

      const handleResizeMove = (ev: MouseEvent) => {
        if (!isResizing.current) return;
        const dx = ev.clientX - resizeStart.current.x;
        const dy = ev.clientY - resizeStart.current.y;
        setWidth(Math.max(MIN_WIDTH, resizeStart.current.w + dx));
        setHeight(Math.max(MIN_HEIGHT, resizeStart.current.h + dy));
      };

      const handleResizeUp = async () => {
        isResizing.current = false;
        document.removeEventListener("mousemove", handleResizeMove);
        document.removeEventListener("mouseup", handleResizeUp);

        if (currentNoteId) {
          const finalW = Math.max(MIN_WIDTH, width);
          const finalH = Math.max(MIN_HEIGHT, height);
          await resizeNote({ noteId: currentNoteId, width: finalW, height: finalH });
        }
      };

      document.addEventListener("mousemove", handleResizeMove);
      document.addEventListener("mouseup", handleResizeUp);
    },
    [width, height, currentNoteId]
  );

  // Calculate position - offset to the right and below the cell
  // Use viewport boundary detection to keep it on screen
  const posX = anchorRect?.x ?? 100;
  const posY = anchorRect?.y ?? 100;

  let left = posX + 10;
  let top = posY + 10;

  if (typeof window !== "undefined") {
    if (left + width > window.innerWidth - 20) {
      left = Math.max(10, posX - width - 10);
    }
    if (top + height > window.innerHeight - 20) {
      top = Math.max(10, posY - height - 10);
    }
  }

  return (
    <div
      ref={containerRef}
      style={{
        ...overlayStyle,
        left,
        top,
        width,
        height,
      }}
      onKeyDown={handleKeyDown}
    >
      <div style={headerStyle}>
        <span>{authorName || "User"}</span>
        <button style={closeButtonStyle} onClick={saveAndClose} title="Close">
          x
        </button>
      </div>
      <textarea
        ref={textareaRef}
        style={textareaStyle}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Type your note here..."
      />
      <div
        style={resizeHandleStyle}
        onMouseDown={handleResizeMouseDown}
        title="Drag to resize"
      />
    </div>
  );
};

export default NoteEditorOverlay;
