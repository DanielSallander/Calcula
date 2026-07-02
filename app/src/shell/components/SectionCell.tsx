//! FILENAME: app/src/shell/components/SectionCell.tsx
// PURPOSE: Hosts one panel section inside the ribbon band: inline (measured,
//          inside SurfaceLayoutProvider band geometry) or demoted to a
//          Launcher whose flyout re-renders the section at sidebar geometry.
// CONTEXT: The per-section half of the ribbon safety net; SectionRibbonRenderer
//          decides width-overflow demotion across cells, this cell decides
//          height demotion for itself via useSectionFit.

import React, { useCallback } from "react";
import type { PanelSection, PanelSectionProps } from "../../api/uiTypes";
import {
  Launcher,
  SurfaceLayoutProvider,
  bandLayout,
} from "../../api/layout";
import { SectionChrome } from "./SectionChrome";
import { useSectionFit } from "./useSectionFit";

export interface SectionCellProps {
  panelId: string;
  section: PanelSection;
  isFirst: boolean;
  isLast: boolean;
  /** Renderer-decided demotion under width pressure. */
  widthDemoted: boolean;
  /** Reports the section's natural inline width for width-overflow math. */
  onNaturalWidth: (sectionId: string, width: number) => void;
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

  const Section = section.component as React.ComponentType<PanelSectionProps>;

  if (demoted || widthDemoted) {
    return (
      <SectionChrome isFirst={isFirst} isLast={isLast}>
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
    <SectionChrome label={section.label} isFirst={isFirst} isLast={isLast}>
      {/* Clip box: bounds the visible content to the band while the unclipped
          sizer below reveals the natural content size to the ResizeObserver. */}
      <div style={{ height: "100%", overflow: "hidden" }}>
        <div ref={probeRef} style={{ width: "max-content", minWidth: "100%" }}>
          <SurfaceLayoutProvider value={bandLayout()}>
            <Section placement="ribbon" />
          </SurfaceLayoutProvider>
        </div>
      </div>
    </SectionChrome>
  );
}
