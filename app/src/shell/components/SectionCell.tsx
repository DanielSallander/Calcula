//! FILENAME: app/src/shell/components/SectionCell.tsx
// PURPOSE: Hosts one panel section inside the ribbon band: inline (measured,
//          inside SurfaceLayoutProvider band geometry) or demoted to a
//          Launcher whose flyout re-renders the section at sidebar geometry.
// CONTEXT: The per-section half of the ribbon safety net; SectionRibbonRenderer
//          decides width-overflow demotion across cells, this cell decides
//          height demotion for itself via useSectionFit. Besides the inline
//          natural-width sizer probe, the cell reports its REAL rendered width
//          (launcher or inline, chrome included) so the renderer's width math
//          works from actual pixels, not approximations.

import React, { useCallback, useEffect, useRef } from "react";
import type { PanelSection, PanelSectionProps } from "../../api/uiTypes";
import {
  Launcher,
  SurfaceLayoutProvider,
  bandLayout,
} from "../../api/layout";
import { SectionChrome } from "./SectionChrome";
import { useSectionFit } from "./useSectionFit";

/** Which form a reported cell width was measured in. */
export type SectionCellForm = "inline" | "launcher";

export interface SectionCellProps {
  panelId: string;
  section: PanelSection;
  isFirst: boolean;
  isLast: boolean;
  /** Renderer-decided demotion under width pressure. */
  widthDemoted: boolean;
  /** Reports the section's natural inline width for width-overflow math. */
  onNaturalWidth: (sectionId: string, width: number) => void;
  /** Reports the cell's REAL rendered outer width and which form it was
   *  measured in. Launcher-form reports replace the LAUNCHER_BAND_WIDTH
   *  estimate in the renderer's width math; inline-form reports replace
   *  naturalWidth + chrome approximation. */
  onCellWidth?: (sectionId: string, form: SectionCellForm, width: number) => void;
  /** Single-section panel: the launcher takes the panel's own title/icon
   *  (Excel's collapsed-group idiom), so a fully-demoted panel looks
   *  intentional rather than sparse. */
  launcherTitle?: string;
  launcherIcon?: React.ReactNode;
}

export function SectionCell({
  panelId,
  section,
  isFirst,
  isLast,
  widthDemoted,
  onNaturalWidth,
  onCellWidth,
  launcherTitle,
  launcherIcon,
}: SectionCellProps): React.ReactElement {
  const reportWidth = useCallback(
    (w: number) => onNaturalWidth(section.id, w),
    [onNaturalWidth, section.id],
  );

  const { demoted, probeRef } = useSectionFit(
    `${panelId}::${section.id}`,
    section.ribbonPresentation ?? "auto",
    reportWidth,
  );

  const isLauncher = demoted || widthDemoted;

  // ==========================================================================
  // Real cell-width probe: one ResizeObserver on the SectionChrome root, which
  // React keeps across inline<->launcher swaps (same element position in both
  // branches). The observer reads the CURRENT form at fire time via a ref;
  // a form flip additionally re-reports synchronously post-layout because the
  // element may keep the same size while its meaning changed.
  // ==========================================================================

  const formRef = useRef<SectionCellForm>(isLauncher ? "launcher" : "inline");
  formRef.current = isLauncher ? "launcher" : "inline";
  const onCellWidthRef = useRef(onCellWidth);
  useEffect(() => {
    onCellWidthRef.current = onCellWidth;
  }, [onCellWidth]);

  const cellElRef = useRef<HTMLDivElement | null>(null);
  const cellObserverRef = useRef<ResizeObserver | null>(null);

  const measureRef = useCallback(
    (el: HTMLDivElement | null) => {
      cellObserverRef.current?.disconnect();
      cellObserverRef.current = null;
      cellElRef.current = el;
      if (!el || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          // offsetWidth = real border-box width; contentRect is the fallback
          // for environments (tests) that only fabricate contentRect.
          const target = entry.target as HTMLElement;
          const width = target.offsetWidth || entry.contentRect.width;
          onCellWidthRef.current?.(section.id, formRef.current, width);
        }
      });
      observer.observe(el);
      cellObserverRef.current = observer;
    },
    [section.id],
  );

  // Form flip: re-report under the new form even when the pixel width happens
  // to be identical (the ResizeObserver only fires on size CHANGES).
  useEffect(() => {
    const el = cellElRef.current;
    if (!el) return;
    const width = el.offsetWidth;
    if (width > 0) {
      onCellWidthRef.current?.(section.id, isLauncher ? "launcher" : "inline", width);
    }
  }, [isLauncher, section.id]);

  useEffect(() => {
    return () => {
      cellObserverRef.current?.disconnect();
      cellObserverRef.current = null;
    };
  }, []);

  const Section = section.component as React.ComponentType<PanelSectionProps>;

  if (isLauncher) {
    return (
      <SectionChrome isFirst={isFirst} isLast={isLast} measureRef={measureRef}>
        <Launcher
          label={launcherTitle ?? section.label}
          icon={launcherIcon ?? section.icon}
          flyoutWidth={section.flyoutWidth}
          testId={`section-launcher-${section.id}`}
        >
          <Section placement="sidebar" />
        </Launcher>
      </SectionChrome>
    );
  }

  return (
    <SectionChrome
      label={section.label}
      isFirst={isFirst}
      isLast={isLast}
      measureRef={measureRef}
    >
      {/* Clip box: bounds the visible content to the band while the unclipped
          sizer below reveals the natural content size to the ResizeObserver. */}
      <div style={{ height: "100%", overflow: "hidden" }}>
        <div
          ref={probeRef}
          data-section-sizer=""
          style={{ width: "max-content", minWidth: "100%" }}
        >
          <SurfaceLayoutProvider value={bandLayout()}>
            <Section placement="ribbon" />
          </SurfaceLayoutProvider>
        </div>
      </div>
    </SectionChrome>
  );
}
