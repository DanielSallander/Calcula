//! FILENAME: app/src/api/canvasSheet.ts
// PURPOSE: The canvas sheet vocabulary every layer shares: the page presets and
//          the valid ranges of a canvas layout, mirrored from the Rust
//          authority, plus the pure helpers built on them.
// CONTEXT: A canvas sheet's layout is validated by ONE Rust function
//          (`CanvasLayout::validate`, core/persistence/src/lib.rs). The ribbon
//          tab and the script validator check the same ranges FIRST so a user
//          gets an immediate, specific message instead of a round trip -- which
//          only works while these numbers equal Rust's. They are pinned against
//          the Rust source by `canvasSheetConstantsDrift.test.ts`, which reads
//          lib.rs at test time: the direction is Rust -> TypeScript.

import type { CanvasLayout, CanvasLayoutPatch } from "./lib";

/** Default page width in logical px (Power BI's 16:9 page). */
export const CANVAS_DEFAULT_PAGE_WIDTH = 1280;
/** Default page height in logical px. */
export const CANVAS_DEFAULT_PAGE_HEIGHT = 720;
/** Default snap-grid pitch in logical px. */
export const CANVAS_DEFAULT_GRID_SIZE_PX = 16;
/** Smallest snap-grid pitch a canvas accepts. */
export const CANVAS_MIN_GRID_SIZE_PX = 4;
/** Largest snap-grid pitch a canvas accepts. */
export const CANVAS_MAX_GRID_SIZE_PX = 200;
/** Smallest page edge a canvas accepts, in logical px. */
export const CANVAS_MIN_PAGE_EDGE_PX = 100;
/** Largest page edge a canvas accepts, in logical px. */
export const CANVAS_MAX_PAGE_EDGE_PX = 10_000;
/** The preset id meaning "the width/height fields are authoritative". */
export const CANVAS_CUSTOM_PAGE_PRESET = "custom";

/** One page preset: its id (the wire value), a display label and its size. */
export interface CanvasPagePreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

/** The page presets a canvas offers, in the Rust order. */
export const CANVAS_PAGE_PRESETS: readonly CanvasPagePreset[] = [
  { id: "16:9", label: "16:9", width: 1280, height: 720 },
  { id: "4:3", label: "4:3", width: 960, height: 720 },
  { id: "letter", label: "Letter", width: 816, height: 1056 },
];

/** The size a preset id stands for, or null for "custom" and unknown ids. */
export function canvasPresetSize(id: string): { width: number; height: number } | null {
  const p = CANVAS_PAGE_PRESETS.find((x) => x.id === id);
  return p ? { width: p.width, height: p.height } : null;
}

/** The layout a new canvas starts with (Rust `CanvasLayout::default`). */
export function defaultCanvasLayout(): CanvasLayout {
  return {
    snapToGrid: true,
    gridSizePx: CANVAS_DEFAULT_GRID_SIZE_PX,
    showGrid: true,
    pagePreset: "16:9",
    pageWidth: CANVAS_DEFAULT_PAGE_WIDTH,
    pageHeight: CANVAS_DEFAULT_PAGE_HEIGHT,
    background: "",
  };
}

const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Check a layout PATCH against the same ranges the Rust validator enforces,
 * naming the first bad field; null when every present field is in range. Only
 * the fields present are checked -- the backend validates the merged result,
 * so this is a fast, specific first answer, never the authority.
 */
export function checkCanvasLayoutPatch(patch: CanvasLayoutPatch): string | null {
  if (patch.gridSizePx !== undefined) {
    const g = patch.gridSizePx;
    if (!Number.isInteger(g) || g < CANVAS_MIN_GRID_SIZE_PX || g > CANVAS_MAX_GRID_SIZE_PX) {
      return `Grid size must be a whole number from ${CANVAS_MIN_GRID_SIZE_PX} to ${CANVAS_MAX_GRID_SIZE_PX} px.`;
    }
  }
  for (const [name, edge] of [
    ["width", patch.pageWidth],
    ["height", patch.pageHeight],
  ] as const) {
    if (edge === undefined) continue;
    if (!Number.isInteger(edge) || edge < CANVAS_MIN_PAGE_EDGE_PX || edge > CANVAS_MAX_PAGE_EDGE_PX) {
      return `Page ${name} must be a whole number from ${CANVAS_MIN_PAGE_EDGE_PX} to ${CANVAS_MAX_PAGE_EDGE_PX} px.`;
    }
  }
  if (patch.pagePreset !== undefined && patch.pagePreset !== CANVAS_CUSTOM_PAGE_PRESET) {
    if (!canvasPresetSize(patch.pagePreset)) {
      const ids = [...CANVAS_PAGE_PRESETS.map((p) => p.id), CANVAS_CUSTOM_PAGE_PRESET].join(", ");
      return `Unknown page size "${patch.pagePreset}". Use one of ${ids}.`;
    }
  }
  if (patch.background !== undefined && patch.background !== "" && !HEX_COLOUR.test(patch.background)) {
    return `Background must be a CSS hex colour (#rgb or #rrggbb), or "" for the theme default.`;
  }
  return null;
}
