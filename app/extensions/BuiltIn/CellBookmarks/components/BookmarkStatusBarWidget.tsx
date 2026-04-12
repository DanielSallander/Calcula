//! FILENAME: app/extensions/BuiltIn/CellBookmarks/components/BookmarkStatusBarWidget.tsx
// PURPOSE: Status bar indicator showing bookmark count.
// CONTEXT: Rendered in the right side of the status bar. Click opens the task pane.

import React, { useState, useEffect } from "react";
import { openTaskPane } from "@api";
import { getBookmarkCount, onChange } from "../lib/bookmarkStore";
import { getViewBookmarkCount, onViewBookmarkChange } from "../lib/viewBookmarkStore";

const TASK_PANE_ID = "bookmarks-pane";

// ============================================================================
// Styles
// ============================================================================

const widgetStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "0 8px",
  cursor: "pointer",
  fontSize: 11,
  color: "#666",
  userSelect: "none",
  whiteSpace: "nowrap",
};

const dotStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  backgroundColor: "#4A86C8",
};

// ============================================================================
// Component
// ============================================================================

export const BookmarkStatusBarWidget: React.FC = () => {
  const [cellCount, setCellCount] = useState(getBookmarkCount());
  const [viewCount, setViewCount] = useState(getViewBookmarkCount());

  useEffect(() => {
    const cleanup1 = onChange(() => setCellCount(getBookmarkCount()));
    const cleanup2 = onViewBookmarkChange(() => setViewCount(getViewBookmarkCount()));
    return () => {
      cleanup1();
      cleanup2();
    };
  }, []);

  const total = cellCount + viewCount;
  if (total === 0) return null;

  const parts: string[] = [];
  if (cellCount > 0) parts.push(`${cellCount} cell`);
  if (viewCount > 0) parts.push(`${viewCount} view`);

  return (
    <div
      style={widgetStyle}
      onClick={() => openTaskPane(TASK_PANE_ID)}
      title="Click to open Bookmarks panel"
    >
      <div style={dotStyle} />
      <span>{parts.join(", ")}</span>
    </div>
  );
};
