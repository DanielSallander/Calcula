//! FILENAME: app/src/api/layout/colors.ts
// PURPOSE: The colour DATA the @api/layout colour primitives offer — the Office
//          standard row, the quick-pick set, their names — and the two hex
//          helpers every picker needs (normalise, name).
// CONTEXT: The second (and last) file in @api/layout where a colour literal is
//          correct; theme.ts is the other. The difference matters: theme.ts
//          holds CHROME fallbacks that must follow the skin, this file holds
//          CATEGORICAL colours a user picks and a document stores. "Red" is red
//          in the light skin, the dark skin and high contrast alike, because it
//          is the value that will be written into a cell, not the paint of a
//          button. Rendered elements that show one of these carry the
//          `data-colour-data` attribute, which is how findHardcodedColours
//          (testing.ts) tells data from chrome.
//
//          Before this file the same ten standard colours were typed out in the
//          Format Cells ColorPicker, the mini toolbar and the Home tab, and the
//          three "quick" sets had drifted apart. New pickers import from here.

// ============================================================================
// Palettes
// ============================================================================

/**
 * Office's "Standard Colors" row, in Office's order: dark red through purple.
 * Identical to the row the Format Cells ColorPicker shows, so a colour picked
 * in the ribbon and one picked in the dialog compare equal.
 */
/**
 * The value an `<input type="color">` shows when there is no colour to show.
 * The element only accepts `#rrggbb`, so "no colour" has to be spelled as one;
 * black is what the browser itself falls back to.
 */
export const DEFAULT_PICKER_COLOR = "#000000";

export const STANDARD_COLORS: readonly string[] = Object.freeze([
  "#c00000",
  "#ff0000",
  "#ffc000",
  "#ffff00",
  "#92d050",
  "#00b050",
  "#00b0f0",
  "#0070c0",
  "#002060",
  "#7030a0",
]);

/**
 * A two-row quick-pick set (20 colours, ten per row) for surfaces without a
 * document theme to offer — the mini toolbar, chart element pickers. Row one
 * is the grey ramp plus the warm half of the standard row; row two the cool
 * half plus five brighter companions. The same set the mini toolbar ships.
 */
export const QUICK_COLORS: readonly string[] = Object.freeze([
  "#000000",
  "#404040",
  "#808080",
  "#bfbfbf",
  "#ffffff",
  "#c00000",
  "#ff0000",
  "#ffc000",
  "#ffff00",
  "#92d050",
  "#00b050",
  "#00b0f0",
  "#0070c0",
  "#002060",
  "#7030a0",
  "#ff6699",
  "#ff9933",
  "#cccc00",
  "#66cc66",
  "#33cccc",
]);

/** Human names for the colours above: a swatch's accessible name and tooltip.
 *  A screen reader announcing "hash C zero zero zero zero zero" is no name.
 *  A Map rather than an object literal: the keys are hex strings, which the
 *  repo's camelCase naming rule would reject as property names. */
const COLOR_NAMES: ReadonlyMap<string, string> = new Map([
  ["#c00000", "Dark red"],
  ["#ff0000", "Red"],
  ["#ffc000", "Orange"],
  ["#ffff00", "Yellow"],
  ["#92d050", "Light green"],
  ["#00b050", "Green"],
  ["#00b0f0", "Light blue"],
  ["#0070c0", "Blue"],
  ["#002060", "Dark blue"],
  ["#7030a0", "Purple"],
  ["#000000", "Black"],
  ["#404040", "Dark grey"],
  ["#808080", "Grey"],
  ["#bfbfbf", "Light grey"],
  ["#ffffff", "White"],
  ["#ff6699", "Pink"],
  ["#ff9933", "Light orange"],
  ["#cccc00", "Olive"],
  ["#66cc66", "Soft green"],
  ["#33cccc", "Turquoise"],
]);

// ============================================================================
// Helpers
// ============================================================================

/**
 * The canonical `#rrggbb` (lower case) form of a hex colour, or null when the
 * input is not one. Accepts `#rgb`, `#rrggbb`, and the same without the `#`
 * (what a user types into a hex field). Anything else — `rgb()`, a CSS name,
 * an 8-digit hex with alpha — is null: `<input type="color">` only speaks
 * `#rrggbb`, and a picker must never feed it something it silently turns into
 * black.
 */
export function normalizeHex(color: string | null | undefined): string | null {
  if (typeof color !== "string") return null;
  const raw = color.trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    const [r, g, b] = raw.toLowerCase().split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
}

/**
 * A colour's accessible name: its human name when it is one of the palettes
 * above ("Dark red"), else its hex in upper case ("#1A2B3C"), else the input
 * unchanged (a CSS name or an rgb() string is already readable).
 */
export function colorLabel(color: string): string {
  const hex = normalizeHex(color);
  if (hex === null) return color;
  return COLOR_NAMES.get(hex) ?? hex.toUpperCase();
}

/** Two colours are the same colour (case- and shorthand-insensitive for hex,
 *  exact otherwise). What a picker uses to mark the current value selected. */
export function sameColor(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const ha = normalizeHex(a);
  const hb = normalizeHex(b);
  if (ha !== null && hb !== null) return ha === hb;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
