//! FILENAME: app/extensions/BuiltIn/CellBookmarks/components/BookmarkTaskPane.tsx
// PURPOSE: Task pane component listing all bookmarks with click-to-navigate.
// CONTEXT: Registered as a task pane view with contextKey "always".

import React, { useState, useEffect, useCallback } from "react";
import type { TaskPaneViewProps } from "../../../../src/api";
import {
  getAllBookmarks,
  getBookmarksForSheet,
  removeBookmarkById,
  onChange,
  getCurrentSheet,
} from "../lib/bookmarkStore";
import { navigateToBookmark } from "../lib/bookmarkNavigation";
import { BOOKMARK_DOT_COLORS, BOOKMARK_COLORS } from "../lib/bookmarkTypes";
import type { Bookmark, BookmarkColor } from "../lib/bookmarkTypes";

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

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 12px",
  borderBottom: "1px solid #E0E0E0",
  backgroundColor: "#FFF",
};

const filterBarStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  padding: "6px 12px",
  borderBottom: "1px solid #F0F0F0",
  backgroundColor: "#FFF",
};

const filterDotStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: "50%",
  cursor: "pointer",
  border: "2px solid transparent",
  transition: "border-color 0.15s",
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
  display: "flex",
  alignItems: "center",
  gap: 8,
  transition: "border-color 0.15s",
};

const dotStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  flexShrink: 0,
};

const labelStyle: React.CSSProperties = {
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#333",
};

const cellRefStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#4A86C8",
  fontWeight: 600,
};

const deleteBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "#999",
  fontSize: 14,
  padding: "0 4px",
  lineHeight: 1,
  flexShrink: 0,
};

const emptyStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flex: 1,
  color: "#999",
  fontSize: 12,
  fontStyle: "italic",
};

const scopeToggleStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  padding: "6px 12px",
  borderBottom: "1px solid #F0F0F0",
  backgroundColor: "#FFF",
};

const scopeBtnStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  border: "1px solid #DDD",
  borderRadius: 3,
  cursor: "pointer",
  backgroundColor: "#FFF",
  color: "#666",
};

const scopeBtnActiveStyle: React.CSSProperties = {
  ...scopeBtnStyle,
  backgroundColor: "#4A86C8",
  borderColor: "#4A86C8",
  color: "#FFF",
};

// ============================================================================
// Component
// ============================================================================

type Scope = "sheet" | "all";

export const BookmarkTaskPane: React.FC<TaskPaneViewProps> = () => {
  const [bookmarkList, setBookmarkList] = useState<Bookmark[]>([]);
  const [colorFilter, setColorFilter] = useState<BookmarkColor | null>(null);
  const [scope, setScope] = useState<Scope>("all");

  const refresh = useCallback(() => {
    const all = scope === "all" ? getAllBookmarks() : getBookmarksForSheet(getCurrentSheet());
    const filtered = colorFilter ? all.filter((bm) => bm.color === colorFilter) : all;
    // Sort by sheet, row, col
    filtered.sort((a, b) => {
      if (a.sheetIndex !== b.sheetIndex) return a.sheetIndex - b.sheetIndex;
      if (a.row !== b.row) return a.row - b.row;
      return a.col - b.col;
    });
    setBookmarkList(filtered);
  }, [colorFilter, scope]);

  useEffect(() => {
    refresh();
    const cleanup = onChange(refresh);
    return cleanup;
  }, [refresh]);

  const handleClick = (bookmark: Bookmark) => {
    navigateToBookmark(bookmark);
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    removeBookmarkById(id);
  };

  const toggleColorFilter = (color: BookmarkColor) => {
    setColorFilter((prev) => (prev === color ? null : color));
  };

  return (
    <div style={containerStyle}>
      {/* Scope toggle */}
      <div style={scopeToggleStyle}>
        <button
          style={scope === "all" ? scopeBtnActiveStyle : scopeBtnStyle}
          onClick={() => setScope("all")}
        >
          All Sheets
        </button>
        <button
          style={scope === "sheet" ? scopeBtnActiveStyle : scopeBtnStyle}
          onClick={() => setScope("sheet")}
        >
          This Sheet
        </button>
      </div>

      {/* Color filter */}
      <div style={filterBarStyle}>
        {BOOKMARK_COLORS.map((color) => (
          <div
            key={color}
            style={{
              ...filterDotStyle,
              backgroundColor: BOOKMARK_DOT_COLORS[color],
              borderColor: colorFilter === color ? "#333" : "transparent",
              opacity: colorFilter && colorFilter !== color ? 0.3 : 1,
            }}
            onClick={() => toggleColorFilter(color)}
            title={`Filter: ${color}`}
          />
        ))}
        {colorFilter && (
          <button
            style={{ ...deleteBtnStyle, fontSize: 11 }}
            onClick={() => setColorFilter(null)}
            title="Clear filter"
          >
            Clear
          </button>
        )}
      </div>

      {/* Bookmark list */}
      <div style={listStyle}>
        {bookmarkList.length === 0 ? (
          <div style={emptyStyle}>
            {colorFilter ? "No bookmarks with this color" : "No bookmarks yet"}
          </div>
        ) : (
          bookmarkList.map((bm) => (
            <div
              key={bm.id}
              style={itemStyle}
              onClick={() => handleClick(bm)}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "#4A86C8";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "#E8E8E8";
              }}
            >
              <div
                style={{
                  ...dotStyle,
                  backgroundColor: BOOKMARK_DOT_COLORS[bm.color],
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={cellRefStyle}>
                  {bm.sheetName}!{bm.label}
                </div>
                {bm.label !== `${bm.sheetName}!${bm.label}` && (
                  <div style={labelStyle}>{bm.label}</div>
                )}
              </div>
              <button
                style={deleteBtnStyle}
                onClick={(e) => handleDelete(e, bm.id)}
                title="Remove bookmark"
              >
                x
              </button>
            </div>
          ))
        )}
      </div>

      {/* Footer with count */}
      <div style={headerStyle}>
        <span style={{ color: "#999", fontSize: 11 }}>
          {bookmarkList.length} bookmark{bookmarkList.length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
};
