//! FILENAME: app/extensions/BuiltIn/CellBookmarks/components/ViewBookmarkList.tsx
// PURPOSE: List view for view bookmarks inside the task pane.
// CONTEXT: Displayed as the "Views" tab in the BookmarkTaskPane.

import React, { useState, useEffect, useCallback } from "react";
import {
  getSortedViewBookmarks,
  removeViewBookmark,
  activateViewBookmark,
  onViewBookmarkChange,
} from "../lib/viewBookmarkStore";
import { BOOKMARK_DOT_COLORS, BOOKMARK_COLORS } from "../lib/bookmarkTypes";
import type { BookmarkColor } from "../lib/bookmarkTypes";
import type { ViewBookmark, ViewStateDimensions } from "../lib/viewBookmarkTypes";
import { DIMENSION_LABELS } from "../lib/viewBookmarkTypes";
import { showOverlay, showToast } from "@api";

// ============================================================================
// Constants
// ============================================================================

const VIEW_BOOKMARK_EDIT_OVERLAY_ID = "view-bookmark-editor";

// ============================================================================
// Styles
// ============================================================================

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
  alignItems: "flex-start",
  gap: 8,
  transition: "border-color 0.15s",
};

const dotStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  flexShrink: 0,
  marginTop: 3,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#333",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const descStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#888",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  marginTop: 2,
};

const badgeContainerStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 3,
  marginTop: 4,
};

const badgeStyle: React.CSSProperties = {
  fontSize: 9,
  color: "#666",
  backgroundColor: "#F0F0F0",
  borderRadius: 3,
  padding: "1px 5px",
  whiteSpace: "nowrap",
};

const actionBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "#999",
  fontSize: 13,
  padding: "0 3px",
  lineHeight: 1,
  flexShrink: 0,
};

const scriptBadgeStyle: React.CSSProperties = {
  ...badgeStyle,
  backgroundColor: "#E8F0FE",
  color: "#4A86C8",
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

const clearBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "#999",
  fontSize: 11,
  padding: "0 4px",
  lineHeight: 1,
};

const emptyStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flex: 1,
  color: "#999",
  fontSize: 12,
  fontStyle: "italic",
  padding: "24px 0",
};

// ============================================================================
// Helpers
// ============================================================================

function getActiveDimensionLabels(dims: ViewStateDimensions): string[] {
  const labels: string[] = [];
  for (const [key, enabled] of Object.entries(dims)) {
    if (enabled) {
      labels.push(DIMENSION_LABELS[key as keyof ViewStateDimensions]);
    }
  }
  return labels;
}

// ============================================================================
// Component
// ============================================================================

export const ViewBookmarkList: React.FC = () => {
  const [viewBookmarks, setViewBookmarks] = useState<ViewBookmark[]>([]);
  const [colorFilter, setColorFilter] = useState<BookmarkColor | null>(null);

  const refresh = useCallback(() => {
    const all = getSortedViewBookmarks();
    const filtered = colorFilter ? all.filter((vb) => vb.color === colorFilter) : all;
    setViewBookmarks(filtered);
  }, [colorFilter]);

  useEffect(() => {
    refresh();
    const cleanup = onViewBookmarkChange(refresh);
    return cleanup;
  }, [refresh]);

  const handleActivate = async (vb: ViewBookmark) => {
    const success = await activateViewBookmark(vb.id);
    if (success) {
      showToast(`View "${vb.label}" activated`, { variant: "success" });
    }
  };

  const handleEdit = (e: React.MouseEvent, vb: ViewBookmark) => {
    e.stopPropagation();
    showOverlay(VIEW_BOOKMARK_EDIT_OVERLAY_ID, { data: { viewBookmarkId: vb.id } });
  };

  const handleDelete = (e: React.MouseEvent, vb: ViewBookmark) => {
    e.stopPropagation();
    removeViewBookmark(vb.id);
    showToast(`View "${vb.label}" removed`, { variant: "info" });
  };

  const toggleColorFilter = (color: BookmarkColor) => {
    setColorFilter((prev) => (prev === color ? null : color));
  };

  return (
    <>
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
            style={clearBtnStyle}
            onClick={() => setColorFilter(null)}
            title="Clear filter"
          >
            Clear
          </button>
        )}
      </div>

      {/* View bookmark list */}
      <div style={listStyle}>
        {viewBookmarks.length === 0 ? (
          <div style={emptyStyle}>
            {colorFilter ? "No views with this color" : "No saved views yet"}
          </div>
        ) : (
          viewBookmarks.map((vb) => (
            <div
              key={vb.id}
              style={itemStyle}
              onClick={() => handleActivate(vb)}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "#4A86C8";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "#E8E8E8";
              }}
            >
              <div
                style={{ ...dotStyle, backgroundColor: BOOKMARK_DOT_COLORS[vb.color] }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={labelStyle}>{vb.label}</div>
                {vb.description && <div style={descStyle}>{vb.description}</div>}
                <div style={badgeContainerStyle}>
                  {getActiveDimensionLabels(vb.dimensions).map((dimLabel) => (
                    <span key={dimLabel} style={badgeStyle}>
                      {dimLabel}
                    </span>
                  ))}
                  {vb.onActivateScriptId && (
                    <span style={scriptBadgeStyle}>Script</span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <button
                  style={actionBtnStyle}
                  onClick={(e) => handleEdit(e, vb)}
                  title="Edit view bookmark"
                >
                  ...
                </button>
                <button
                  style={actionBtnStyle}
                  onClick={(e) => handleDelete(e, vb)}
                  title="Remove view bookmark"
                >
                  x
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
};
