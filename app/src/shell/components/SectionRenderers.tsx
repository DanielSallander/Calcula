//! FILENAME: app/src/shell/components/SectionRenderers.tsx
// PURPOSE: Renders panel sections in either horizontal (ribbon) or vertical (sidebar) layout.
// CONTEXT: Part of the sections-based panel API. The Shell uses these renderers to
// transpose panel content between ribbon and sidebar placements.

import React, { useState } from "react";
import type { PanelSection, PanelPlacement } from "../../api/uiTypes";

// ============================================================================
// SectionRibbonRenderer — horizontal layout for 92px ribbon area
// ============================================================================

interface SectionRibbonRendererProps {
  sections: PanelSection[];
}

/**
 * Renders panel sections horizontally in the ribbon's 92px content area.
 * Each section appears as a ribbon group with a label below and vertical
 * dividers between sections.
 */
export function SectionRibbonRenderer({ sections }: SectionRibbonRendererProps): React.ReactElement {
  return (
    <div style={{ display: "flex", gap: "0", height: "100%" }}>
      {sections.map((section, idx) => (
        <div
          key={section.id}
          style={{
            display: "flex",
            flexDirection: "column",
            borderRight: idx < sections.length - 1 ? "1px solid var(--border-default)" : "none",
            paddingLeft: idx === 0 ? "4px" : "10px",
            paddingRight: "10px",
          }}
        >
          <div style={{ flex: 1 }}>
            <section.component placement="ribbon" />
          </div>
          <div
            style={{
              fontSize: "10px",
              color: "var(--text-tertiary)",
              textAlign: "center",
              marginTop: "2px",
              textTransform: "uppercase" as const,
              letterSpacing: "0.5px",
              fontWeight: 400,
            }}
          >
            {section.label}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// SectionSidebarRenderer — vertical collapsible layout for sidebar
// ============================================================================

interface SectionSidebarRendererProps {
  sections: PanelSection[];
}

/**
 * Renders panel sections vertically as collapsible sections in the sidebar.
 * Each section has a clickable header that toggles its content.
 */
export function SectionSidebarRenderer({ sections }: SectionSidebarRendererProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const isSingleSection = sections.length === 1;

  const toggleSection = (sectionId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  };

  return (
    <div style={{ overflow: "auto", height: "100%" }}>
      {/* Override layout for ribbon group components rendered in sidebar.
          Monolithic ribbon tabs render a horizontal flex container (height:100%)
          with RibbonGroup children. These overrides:
          1. Make the outer container stack vertically
          2. Remove fixed heights so groups size naturally
          3. Remove border-right separators between groups
          4. Allow button content to wrap in the narrower sidebar */}
      <style>{`
        .section-sidebar-content div {
          height: auto !important;
          flex-wrap: wrap !important;
          border-right: none !important;
        }
        .section-sidebar-content > div > div {
          flex-direction: column !important;
          align-items: stretch !important;
        }
      `}</style>
      {sections.map((section) => {
        const isCollapsed = collapsed.has(section.id);
        return (
          <div key={section.id} style={isSingleSection ? undefined : { borderBottom: "1px solid var(--border-default)" }}>
            {/* Section header — hidden for single-section panels */}
            {!isSingleSection && (
              <button
                onClick={() => toggleSection(section.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  width: "100%",
                  padding: "8px 12px",
                  border: "none",
                  backgroundColor: "transparent",
                  cursor: "pointer",
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
                }}
              >
                <span
                  style={{
                    fontSize: "8px",
                    transition: "transform 0.15s",
                    transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                    display: "inline-block",
                  }}
                >
                  {"\u25BC"}
                </span>
                {section.label}
              </button>
            )}
            {/* Section content */}
            {(isSingleSection || !isCollapsed) && (
              <div
                className="section-sidebar-content"
                style={isSingleSection ? { height: "100%" } : { padding: "4px 12px 8px" }}
              >
                <section.component placement="sidebar" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
