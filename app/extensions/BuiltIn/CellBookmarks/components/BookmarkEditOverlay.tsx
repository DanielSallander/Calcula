//! FILENAME: app/extensions/BuiltIn/CellBookmarks/components/BookmarkEditOverlay.tsx
// PURPOSE: Overlay component for editing a bookmark's label and color.
// CONTEXT: Shown as a popover when adding or editing a bookmark via context menu.

import React, { useState, useEffect, useRef } from "react";
import type { OverlayProps } from "../../../../src/api";
import { getBookmarkAt, updateBookmark, addBookmark } from "../lib/bookmarkStore";
import { BOOKMARK_DOT_COLORS, BOOKMARK_COLORS } from "../lib/bookmarkTypes";
import type { BookmarkColor } from "../lib/bookmarkTypes";
import { columnToLetter } from "../../../../src/api";
import { getGridStateSnapshot } from "../../../../src/api/grid";

// ============================================================================
// Styles
// ============================================================================

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  backgroundColor: "#FFF",
  border: "1px solid #D0D0D0",
  borderRadius: 6,
  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
  padding: 12,
  width: 220,
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  fontSize: 12,
  zIndex: 10000,
};

const labelInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 8px",
  fontSize: 12,
  border: "1px solid #CCC",
  borderRadius: 3,
  outline: "none",
  boxSizing: "border-box",
  marginBottom: 8,
};

const colorRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  marginBottom: 12,
};

const colorDotStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: "50%",
  cursor: "pointer",
  border: "2px solid transparent",
  transition: "border-color 0.15s",
};

const btnRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 6,
};

const btnStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: 11,
  border: "1px solid #CCC",
  borderRadius: 3,
  cursor: "pointer",
  backgroundColor: "#FFF",
};

const btnPrimaryStyle: React.CSSProperties = {
  ...btnStyle,
  backgroundColor: "#4A86C8",
  borderColor: "#4A86C8",
  color: "#FFF",
};

const titleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  marginBottom: 8,
  color: "#333",
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
  marginBottom: 4,
};

// ============================================================================
// Component
// ============================================================================

export const BookmarkEditOverlay: React.FC<OverlayProps> = ({ onClose, data, anchorRect }) => {
  const row = data?.row as number | undefined;
  const col = data?.col as number | undefined;
  const sheetIndex = data?.sheetIndex as number | undefined;

  const existing = row !== undefined && col !== undefined && sheetIndex !== undefined
    ? getBookmarkAt(row, col, sheetIndex)
    : undefined;

  const defaultLabel = row !== undefined && col !== undefined
    ? `${columnToLetter(col)}${row + 1}`
    : "";

  const [label, setLabel] = useState(existing?.label ?? defaultLabel);
  const [color, setColor] = useState<BookmarkColor>(existing?.color ?? "blue");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus and select all text on mount
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
  }, []);

  const handleSave = () => {
    if (existing) {
      updateBookmark(existing.id, { label: label.trim() || defaultLabel, color });
    } else if (row !== undefined && col !== undefined && sheetIndex !== undefined) {
      const state = getGridStateSnapshot();
      const sheetName = state?.sheetContext.activeSheetName ?? "Sheet1";
      addBookmark(row, col, sheetIndex, sheetName, { label: label.trim() || undefined, color });
    }
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSave();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  // Position the overlay near the anchor or centered
  const posStyle: React.CSSProperties = anchorRect
    ? { top: anchorRect.y + anchorRect.height + 4, left: anchorRect.x }
    : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };

  return (
    <div style={{ ...overlayStyle, ...posStyle }} onKeyDown={handleKeyDown}>
      <div style={titleStyle}>
        {existing ? "Edit Bookmark" : "Add Bookmark"}
      </div>

      <div style={fieldLabelStyle}>Label</div>
      <input
        ref={inputRef}
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        style={labelInputStyle}
        placeholder={defaultLabel}
      />

      <div style={fieldLabelStyle}>Color</div>
      <div style={colorRowStyle}>
        {BOOKMARK_COLORS.map((c) => (
          <div
            key={c}
            style={{
              ...colorDotStyle,
              backgroundColor: BOOKMARK_DOT_COLORS[c],
              borderColor: color === c ? "#333" : "transparent",
            }}
            onClick={() => setColor(c)}
            title={c}
          />
        ))}
      </div>

      <div style={btnRowStyle}>
        <button style={btnStyle} onClick={onClose}>
          Cancel
        </button>
        <button style={btnPrimaryStyle} onClick={handleSave}>
          Save
        </button>
      </div>
    </div>
  );
};
