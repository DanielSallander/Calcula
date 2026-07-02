//! FILENAME: app/src/api/layout/primitives/blocks.tsx
// PURPOSE: Intrinsically-vertical block primitives: ItemList, Tall, Gallery.
// CONTEXT: These archetypes (unbounded lists, editors, trees, histograms,
//          preset galleries) can never fit the ribbon's 92px band. They do not
//          try: in the band they emit a Launcher whose flyout hosts the content
//          at vertical geometry. In the panel they render inline.

import React from "react";
import { useSurfaceLayout } from "../context";
import { Launcher } from "./Launcher";
import { GAP_SM, GAP_XS } from "../tokens";

// ============================================================================
// ItemList
// ============================================================================

export interface ItemListProps {
  /** Launcher label when the list is demoted to the band. */
  label: string;
  /** Optional item count appended to the launcher label: "Animations (3)". */
  count?: number;
  icon?: React.ReactNode;
  flyoutWidth?: number;
  /** Panel mode: cap the list height and scroll (default: natural height). */
  maxHeight?: number;
  children: React.ReactNode;
  testId?: string;
}

/**
 * An unbounded item list. Panel/popover: a scrollable vertical list. Band:
 * never renders inline — emits a Launcher labeled `label (count)`.
 */
export function ItemList({
  label,
  count,
  icon,
  flyoutWidth,
  maxHeight,
  children,
  testId,
}: ItemListProps): React.ReactElement {
  const layout = useSurfaceLayout();

  if (layout.container === "band") {
    const launcherLabel = count != null ? `${label} (${count})` : label;
    return (
      <Launcher label={launcherLabel} icon={icon} flyoutWidth={flyoutWidth} testId={testId}>
        {children}
      </Launcher>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: GAP_XS,
        minHeight: 0,
        ...(maxHeight != null ? { maxHeight, overflowY: "auto" as const } : {}),
      }}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

// ============================================================================
// Tall
// ============================================================================

export interface TallProps {
  /** Launcher label when the content is demoted to the band. */
  label: string;
  icon?: React.ReactNode;
  flyoutWidth?: number;
  children: React.ReactNode;
  testId?: string;
}

/**
 * Explicit declaration of intrinsically vertical content (Monaco editors,
 * trees, histograms, settings pages). Panel/popover: children render inline.
 * Band: a Launcher hosts them in its flyout. This is the honest per-BLOCK
 * replacement for the old per-PANEL supportedPlacements refusal.
 */
export function Tall({
  label,
  icon,
  flyoutWidth,
  children,
  testId,
}: TallProps): React.ReactElement {
  const layout = useSurfaceLayout();

  if (layout.container === "band") {
    return (
      <Launcher label={label} icon={icon} flyoutWidth={flyoutWidth} testId={testId}>
        {children}
      </Launcher>
    );
  }

  return <>{children}</>;
}

// ============================================================================
// Gallery
// ============================================================================

export interface GalleryProps {
  /** Launcher label for the expanded grid. */
  label: string;
  icon?: React.ReactNode;
  flyoutWidth?: number;
  /** Thumbnail row height in the band strip. */
  stripHeight?: number;
  children: React.ReactNode;
  testId?: string;
}

/**
 * A preset/style gallery. Band: a single clipped horizontal strip of
 * thumbnails plus an expand launcher opening the full wrapped grid (exactly
 * Excel's gallery). Panel/popover: a wrapped grid.
 */
export function Gallery({
  label,
  icon,
  flyoutWidth,
  stripHeight = 56,
  children,
  testId,
}: GalleryProps): React.ReactElement {
  const layout = useSurfaceLayout();

  if (layout.container === "band") {
    return (
      <div
        style={{ display: "flex", alignItems: "stretch", gap: GAP_XS, minWidth: 0, height: "100%" }}
        data-testid={testId}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            gap: GAP_XS,
            alignItems: "center",
            overflow: "hidden",
            maxHeight: stripHeight,
            alignSelf: "center",
            minWidth: 0,
          }}
        >
          {children}
        </div>
        <Launcher label={label} icon={icon} flyoutWidth={flyoutWidth}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: GAP_SM }}>{children}</div>
        </Launcher>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: GAP_SM }} data-testid={testId}>
      {children}
    </div>
  );
}
