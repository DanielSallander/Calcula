//! FILENAME: app/extensions/Controls/Shape/ShapeTemplateGallery.tsx
// PURPOSE: Gallery overlay for browsing and applying built-in shape script templates.
// CONTEXT: Opened from context menu "Apply Template..." or Code tab in PropertiesPane.

import React, { useState } from "react";
import { getTemplateCategories, type ShapeTemplate } from "./shapeTemplateCatalog";

// ============================================================================
// Styles (theme-aware via CSS variables)
// ============================================================================

const v = (token: string) => `var(${token})`;

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
};

const dialogStyle: React.CSSProperties = {
  backgroundColor: v("--bg-surface"),
  borderRadius: 8,
  boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
  width: 520,
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: v("--font-family-sans"),
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 18px",
  borderBottom: `1px solid ${v("--border-default")}`,
  flexShrink: 0,
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: v("--text-primary"),
};

const closeButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  border: "none",
  background: "transparent",
  borderRadius: 4,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: v("--text-secondary"),
  fontSize: 18,
  transition: "background-color 0.15s",
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "8px 0",
};

const categoryHeaderStyle: React.CSSProperties = {
  padding: "8px 18px 4px",
  fontSize: 11,
  fontWeight: 600,
  color: v("--text-secondary"),
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const cardStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
  padding: "10px 18px",
  cursor: "pointer",
  transition: "background-color 0.1s",
  alignItems: "stretch",
};

const cardHoverStyle: React.CSSProperties = {
  backgroundColor: v("--panel-bg"),
};

const thumbnailContainerStyle: React.CSSProperties = {
  width: 100,
  height: 64,
  borderRadius: 4,
  border: `1px solid ${v("--border-default")}`,
  overflow: "hidden",
  flexShrink: 0,
  backgroundColor: "#ffffff",
};

const cardInfoStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 2,
  minWidth: 0,
  flex: 1,
};

const cardNameStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: v("--text-primary"),
};

const cardDescStyle: React.CSSProperties = {
  fontSize: 11,
  color: v("--text-secondary"),
  lineHeight: 1.4,
};

// ============================================================================
// Props
// ============================================================================

interface ShapeTemplateGalleryProps {
  onSelect: (template: ShapeTemplate) => void;
  onClose: () => void;
}

// ============================================================================
// Component
// ============================================================================

export const ShapeTemplateGallery: React.FC<ShapeTemplateGalleryProps> = ({
  onSelect,
  onClose,
}) => {
  const categories = getTemplateCategories();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const handleSelect = (tpl: ShapeTemplate) => {
    onSelect(tpl);
    onClose();
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <span style={titleStyle}>Shape Templates</span>
          <button
            style={closeButtonStyle}
            onClick={onClose}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.backgroundColor = v("--panel-bg"); }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.backgroundColor = "transparent"; }}
          >
            x
          </button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {categories.map(({ category, templates }) => (
            <div key={category}>
              <div style={categoryHeaderStyle}>{category}</div>
              {templates.map((tpl) => (
                <div
                  key={tpl.id}
                  style={{ ...cardStyle, ...(hoveredId === tpl.id ? cardHoverStyle : {}) }}
                  onClick={() => handleSelect(tpl)}
                  onMouseEnter={() => setHoveredId(tpl.id)}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  <div style={thumbnailContainerStyle}>
                    <div
                      dangerouslySetInnerHTML={{ __html: tpl.previewHtml }}
                      style={{ width: "100%", height: "100%", pointerEvents: "none" }}
                    />
                  </div>
                  <div style={cardInfoStyle}>
                    <div style={cardNameStyle}>{tpl.name}</div>
                    <div style={cardDescStyle}>{tpl.description}</div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
