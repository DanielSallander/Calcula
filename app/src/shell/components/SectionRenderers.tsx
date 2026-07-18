//! FILENAME: app/src/shell/components/SectionRenderers.tsx
// PURPOSE: Renders panel sections in either horizontal (ribbon) or vertical (sidebar) layout.
// CONTEXT: Part of the sections-based panel API. The Shell uses these renderers to
//          transpose panel content between ribbon and sidebar placements. The ribbon
//          side measures every section and demotes ones that cannot fit the band to
//          launcher flyouts (see useSectionFit) — this is what makes ANY panel legal
//          on EITHER surface. The sidebar side provides vertical SurfaceLayout
//          geometry; the old global `!important` DOM-transposition hack is gone,
//          scoped now to bootstrap-synthesized legacy ribbon sections only.

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PanelSection, PanelSectionProps } from "../../api/uiTypes";
import {
  SurfaceLayoutProvider,
  panelLayout,
  LAUNCHER_BAND_WIDTH,
} from "../../api/layout";
import { SectionCell, type SectionCellForm } from "./SectionCell";
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

/** Approximate SectionChrome horizontal padding + divider per cell. Only a
 *  pre-measurement fallback: the real rendered cell width (onCellWidth)
 *  replaces the approximation as soon as the cell probe reports. */
const CELL_CHROME_WIDTH = 21;

// ============================================================================
// Module-level width knowledge (survives unregister/re-register churn)
//
// Contextual tabs (Chart Design) re-register on every selection change, which
// remounts the renderer and would discard every measurement — leaving the
// first paint to an optimistic model that renders everything inline and
// overflows until probes re-report. Remembering measured widths per panel and
// the last known band width lets the remount compute correct demotions on the
// FIRST render.
// ============================================================================

const inlineWidthCache = new Map<string, Record<string, number>>();
const launcherWidthCache = new Map<string, Record<string, number>>();
let lastKnownBandWidth = 0;

/** Test/skin-change hook: forget all measured cell widths and the band width. */
export function clearSectionWidthCaches(): void {
  inlineWidthCache.clear();
  launcherWidthCache.clear();
  lastKnownBandWidth = 0;
}

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
  // Seed from the last known band width so a remounted contextual tab computes
  // demotions on its very first render instead of waiting for the observer.
  const [containerWidth, setContainerWidth] = useState(() => lastKnownBandWidth);
  const [naturalWidths, setNaturalWidths] = useState<Record<string, number>>({});
  // Real rendered cell widths by form, seeded from the per-panel caches.
  const [inlineCellWidths, setInlineCellWidths] = useState<Record<string, number>>(
    () => ({ ...inlineWidthCache.get(panelId) }),
  );
  const [launcherCellWidths, setLauncherCellWidths] = useState<Record<string, number>>(
    () => ({ ...launcherWidthCache.get(panelId) }),
  );
  // DOM-truth backstop: demotions forced beyond the model's fit point because
  // the strip's real scrollWidth still overflowed after the modeled set.
  const [forcedDemotions, setForcedDemotions] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        // Never remember a hidden band (display:none reports 0).
        if (width > 0) lastKnownBandWidth = width;
        setContainerWidth(width);
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

  const handleCellWidth = useCallback(
    (sectionId: string, form: SectionCellForm, width: number) => {
      if (width <= 0) return;
      const setter = form === "launcher" ? setLauncherCellWidths : setInlineCellWidths;
      const cache = form === "launcher" ? launcherWidthCache : inlineWidthCache;
      setter((prev) => {
        if (Math.abs((prev[sectionId] ?? 0) - width) < 1) return prev;
        const next = { ...prev, [sectionId]: width };
        cache.set(panelId, next);
        return next;
      });
    },
    [panelId],
  );

  const widthDemotions = useMemo(() => {
    const inputs: WidthDemotionInput[] = sections.map((s, i) => {
      const measuredInline = inlineCellWidths[s.id];
      const natural = naturalWidths[s.id];
      // Inline demand: the real rendered cell width when measured (exact,
      // chrome included); else sizer natural width + chrome approximation;
      // else an optimistic launcher-band width so a truly fresh mount doesn't
      // demote everything before any probe has reported.
      const width =
        measuredInline !== undefined || natural !== undefined
          ? Math.max(
              measuredInline ?? 0,
              natural !== undefined ? natural + CELL_CHROME_WIDTH : 0,
            )
          : LAUNCHER_BAND_WIDTH;
      return {
        id: s.id,
        width,
        launcherWidth: launcherCellWidths[s.id],
        // Default: rightmost collapses first.
        collapsePriority: s.collapsePriority ?? 1000 - i,
        alreadyLauncher: s.ribbonPresentation === "launcher",
      };
    });
    return computeWidthDemotions(inputs, containerWidth, forcedDemotions);
  }, [
    sections,
    naturalWidths,
    inlineCellWidths,
    launcherCellWidths,
    containerWidth,
    forcedDemotions,
  ]);

  // Forced demotions are relative to one band width and one section set; when
  // either changes the model re-derives from scratch (and re-escalates within
  // the same paint if the DOM still overflows).
  const prevResetKeyRef = useRef<{ width: number; sections: PanelSection[] } | null>(null);
  useLayoutEffect(() => {
    const prev = prevResetKeyRef.current;
    if (prev && (prev.width !== containerWidth || prev.sections !== sections)) {
      setForcedDemotions((n) => (n === 0 ? n : 0));
    }
    prevResetKeyRef.current = { width: containerWidth, sections };
  }, [containerWidth, sections]);

  // DOM-truth backstop, runs after every commit: if the strip's content is
  // still wider than its box after the modeled demotions (constant drift,
  // lost probe report, exotic fonts), demote one more candidate per pass —
  // synchronously before paint — until reality fits or nothing demotable
  // remains (then the strip's own overflow clip contains the residue).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || containerWidth <= 0) return;
    if (el.scrollWidth > el.clientWidth + 1) {
      setForcedDemotions((n) => (n >= sections.length ? n : n + 1));
    }
  });

  const soleSection = sections.length === 1;

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        gap: 0,
        height: "100%",
        minWidth: 0,
        width: "100%",
        // Last-resort containment: even when every section is a launcher and
        // the launcher band alone exceeds the window, the strip clips at its
        // own edge instead of painting past the frame.
        overflow: "hidden",
      }}
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
          onCellWidth={handleCellWidth}
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
