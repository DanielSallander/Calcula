//! FILENAME: app/src/core/theme/__tests__/wcag.ts
// PURPOSE: WCAG 2.x relative luminance and contrast ratio, for the theme tests.
// CONTEXT: Test support only (not a *.test.ts file, so vitest never collects it
//          as a suite). It lives in one place because two suites need it —
//          tokens.test.ts checks the light/dark BASELINES and skinLoader.test.ts
//          checks every built-in SKIN after merging — and two copies of a
//          contrast formula is how one of them ends up with the wrong gamma.
//
//          It accepts PLAIN HEX ONLY and throws on anything else. A token whose
//          value is `var(--x)` or `color-mix(...)` cannot be measured without a
//          browser, and a helper that quietly returned "infinite contrast" for
//          what it could not parse would pass every assertion it was given.

/** `#rgb` / `#rrggbb` to an [r, g, b] triple, or null when not plain hex. */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance of an sRGB triple. */
export function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const toHex = (rgb: number[]): string =>
  "#" + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
const toLinear = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number): number =>
  255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/**
 * What the browser paints for `color-mix(in oklab, <hex> <p>%, black)`.
 * Black is the OKLab origin, so the mix scales L, a and b by p; the cube
 * in the OKLab -> LMS step makes that p^3 in LMS, and linear sRGB is linear
 * in LMS, so the result is simply linear sRGB x p^3 (always in gamut, hue
 * kept). Chromium paints exactly this: #047857 at 88% -> #036448.
 */
export function mixWithBlackOklab(hex: string, fraction: number): string {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`not plain hex: ${hex}`);
  return toHex(rgb.map((v) => fromLinear(toLinear(v) * fraction ** 3)));
}

/** `fg` at `alpha` over an opaque `bg`, in sRGB (what color-mix(in srgb, fg a%, transparent) paints on bg). */
export function compositeOver(fg: string, alpha: number, bg: string): string {
  const f = parseHex(fg);
  const b = parseHex(bg);
  if (!f || !b) throw new Error(`not a plain hex pair: ${fg} / ${bg}`);
  return toHex(f.map((v, i) => v * alpha + b[i] * (1 - alpha)));
}

/** WCAG contrast ratio of two plain-hex colours (order does not matter). */
export function contrast(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) throw new Error(`not a plain hex pair: ${a} / ${b}`);
  const la = luminance(ca);
  const lb = luminance(cb);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
