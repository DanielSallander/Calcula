//! FILENAME: app/extensions/Review/components/AnnotationPreview.tsx
// PURPOSE: Hover tooltip showing a preview of a note or comment.
// CONTEXT: Appears when hovering over the annotation triangle indicator.

import React from "react";
import type { OverlayProps } from "../../../src/api";

// ============================================================================
// Styles
// ============================================================================

const tooltipBaseStyle: React.CSSProperties = {
  position: "absolute",
  borderRadius: 4,
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
  padding: "8px 10px",
  fontSize: 12,
  lineHeight: "1.4",
  maxWidth: 260,
  zIndex: 1100,
  pointerEvents: "none",
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const noteTooltipStyle: React.CSSProperties = {
  ...tooltipBaseStyle,
  backgroundColor: "#FFFFA5",
  border: "1px solid #D4D400",
  color: "#333",
};

const commentTooltipStyle: React.CSSProperties = {
  ...tooltipBaseStyle,
  backgroundColor: "#FFFFFF",
  border: "1px solid #DDD",
  color: "#333",
};

const authorStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 11,
  color: "#555",
  marginBottom: 4,
};

const resolvedBadgeStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 8,
  backgroundColor: "#E8F5E9",
  color: "#2E7D32",
  fontSize: 9,
  fontWeight: 600,
  marginLeft: 6,
};

const replyCountStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#888",
  marginTop: 4,
};

// ============================================================================
// Component
// ============================================================================

interface PreviewData {
  type: "note" | "comment";
  authorName: string;
  content: string;
  resolved?: boolean;
  replyCount?: number;
}

const AnnotationPreview: React.FC<OverlayProps> = ({
  data,
  anchorRect,
}) => {
  const previewData = data as unknown as PreviewData;
  if (!previewData) return null;

  const { type, authorName, content, resolved, replyCount } = previewData;

  // Truncate content for preview
  const preview =
    content.length > 150 ? content.substring(0, 150) + "..." : content;

  const style = type === "note" ? noteTooltipStyle : commentTooltipStyle;

  // Position below and to the right of the anchor
  const posX = anchorRect?.x ?? 0;
  const posY = anchorRect?.y ?? 0;
  let left = posX + 5;
  let top = posY + 5;

  if (typeof window !== "undefined") {
    if (left + 260 > window.innerWidth - 10) {
      left = Math.max(10, posX - 265);
    }
    if (top + 100 > window.innerHeight - 10) {
      top = Math.max(10, posY - 80);
    }
  }

  return (
    <div style={{ ...style, left, top }}>
      <div style={authorStyle}>
        {authorName}
        {resolved && <span style={resolvedBadgeStyle}>Resolved</span>}
      </div>
      <div>{preview || "(empty)"}</div>
      {type === "comment" && replyCount !== undefined && replyCount > 0 && (
        <div style={replyCountStyle}>
          {replyCount} {replyCount === 1 ? "reply" : "replies"}
        </div>
      )}
    </div>
  );
};

export default AnnotationPreview;
