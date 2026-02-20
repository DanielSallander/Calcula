//! FILENAME: app/extensions/DataValidation/components/InputPromptTooltip.tsx
// PURPOSE: Tooltip overlay shown when a cell with an input prompt is selected.
// CONTEXT: Displays the prompt title and message near the active cell.

import React, { useEffect, useRef } from "react";
import type { OverlayProps } from "../../../src/api";

// ============================================================================
// Styles
// ============================================================================

const containerStyle: React.CSSProperties = {
  position: "fixed",
  backgroundColor: "#ffffd0",
  border: "1px solid #c0c000",
  boxShadow: "1px 2px 6px rgba(0, 0, 0, 0.15)",
  padding: "8px 10px",
  minWidth: 140,
  maxWidth: 280,
  fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  fontSize: 12,
  zIndex: 8000,
  pointerEvents: "none",
};

const titleStyle: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 12,
  marginBottom: 4,
  color: "#333",
};

const messageStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#444",
  lineHeight: 1.4,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

// ============================================================================
// Types
// ============================================================================

interface PromptTooltipData {
  title: string;
  message: string;
}

// ============================================================================
// Component
// ============================================================================

export default function InputPromptTooltip(props: OverlayProps) {
  const { anchorRect, data } = props;
  const promptData = data as unknown as PromptTooltipData | undefined;
  const containerRef = useRef<HTMLDivElement>(null);

  // Adjust position to avoid going off-screen
  useEffect(() => {
    if (!containerRef.current || !anchorRect) return;

    const el = containerRef.current;
    const rect = el.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // If tooltip goes off the right edge, move it left
    if (rect.right > viewportWidth - 8) {
      el.style.left = `${viewportWidth - rect.width - 8}px`;
    }
    // If tooltip goes off the bottom edge, show above the cell instead
    if (rect.bottom > viewportHeight - 8) {
      el.style.top = `${anchorRect.y - rect.height - 4}px`;
    }
  }, [anchorRect]);

  if (!promptData || (!promptData.title && !promptData.message)) {
    return null;
  }

  // Position below and slightly right of the cell
  const positionStyle: React.CSSProperties = anchorRect
    ? {
        left: anchorRect.x + 4,
        top: anchorRect.y + anchorRect.height + 4,
      }
    : {
        left: 100,
        top: 100,
      };

  return (
    <div ref={containerRef} style={{ ...containerStyle, ...positionStyle }}>
      {promptData.title && <div style={titleStyle}>{promptData.title}</div>}
      {promptData.message && <div style={messageStyle}>{promptData.message}</div>}
    </div>
  );
}
