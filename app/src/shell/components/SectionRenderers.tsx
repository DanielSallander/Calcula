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
import { css } from "@emotion/css";
import type { PanelSection, PanelSectionProps } from "../../api/uiTypes";
import {
  SurfaceLayoutProvider,
  panelLayout,
  LAUNCHER_BAND_WIDTH,
  DropdownChevron,
  LT,
  FONT_FAMILY,
  HEADER_FONT_SIZE,
} from "../../api/layout";
import { SectionCell, type SectionCellForm } from "./SectionCell";
import { cellChromeWidth } from "./SectionChrome";
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
/** Sizer-reported natural widths (content only, no chrome), per panel. */
const naturalWidthCache = new Map<string, Record<string, number>>();
let lastKnownBandWidth = 0;

/** Test/skin-change hook: forget all measured cell widths and the band width. */
export function clearSectionWidthCaches(): void {
  inlineWidthCache.clear();
  launcherWidthCache.clear();
  naturalWidthCache.clear();
  lastKnownBandWidth = 0;
}

/**
 * Read-only copy of what the width collapse has MEASURED for one panel: each
 * section's rendered inline and launcher cell widths (chrome included), its
 * sizer's natural content width (chrome NOT included — add cellChromeWidth,
 * as the renderer does) and the last band width. For live proofs only (e2e/tests/chart-design-ribbon.spec.ts):
 * the harness cannot resize its window, so "all six Chart Design clusters fit
 * at 1366" is proved by feeding these real widths to computeWidthDemotions at
 * other band widths, the D6 way. A section measured only as a launcher has no
 * inline entry.
 */
