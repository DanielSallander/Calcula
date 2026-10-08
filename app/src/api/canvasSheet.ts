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

import type { CanvasLayout, CanvasLayoutPatch, CanvasObjectRef } from "./lib";

/**
 * The `CanvasObjectRef.kind` of every floating-object family -- THE list; no
 * other file spells these. A ref names an object by its family's kind and the
 * family's own stable entity id:
 *
 * | kind             | id                                            |
 * |------------------|-----------------------------------------------|
 * | "chart"          | the chart id                                  |
 * | "slicer"         | the slicer id                                 |
 * | "timelineSlicer" | the timeline id                               |
 * | "floatingRange"  | the floating range id                         |
 * | "pivot"          | the pivot id (a canvas pivot box)             |
 * | "control"        | the control's anchor, `${row}:${col}`         |
 *
 * A control has no entity id of its own: it is keyed by its anchor cell, and
 * its region id also embeds the sheet INDEX, which shifts when sheets are
 * reordered -- so its ref is the anchor alone (the ref already lives inside
 * one canvas's layout). Each family's `@api/objectSelection` provider answers
 * `refOf(region)` in this shape.
 */
export const CANVAS_OBJECT_KINDS = [
  "chart",
  "slicer",
  "timelineSlicer",
  "floatingRange",
  "pivot",
  "control",
] as const;

/** One of {@link CANVAS_OBJECT_KINDS}. */
export type CanvasObjectKind = (typeof CANVAS_OBJECT_KINDS)[number];

/** Build a ref; the kind is checked against the one list at compile time. */
export function canvasObjectRef(kind: CanvasObjectKind, id: string): CanvasObjectRef {
  return { kind, id };
}

/** A ref as one string (`kind:id`), for map keys and equality. */
export function canvasObjectRefKey(ref: CanvasObjectRef): string {
  return `${ref.kind}:${ref.id}`;
}

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

/**
 * Power BI's page TYPES (Format page > Canvas settings > Type), each the
 * group a preset belongs to. "Custom" is not a type here: it is
 * {@link CANVAS_CUSTOM_PAGE_PRESET}, the width/height fields.
 */
export type CanvasPageType = "16:9" | "4:3" | "letter" | "tooltip";

/**
 * One page preset: its id (the wire value), the page TYPE it belongs to, a
 * display label, a size label for a menu row, and its size.
 *
 * Power BI offers four SIZES for 16:9 (HD, Full HD, QHD, 4K). Rust keeps each
 * size as its own preset id (`CANVAS_PAGE_PRESETS`, core/persistence) so the
 * one rule "a named preset fixes the size" covers them; `type` is how a menu
 * groups them back under 16:9. The type's FIRST preset is the one its own
 * menu row picks ({@link canvasPagePresetForType}).
 */
export interface CanvasPagePreset {
  id: string;
  type: CanvasPageType;
  label: string;
  /** "1280 x 720 (HD)" -- the size as Power BI's Size dropdown spells it. */
  sizeLabel: string;
  width: number;
  height: number;
}

/** The page presets a canvas offers, in the Rust order (pinned by the drift test). */
export const CANVAS_PAGE_PRESETS: readonly CanvasPagePreset[] = [
  { id: "16:9", type: "16:9", label: "16:9", sizeLabel: "1280 x 720 (HD)", width: 1280, height: 720 },
  { id: "16:9-fhd", type: "16:9", label: "16:9 Full HD", sizeLabel: "1920 x 1080 (Full HD)", width: 1920, height: 1080 },
  { id: "16:9-qhd", type: "16:9", label: "16:9 QHD", sizeLabel: "2560 x 1440 (QHD)", width: 2560, height: 1440 },
  { id: "16:9-4k", type: "16:9", label: "16:9 4K", sizeLabel: "3840 x 2160 (4K UHD)", width: 3840, height: 2160 },
  { id: "4:3", type: "4:3", label: "4:3", sizeLabel: "960 x 720", width: 960, height: 720 },
  { id: "letter", type: "letter", label: "Letter", sizeLabel: "816 x 1056", width: 816, height: 1056 },
  { id: "tooltip", type: "tooltip", label: "Tooltip", sizeLabel: "320 x 240", width: 320, height: 240 },
];

/** The size a preset id stands for, or null for "custom" and unknown ids. */
export function canvasPresetSize(id: string): { width: number; height: number } | null {
  const p = CANVAS_PAGE_PRESETS.find((x) => x.id === id);
  return p ? { width: p.width, height: p.height } : null;
}

/** The page type a preset id belongs to, or null for "custom" and unknown ids. */
export function canvasPagePresetType(id: string): CanvasPageType | null {
  return CANVAS_PAGE_PRESETS.find((x) => x.id === id)?.type ?? null;
}

/** The preset a page TYPE's own menu row picks: the type's first (its default size). */
export function canvasPagePresetForType(type: CanvasPageType): CanvasPagePreset {
  const p = CANVAS_PAGE_PRESETS.find((x) => x.type === type);
  if (!p) throw new Error(`no canvas page preset of type ${type}`);
  return p;
}

/**
 * Whether the page's LOCK OBJECTS is on (Power BI's View > Lock objects; Rust
 * `CanvasLayout::objects_locked`). Absent on the wire means off. While on,
 * no object on the page may be MOVED or RESIZED by any door -- the backend
 * refuses the geometry write -- but objects stay selectable, formattable,
 * restackable, individually lockable and deletable, and a write that leaves
 * an object where it is is not a move. A Canvas door that offers a move or a
 * resize should read this and not offer it (the layout surface's `isLocked`
 * is the natural place: answer true for every object while this is on).
 */
export function canvasObjectsLocked(layout: CanvasLayout | null | undefined): boolean {
  return layout?.objectsLocked === true;
}

/**
 * The page's WALLPAPER -- the colour of the area OUTSIDE the page (Rust
 * `CanvasLayout::wallpaper`) -- or "" for the theme's (the grid-area colour).
 * Absent on the wire means "".
 */
export function canvasWallpaper(layout: CanvasLayout | null | undefined): string {
  return layout?.wallpaper ?? "";
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
  if (patch.wallpaper !== undefined && (typeof patch.wallpaper !== "string" || (patch.wallpaper !== "" && !HEX_COLOUR.test(patch.wallpaper)))) {
    return `Wallpaper must be a CSS hex colour (#rgb or #rrggbb), or "" for the theme default.`;
  }
  if (patch.objectsLocked !== undefined && typeof patch.objectsLocked !== "boolean") {
    return `Lock Objects must be true or false.`;
  }
  return null;
}
