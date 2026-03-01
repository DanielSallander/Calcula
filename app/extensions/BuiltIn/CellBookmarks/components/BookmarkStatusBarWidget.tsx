//! FILENAME: app/extensions/BuiltIn/CellBookmarks/components/BookmarkStatusBarWidget.tsx
// PURPOSE: Status bar indicator showing bookmark count.
// CONTEXT: Rendered in the right side of the status bar. Click opens the task pane.

import React, { useState, useEffect } from "react";
import { openTaskPane } from "../../../../src/api";
import { getBookmarkCount, onChange } from "../lib/bookmarkStore";

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
  const [count, setCount] = useState(getBookmarkCount());

  useEffect(() => {
    const cleanup = onChange(() => {
      setCount(getBookmarkCount());
    });
    return cleanup;
  }, []);

  // Don't render anything if there are no bookmarks
  if (count === 0) return null;

  return (
    <div
      style={widgetStyle}
      onClick={() => openTaskPane(TASK_PANE_ID)}
      title="Click to open Bookmarks panel"
    >
      <div style={dotStyle} />
      <span>
        {count} Bookmark{count !== 1 ? "s" : ""}
      </span>
    </div>
  );
};