export function peekSectionWidths(panelId: string): {
  inline: Record<string, number>;
  launcher: Record<string, number>;
  natural: Record<string, number>;
  bandWidth: number;
} {
  return {
    inline: { ...(inlineWidthCache.get(panelId) ?? {}) },
    launcher: { ...(launcherWidthCache.get(panelId) ?? {}) },
    natural: { ...(naturalWidthCache.get(panelId) ?? {}) },
    bandWidth: lastKnownBandWidth,
  };
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

  const handleNaturalWidth = useCallback(
    (sectionId: string, width: number) => {
      setNaturalWidths((prev) => {
        if (Math.abs((prev[sectionId] ?? 0) - width) < 1) return prev;
        const next = { ...prev, [sectionId]: width };
        naturalWidthCache.set(panelId, next);
        return next;
      });
    },
    [panelId],
  );

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
      // chrome included); else sizer natural width + the cluster chrome
      // (cellChromeWidth: card padding both sides + the gap unless last);
      // else an optimistic launcher-band width so a truly fresh mount doesn't
      // demote everything before any probe has reported.
      const chrome = cellChromeWidth(i === 0, i === sections.length - 1);
      const width =
        measuredInline !== undefined || natural !== undefined
          ? Math.max(
              measuredInline ?? 0,
              natural !== undefined ? natural + chrome : 0,
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

  // DOM-truth backstop, runs after every commit: if the strip's content is
  // still wider than its box after the modeled demotions (constant drift,
  // lost probe report, exotic fonts), demote one more candidate per pass —
  // synchronously before paint — until reality fits or nothing demotable
  // remains (then the strip's own overflow clip contains the residue).
  //
  // Forced demotions are evidence about ONE model: one band width, one section
  // set, one set of measurements. When any of those changes while a forced
  // count stands, the count is dropped and the check waits for the next
  // commit, which is laid out from the new model. And nothing is forced until
  // every section has reported SOME width: before that the model is still
  // using the optimistic launcher-band width for each section, no section is
  // even a candidate, and an overflow says nothing the widths will not say a
  // frame later. Both halves were missing, and together they made a contextual
  // tab's first appearance in a session fold EVERY cluster: the count ran up
  // to the section total on the unmeasured strip and stayed there after the
  // real widths arrived (sectionWidthProbe.test.tsx, "cold mount").
  const prevModelRef = useRef<{
    width: number;
    sections: PanelSection[];
    natural: Record<string, number>;
    inline: Record<string, number>;
    launcher: Record<string, number>;
  } | null>(null);
  useLayoutEffect(() => {
    const prev = prevModelRef.current;
    prevModelRef.current = {
      width: containerWidth,
      sections,
      natural: naturalWidths,
      inline: inlineCellWidths,
      launcher: launcherCellWidths,
    };
    const modelChanged =
      prev !== null &&
      (prev.width !== containerWidth ||
        prev.sections !== sections ||
        prev.natural !== naturalWidths ||
        prev.inline !== inlineCellWidths ||
        prev.launcher !== launcherCellWidths);
    if (modelChanged && forcedDemotions > 0) {
      setForcedDemotions(0);
      return;
    }

    const el = containerRef.current;
    if (!el || containerWidth <= 0) return;
    const everyWidthKnown = sections.every(
      (s) =>
        s.ribbonPresentation === "launcher" ||
        naturalWidths[s.id] !== undefined ||
        inlineCellWidths[s.id] !== undefined ||
        launcherCellWidths[s.id] !== undefined,
    );
    if (!everyWidthKnown) return;
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

/** Disclosure chevron in a sidebar section header. */
const SIDEBAR_CHEVRON_SIZE = 11;
/** Section icon in a sidebar section header: between the 20px control icon
 *  and the 24px launcher icon, so the header reads as a heading, not a button. */
const SIDEBAR_SECTION_ICON_SIZE = 22;

/**
 * The sidebar transposition of the ribbon clusters: no cards — a 36px header
 * row (chevron, section icon, 12px/600 sentence-case label; the one header
 * recipe the side panel title and the panel Group header share) over the
 * section content. Tokens only.
 */
const sidebarStyles = {
  header: css`
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    width: calc(100% - 12px);
    height: 36px;
    margin: 2px 6px;
    padding: 0 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    cursor: pointer;
    font-family: ${FONT_FAMILY};
    font-size: ${HEADER_FONT_SIZE}px;
    font-weight: 600;
    line-height: 1;
    color: ${LT.text};
    text-align: left;
    transition: background-color ${LT.motionHover};

    &:hover {
      background: ${LT.hover};
    }

    &:focus-visible {
      outline: none;
      box-shadow: ${LT.focusRing};
    }
  `,
  chevron: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    color: ${LT.textSecondary};
    transition: transform ${LT.motionHover};
  `,
  /** Fits whatever size the section icon was drawn at (sections declare it at
   *  24 for their launcher) to the header's 22px. */
  icon: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: ${SIDEBAR_SECTION_ICON_SIZE}px;
    height: ${SIDEBAR_SECTION_ICON_SIZE}px;

    & > svg {
      width: ${SIDEBAR_SECTION_ICON_SIZE}px;
      height: ${SIDEBAR_SECTION_ICON_SIZE}px;
    }
  `,
  label: css`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  content: css`
    padding: 6px 14px 12px;
    min-width: 0;
    overflow-x: auto;
  `,
};

/**
 * Renders panel sections vertically in the sidebar: a single section fills the
 * panel directly (no header chrome); multiple sections stack as collapsible
 * groups. All content gets vertical SurfaceLayout geometry with the live panel
 * width.
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
          const hasIcon =
            section.icon !== undefined &&
            section.icon !== null &&
            section.icon !== false &&
            section.icon !== "";
          return (
            <div
              key={section.id}
              data-sidebar-section={section.id}
              style={isSingleSection ? { height: "100%" } : undefined}
            >
              {/* Section header — hidden for single-section panels */}
              {!isSingleSection && (
                <button
                  type="button"
                  className={sidebarStyles.header}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleSection(section.id)}
                >
                  <span
                    className={sidebarStyles.chevron}
                    style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
                    aria-hidden
                  >
                    <DropdownChevron size={SIDEBAR_CHEVRON_SIZE} />
                  </span>
                  {hasIcon && (
                    <span className={sidebarStyles.icon} aria-hidden>
                      {section.icon}
                    </span>
                  )}
                  <span className={sidebarStyles.label}>{section.label}</span>
                </button>
              )}
              {/* Section content */}
              {(isSingleSection || !isCollapsed) && (
                <div
                  className={
                    isSingleSection
                      ? legacy
                        ? "legacy-ribbon-transpose"
                        : undefined
                      : [sidebarStyles.content, legacy ? "legacy-ribbon-transpose" : ""]
                          .filter(Boolean)
                          .join(" ")
                  }
                  style={isSingleSection ? { height: "100%", minWidth: 0 } : undefined}
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
