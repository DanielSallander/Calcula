// FILENAME: app/extensions/Collaboration/lib/inkContrast.ts
// PURPOSE: Which ink reads on a cell's fill: the WCAG contrast ratio between
//          two opaque colours, and a parser for the colour spellings a cell
//          style carries.
// CONTEXT: The writeback rejected-value text (writebackDecorations.ts) is drawn
//          in the danger tone over whatever fill the cell shows -- conditional
//          formatting's included, which it overrides on purpose. The active
//          skin's danger ink is made for the skin's own cell background, so on an
//          explicit fill of the opposite lightness it was unreadable: the Dark
//          skin's #fda29b on Excel's "Light Red Fill" #ffc7ce is 1.32:1, where
//          the preset's own #9c0006 text read at 5.92:1 (2026-10-22 review).
//          Pure functions, no imports: unit-tested without a canvas.

/** Opaque sRGB channels, 0..255. */
export type Rgb = readonly [number, number, number];

/** The least contrast at which a status ink counts as readable on a fill (WCAG 1.4.11's 3:1). */
export const MIN_INK_CONTRAST = 3;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_FN = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i;

/**
 * An OPAQUE colour from the spellings a cell style and a theme token use:
 * `#rgb`, `#rrggbb` (also without the `#`, as the backend sometimes sends it),
 * `#rgba` / `#rrggbbaa` and `rgb()` / `rgba()` with commas -- each only when
 * fully opaque. Null for anything else (a translucent colour, a named colour,
 * `color-mix(...)`): the caller then keeps its default rather than guess what
 * is painted underneath.
 */
export function parseOpaqueColour(colour: string | undefined | null): Rgb | null {
  if (!colour) return null;
  const c = colour.trim();
  const hex = HEX.exec(c);
  if (hex) {
    const h = hex[1];
    const short = h.length <= 4;
    const channel = (i: number): number =>
      short ? parseInt(h[i] + h[i], 16) : parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (h.length === 4 || h.length === 8) {
      if (channel(3) !== 255) return null;
    }
    return [channel(0), channel(1), channel(2)];
  }
  const fn = RGB_FN.exec(c);
  if (fn) {
    const [r, g, b] = [fn[1], fn[2], fn[3]].map(Number);
    if (![r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) return null;
    if (fn[4] !== undefined) {
      const a = fn[4].endsWith("%") ? Number(fn[4].slice(0, -1)) / 100 : Number(fn[4]);
      if (a !== 1) return null;
    }
    return [r, g, b];
  }
  return null;
}

/** WCAG 2 relative luminance of an sRGB colour, 0 (black) .. 1 (white). */
export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio between two opaque colours, 1 .. 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The first of `inks` (in preference order) that reads on `fill` -- at least
 * {@link MIN_INK_CONTRAST} -- or null when none does or the fill cannot be
 * read as an opaque colour. An ink that cannot be parsed is passed over.
 */
export function firstReadableInk(fill: string, inks: readonly string[]): string | null {
  const ground = parseOpaqueColour(fill);
  if (!ground) return null;
  for (const ink of inks) {
    const rgb = parseOpaqueColour(ink);
    if (rgb && contrastRatio(rgb, ground) >= MIN_INK_CONTRAST) return ink;
  }
  return null;
}
