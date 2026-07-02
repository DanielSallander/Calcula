//! FILENAME: app/src/api/layout/context.ts
// PURPOSE: SurfaceLayoutContext — tells layout primitives which surface geometry
//          they are rendering into (ribbon band, sidebar panel, or launcher flyout).
// CONTEXT: Provided by the Shell's surface renderers (ribbon SectionCell, sidebar
//          section renderer) and by the Launcher flyout. Primitives in @api/layout
//          read it via useSurfaceLayout(), so the same JSX renders horizontally in
//          the ribbon and vertically in the sidebar with no per-extension CSS.

import React, { createContext, useContext } from "react";
import type { PanelPlacement } from "../uiTypes";

/** Main-axis direction the surface flows content in. */
export type SurfaceOrientation = "horizontal" | "vertical";

/**
 * The concrete container hosting the content:
 * - "band": the ribbon's fixed-height horizontal strip (~80px usable)
 * - "panel": the sidebar's full-height vertical column
 * - "popover": a launcher flyout (vertical, sidebar-like, scrollable)
 */
export type SurfaceContainer = "band" | "panel" | "popover";

/**
 * The geometry primitives lay out against. `surface` mirrors the `placement`
 * prop panels already receive; `container` is the finer-grained signal —
 * a launcher flyout is placement "sidebar" but container "popover".
 */
export interface SurfaceLayout {
  /** Which surface family the content belongs to (drives the placement prop). */
  surface: PanelPlacement;
  /** Layout direction: horizontal only inside the ribbon band. */
  orientation: SurfaceOrientation;
  /** The hosting container kind. */
  container: SurfaceContainer;
  /** Usable content height in px when bounded (the ribbon band), else null. */
  maxContentHeight: number | null;
  /** Live container width in px (0 when not yet measured). */
  width: number;
  /** Density hint: "compact" in the band, "comfortable" elsewhere. */
  density: "compact" | "comfortable";
}

/** Safe default when no provider is present: a sidebar-like vertical panel. */
export const DEFAULT_SURFACE_LAYOUT: SurfaceLayout = {
  surface: "sidebar",
  orientation: "vertical",
  container: "panel",
  maxContentHeight: null,
  width: 0,
  density: "comfortable",
};

const SurfaceLayoutContext = createContext<SurfaceLayout>(DEFAULT_SURFACE_LAYOUT);

/** Read the current surface geometry. Primitives use this instead of props. */
export function useSurfaceLayout(): SurfaceLayout {
  return useContext(SurfaceLayoutContext);
}

/** Shell-side provider wrapping section content in its surface geometry. */
export function SurfaceLayoutProvider({
  value,
  children,
}: {
  value: SurfaceLayout;
  children: React.ReactNode;
}): React.ReactElement {
  return React.createElement(SurfaceLayoutContext.Provider, { value }, children);
}

/** Convenience: build the band (ribbon strip) layout value. */
export function bandLayout(width = 0): SurfaceLayout {
  return {
    surface: "ribbon",
    orientation: "horizontal",
    container: "band",
    maxContentHeight: 80,
    width,
    density: "compact",
  };
}

/** Convenience: build the sidebar panel layout value. */
export function panelLayout(width = 0): SurfaceLayout {
  return {
    surface: "sidebar",
    orientation: "vertical",
    container: "panel",
    maxContentHeight: null,
    width,
    density: "comfortable",
  };
}

/** Convenience: build the launcher-flyout layout value. */
export function popoverLayout(width = 0): SurfaceLayout {
  return {
    surface: "sidebar",
    orientation: "vertical",
    container: "popover",
    maxContentHeight: null,
    width,
    density: "comfortable",
  };
}
