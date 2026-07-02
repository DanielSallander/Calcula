//! FILENAME: app/src/shell/components/SectionRenderers.tsx
// PURPOSE: Renders panel sections in either horizontal (ribbon) or vertical (sidebar) layout.
// CONTEXT: Part of the sections-based panel API. The Shell uses these renderers to
//          transpose panel content between ribbon and sidebar placements. The ribbon
//          side measures every section and demotes ones that cannot fit the band to
//          launcher flyouts (see useSectionFit) — this is what makes ANY panel legal
//          on EITHER surface. The sidebar side provides vertical SurfaceLayout
//          geometry; the old global `!important` DOM-transposition hack is gone,
//          scoped now to bootstrap-synthesized legacy ribbon sections only.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelSection, PanelSectionProps } from "../../api/uiTypes";
import {
  SurfaceLayoutProvider,
  panelLayout,
  LAUNCHER_BAND_WIDTH,
} from "../../api/layout";
import { SectionCell } from "./SectionCell";
import { computeWidthDemotions, type WidthDemotionInput } from "./useSectionFit";

/**
 * Shell-internal extension of PanelSection: bootstrap's ribbon-tab/group
 * adapters flag the sections they synthesize so the sidebar renderer can scope
 * the legacy DOM-shape transposition CSS to exactly those (and nothing else).
 * The flag dies with the last unmigrated monolithic ribbon tab.
 */
export interface ShellPanelSection extends PanelSection {
  legacyRibbonDom?: boolean;
}

/** Approximate SectionChrome horizontal padding + divider per cell. */
const CELL_CHROME_WIDTH = 21;

// ============================================================================
// SectionRibbonRenderer — horizontal layout for the 92px ribbon band
// ============================================================================

interface SectionRibbonRendererProps {
  sections: PanelSection[];
  panelId: string;
  /** Panel title/icon, used when a single-section panel is fully demoted so
   *  the lone launcher reads as the panel itself (Excel collapsed-group). */
  panelTitle?: string;
  panelIcon?: React.ReactNode;
}

/**
 * Renders panel sections horizontally in the ribbon's content band. Each
 * section is measured: too-tall sections demote to launchers (SectionCell),
 * and when the band is too narrow, whole sections progressively demote in
 * collapsePriority order using real measured widths.
 */
export function SectionRibbonRenderer({
  sections,
  panelId,
  panelTitle,
  panelIcon,
}: SectionRibbonRendererProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [naturalWidths, setNaturalWidths] = useState<Record<string, number>>({});

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleNaturalWidth = useCallback((sectionId: string, width: number) => {
    setNaturalWidths((prev) =>
      Math.abs((prev[sectionId] ?? 0) - width) < 1
        ? prev
        : { ...prev, [sectionId]: width },
    );
  }, []);

  const widthDemotions = useMemo(() => {
    const inputs: WidthDemotionInput[] = sections.map((s, i) => ({
      id: s.id,
      width: (naturalWidths[s.id] ?? 0) + CELL_CHROME_WIDTH,
      // Default: rightmost collapses first.
      collapsePriority: s.collapsePriority ?? 1000 - i,
      alreadyLauncher: s.ribbonPresentation === "launcher",
    }));
    // Only measured sections participate; give unmeasured ones launcher width
    // so a fresh mount doesn't demote everything for a frame.
    for (const input of inputs) {
      if (input.width === CELL_CHROME_WIDTH) input.width = LAUNCHER_BAND_WIDTH;
    }
    return computeWidthDemotions(inputs, containerWidth);
  }, [sections, naturalWidths, containerWidth]);

  const soleSection = sections.length === 1;

  return (
    <div
      ref={containerRef}
      style={{ display: "flex", gap: 0, height: "100%", minWidth: 0, width: "100%" }}
    >
      {sections.map((section, idx) => (
        <SectionCell
          key={section.id}
          panelId={panelId}
          section={section}
          isFirst={idx === 0}
          isLast={idx === sections.length - 1}
          widthDemoted={widthDemotions.has(section.id)}
          onNaturalWidth={handleNaturalWidth}
          launcherTitle={soleSection ? panelTitle : undefined}
          launcherIcon={soleSection ? panelIcon : undefined}
        />
      ))}
    </div>
  );
}

// ============================================================================
// SectionSidebarRenderer — vertical collapsible layout for sidebar
// ============================================================================

interface SectionSidebarRendererProps {
  sections: PanelSection[];
  onClose?: () => void;
  data?: Record<string, unknown>;
}

/**
 * Renders panel sections vertically in the sidebar: a single section fills the
 * panel directly; multiple sections stack as collapsible groups. All content
 * gets vertical SurfaceLayout geometry with the live panel width.
 */
export function SectionSidebarRenderer({
  sections,
  onClose,
  data,
}: SectionSidebarRendererProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const isSingleSection = sections.length === 1;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  const hasLegacy = sections.some((s) => (s as ShellPanelSection).legacyRibbonDom);

  return (
    <div ref={containerRef} style={{ overflow: "auto", height: "100%" }}>
      {/* Legacy-only transposition: ribbon-native DOM (bootstrap-wrapped
          monolithic tabs/groups) hand-rolls horizontal band markup that knows
          nothing of SurfaceLayoutContext. Force it vertical here. Scoped to
          .legacy-ribbon-transpose so primitive-based content is untouched;
          deleted when the last monolith migrates to sections/primitives. */}
      {hasLegacy && (
        <style>{`
          .legacy-ribbon-transpose div {
            height: auto !important;
            flex-wrap: wrap !important;
            border-right: none !important;
          }
          .legacy-ribbon-transpose > div > div {
            flex-direction: column !important;
            align-items: stretch !important;
          }
        `}</style>
      )}
      <SurfaceLayoutProvider value={panelLayout(width)}>
        {sections.map((section) => {
          const isCollapsed = collapsed.has(section.id);
          const legacy = (section as ShellPanelSection).legacyRibbonDom === true;
          const Section = section.component as React.ComponentType<PanelSectionProps>;
          return (
            <div
              key={section.id}
              style={isSingleSection ? { height: "100%" } : { borderBottom: "1px solid var(--border-default)" }}
            >
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
                    {"▼"}
                  </span>
                  {section.label}
                </button>
              )}
              {/* Section content */}
              {(isSingleSection || !isCollapsed) && (
                <div
                  className={legacy ? "legacy-ribbon-transpose" : undefined}
                  style={
                    isSingleSection
                      ? { height: "100%", minWidth: 0 }
                      : { padding: "4px 12px 8px", minWidth: 0, overflowX: "auto" }
                  }
                >
                  <Section placement="sidebar" onClose={onClose} data={data} />
                </div>
              )}
            </div>
          );
        })}
      </SurfaceLayoutProvider>
    </div>
  );
}
