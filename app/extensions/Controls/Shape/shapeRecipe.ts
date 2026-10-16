//! FILENAME: app/extensions/Controls/Shape/shapeRecipe.ts
// PURPOSE: THE paint and text keys a new shape is written with, per shape
//          type (WP-C 2.10.2): every shape type gets today's blue box with a
//          white centred caption, and a TEXT BOX gets no fill, no outline and
//          left-aligned dark text -- what Power BI and Excel insert.
// CONTEXT: `createShapeControlAt` (Controls/index.ts) is the ONE shape recipe,
//          and it reads its paint keys from here; the text box is an OVERRIDE
//          of these five keys only, every other key of the recipe is the same
//          for every shape type. The caller (CanvasSheet's insertOnCanvas)
//          says WHAT it wants ("textBox") and never spells a colour (the Seam
//          Rule). The format provider (lib/controlContainerDefaults.ts) reads
//          the same table for a control's family defaults, so "Default" in the
//          Format pane puts back exactly what the recipe wrote.
//
//          A text box's new defaults are ordinary EXISTING keys (fill, stroke,
//          strokeWidth, textColor, textAlign) that an older reader understands,
//          so a text box alone declares no `visual_container` feature id.

import { controlContainerKey } from "@api/visualContainer";

/** The paint / text keys of the shape recipe, every value the stored STRING form. */
export interface ShapeRecipePaint {
  fill: string;
  stroke: string;
  strokeWidth: string;
  textColor: string;
  textAlign: "left" | "center" | "right";
}

/** The shape type that inserts a text box. */
export const TEXT_BOX_SHAPE_TYPE = "textBox";

/** What every shape type but the text box is written with (unchanged since the recipe was written). */
export const DEFAULT_SHAPE_RECIPE_PAINT: Readonly<ShapeRecipePaint> = Object.freeze({
  fill: "#4472C4",
  stroke: "#2F528F",
  strokeWidth: "1",
  textColor: "#FFFFFF",
  textAlign: "center",
});

/** What a text box is written with: no fill, no outline, dark left-aligned text. */
export const TEXT_BOX_RECIPE_PAINT: Readonly<ShapeRecipePaint> = Object.freeze({
  fill: "none",
  stroke: "none",
  strokeWidth: "0",
  textColor: "#252423",
  textAlign: "left",
});

/** The paint / text keys a new shape of `shapeType` is written with. Pure. */
export function shapeRecipePaint(shapeType: string): Readonly<ShapeRecipePaint> {
  return shapeType === TEXT_BOX_SHAPE_TYPE ? TEXT_BOX_RECIPE_PAINT : DEFAULT_SHAPE_RECIPE_PAINT;
}

/** A stored fill / stroke that paints nothing: "", "none" or "transparent" (any case, trimmed). */
export function isNoPaint(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "" || v === "none" || v === "transparent";
}

/**
 * A stored stroke width as a number: a finite value >= 0, so "0" is NO outline
 * (it used to be `parseFloat(...) || 1`, which turned "0" into a 1 px outline
 * round every text box). Absent or unreadable = `fallback`.
 */
export function parseStrokeWidth(value: string | undefined | null, fallback = 1): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

/**
 * The flat key a shape's, a text box's and a button's BACKGROUND TRANSPARENCY
 * lives in (`@api/visualContainer`'s one map -- never re-spelled here).
 */
export const BACKGROUND_TRANSPARENCY_KEY: string = controlContainerKey("shape", "background.transparency") as string;

/**
 * The alpha a family-painted background (a shape's path, a button's face) is
 * filled with: Power BI's "Transparency" 0..100 % -> 1..0. Absent, "" or
 * unreadable = opaque; out of range is clamped. The Format pane writes the key
 * (Effects > Background > Transparency); the renderer reads it here.
 */
export function backgroundAlphaOf(transparency: string | undefined | null): number {
  if (typeof transparency !== "string" || transparency.trim() === "") return 1;
  const n = Number(transparency);
  if (!Number.isFinite(n)) return 1;
  return 1 - Math.max(0, Math.min(100, n)) / 100;
}
