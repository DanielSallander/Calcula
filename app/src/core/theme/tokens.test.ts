//! FILENAME: app/src/core/theme/tokens.test.ts
// PURPOSE: The two things about THEME_TOKENS that nothing was checking — that
//          every declared token actually HAS a value in both baselines, and
//          that the semantic tone pairs are legible in both.
// CONTEXT: Adding a token name is three edits (tokens.ts, defaultTheme.ts,
//          darkTheme.ts) and missing the third is silent: the variable is
//          simply never stamped, so every `var(--x, fallback)` quietly takes
//          its light literal fallback and the DARK skin is the only place it
//          shows. That is invisible to a light-mode developer, which is
//          exactly the class of bug this file exists to make loud.

import { describe, expect, it } from "vitest";
import { THEME_TOKENS } from "./tokens";
import { defaultTheme } from "./defaultTheme";
import { darkTheme } from "./darkTheme";

const ALL_TOKENS = Object.values(THEME_TOKENS) as string[];

// --- WCAG relative luminance / contrast -------------------------------------

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) throw new Error(`not a plain hex pair: ${a} / ${b}`);
  const la = luminance(ca);
  const lb = luminance(cb);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("theme token completeness", () => {
  it("every declared token has a value in the LIGHT baseline", () => {
    const missing = ALL_TOKENS.filter((t) => defaultTheme[t] === undefined);
    expect({ missingFromDefaultTheme: missing }).toEqual({ missingFromDefaultTheme: [] });
  });

  it("every declared token has a value in the DARK baseline", () => {
    // The one that actually bites: a token missing here looks perfect until
    // someone switches to Dark.
    const missing = ALL_TOKENS.filter((t) => darkTheme[t] === undefined);
    expect({ missingFromDarkTheme: missing }).toEqual({ missingFromDarkTheme: [] });
  });

  it("neither baseline declares a value for a token that does not exist", () => {
    const known = new Set(ALL_TOKENS);
    const strayLight = Object.keys(defaultTheme).filter((k) => !known.has(k));
    const strayDark = Object.keys(darkTheme).filter((k) => !known.has(k));
    expect({ strayLight, strayDark }).toEqual({ strayLight: [], strayDark: [] });
  });
});

describe("semantic tone pairs are legible", () => {
  const TONES = ["danger", "warn", "ok", "info"] as const;

  for (const [name, theme, surface] of [
    ["light", defaultTheme, defaultTheme[THEME_TOKENS.BG_SURFACE]],
    ["dark", darkTheme, darkTheme[THEME_TOKENS.BG_SURFACE]],
  ] as const) {
    for (const tone of TONES) {
      it(`${name}: ${tone} foreground reads on its own background`, () => {
        const fg = theme[`--tone-${tone}-fg`];
        const bg = theme[`--tone-${tone}-bg`];
        // 4.5:1 is WCAG AA for body text; these render at 11-13px.
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${name}: ${tone} foreground reads on the plain surface`, () => {
        // A tone is used BOTH as a filled badge and as bare coloured text on a
        // card. Checking only the badge is how a tone ends up invisible the
        // first time someone uses it without its background — the exact shape
        // of "map TEXT to a token while its surface stays a fixed literal".
        const fg = theme[`--tone-${tone}-fg`];
        expect(contrast(fg, surface)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("the light and dark tone foregrounds are genuinely different values", () => {
    // Reusing the light foreground in dark is the documented ICON_DANGER
    // mistake (#c42b1c measured 2.7:1 on the dark panel).
    for (const tone of TONES) {
      const key = `--tone-${tone}-fg`;
      expect(darkTheme[key], `${key} was copied from the light baseline`).not.toBe(
        defaultTheme[key],
      );
    }
  });
});
