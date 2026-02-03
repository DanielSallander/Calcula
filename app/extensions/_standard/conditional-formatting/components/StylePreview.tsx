//! FILENAME: app/extensions/_standard/conditional-formatting/components/StylePreview.tsx
// PURPOSE: Visual preview of a conditional formatting style
// CONTEXT: Shows a sample of how the formatting will look

import React from "react";
import type { IStyleOverride } from "../../../../src/api/styleInterceptors";

// ============================================================================
// Props
// ============================================================================

export interface StylePreviewProps {
  style: IStyleOverride;
  size?: "small" | "medium" | "large";
  showLabel?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function StylePreview({ 
  style, 
  size = "medium",
  showLabel = false,
}: StylePreviewProps): React.ReactElement {
  const dimensions = {
    small: { width: 20, height: 16, fontSize: 9 },
    medium: { width: 32, height: 20, fontSize: 11 },
    large: { width: "100%", height: 32, fontSize: 13 },
  };
  
  const dim = dimensions[size];
  
  const containerStyle: React.CSSProperties = {
    width: dim.width,
    height: dim.height,
    backgroundColor: style.backgroundColor || "#ffffff",
    color: style.textColor || "#000000",
    fontWeight: style.bold ? "bold" : "normal",
    fontStyle: style.italic ? "italic" : "normal",
    textDecoration: [
      style.underline ? "underline" : "",
      style.strikethrough ? "line-through" : "",
    ].filter(Boolean).join(" ") || "none",
    fontSize: dim.fontSize,
    fontFamily: style.fontFamily || "inherit",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid #d0d0d0",
    borderRadius: "2px",
    overflow: "hidden",
  };
  
  return (
    <div style={containerStyle}>
      {showLabel ? "AaBbCc" : "Ab"}
    </div>
  );
}