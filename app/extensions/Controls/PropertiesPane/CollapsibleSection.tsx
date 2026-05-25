//! FILENAME: app/extensions/Controls/PropertiesPane/CollapsibleSection.tsx
// PURPOSE: Collapsible section with animated chevron for the Properties Pane.
// CONTEXT: Groups related properties under a togglable header.

import React, { useState, useRef, useEffect } from "react";

// ============================================================================
// Styles
// ============================================================================

const sectionStyle: React.CSSProperties = {
  borderBottom: "1px solid #e0e0e0",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 12px",
  fontSize: 11,
  fontWeight: 600,
  color: "#444",
  backgroundColor: "#f4f5f7",
  cursor: "pointer",
  userSelect: "none",
  letterSpacing: "0.01em",
  transition: "background-color 0.15s",
};

const headerHoverStyle: React.CSSProperties = {
  backgroundColor: "#ecedf0",
};

const contentWrapperStyle: React.CSSProperties = {
  overflow: "hidden",
  transition: "max-height 0.25s ease, opacity 0.2s ease",
};

// ============================================================================
// Props
// ============================================================================

interface CollapsibleSectionProps {
  title: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

// ============================================================================
// Component
// ============================================================================

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  defaultExpanded = true,
  children,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [hovered, setHovered] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);

  // Measure content height for smooth animation
  useEffect(() => {
    if (contentRef.current) {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContentHeight(entry.contentRect.height);
        }
      });
      observer.observe(contentRef.current);
      return () => observer.disconnect();
    }
  }, []);

  const chevronStyle: React.CSSProperties = {
    flexShrink: 0,
    transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
    transition: "transform 0.2s ease",
  };

  const wrapperStyle: React.CSSProperties = {
    ...contentWrapperStyle,
    maxHeight: expanded ? (contentHeight !== undefined ? contentHeight + 4 : 9999) : 0,
    opacity: expanded ? 1 : 0,
  };

  return (
    <div style={sectionStyle}>
      <div
        style={{ ...headerStyle, ...(hovered ? headerHoverStyle : {}) }}
        onClick={() => setExpanded((prev) => !prev)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <svg
          width={10}
          height={10}
          viewBox="0 0 10 10"
          style={chevronStyle}
        >
          <path d="M3 1 L7 5 L3 9" stroke="#666" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{title}</span>
      </div>
      <div style={wrapperStyle}>
        <div ref={contentRef}>
          {children}
        </div>
      </div>
    </div>
  );
};
