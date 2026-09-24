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
// WCAG relative luminance / contrast. Shared with skinLoader.test.ts, which
// holds every built-in SKIN to the same bars after merging.
import { contrast, compositeOver, mixWithBlackOklab } from "./__tests__/wcag";

const ALL_TOKENS = Object.values(THEME_TOKENS) as string[];

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

// --- Calcula Clusters -------------------------------------------------------
//
// The ribbon redesign introduced a STATE colour, a tinted cluster card, six
// contextual tab accents, a tooltip that inverts with the base and a sidebar
// activity bar. Every one of those is a foreground on a new background, and
// every pair below is one the mockup was reviewed on in LIGHT only — the same
// blind spot the tone pairs above exist for. The bars:
//   3:1   WCAG 1.4.11 non-text contrast — a checkbox tick, a focus ring, a
//         pressed-state edge, a tab indicator. The state accent is never text.
//   4.5:1 WCAG 1.4.3 body text — group captions (11px), tab labels (12px),
//         tooltip text (12px) and activity-bar glyphs, all well under the
//         18.66px-bold "large text" exemption.
//
// Every value measured here must be PLAIN HEX in the baseline; `contrast()`
// throws on a var() or a color-mix(), so a future edit that turns one of these
// into a reference fails loudly instead of being skipped.

const BASELINES = [
  ["light", defaultTheme],
  ["dark", darkTheme],
] as const;

const TAB_ACCENTS = [
  THEME_TOKENS.TAB_ACCENT_CHART,
  THEME_TOKENS.TAB_ACCENT_TABLE,
  THEME_TOKENS.TAB_ACCENT_PIVOT,
  THEME_TOKENS.TAB_ACCENT_SLICER,
  THEME_TOKENS.TAB_ACCENT_SPARKLINE,
  THEME_TOKENS.TAB_ACCENT_REPORT,
] as const;

describe("Calcula Clusters tokens are legible in both baselines", () => {
  for (const [name, theme] of BASELINES) {
    it(`${name}: the state accent clears 3:1 on the surface and on a cluster card`, () => {
      const accent = theme[THEME_TOKENS.STATE_ACCENT];
      expect(contrast(accent, theme[THEME_TOKENS.BG_SURFACE])).toBeGreaterThanOrEqual(3);
      expect(contrast(accent, theme[THEME_TOKENS.RIBBON_CLUSTER_BG])).toBeGreaterThanOrEqual(3);
    });

    for (const tab of TAB_ACCENTS) {
      it(`${name}: ${tab} reads as text on the ribbon frame`, () => {
        expect(
          contrast(theme[tab], theme[THEME_TOKENS.RIBBON_FRAME_BG]),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }

    it(`${name}: the group caption reads on the band AND on a cluster card`, () => {
      // Both. The caption sits on the band beneath its card, but the card is
      // the darker of the two grounds this token can land on, and a token is
      // only safe to reuse if it reads on both. The mockup's #6b7280 passed the
      // band (4.83) while failing the card (4.39) — exactly the case a
      // band-only check would have waved through.
      const fg = theme[THEME_TOKENS.RIBBON_GROUP_LABEL_FG];
      expect(contrast(fg, theme[THEME_TOKENS.RIBBON_BAND_BG])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(fg, theme[THEME_TOKENS.RIBBON_CLUSTER_BG])).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: tooltip text reads on the tooltip`, () => {
      expect(
        contrast(theme[THEME_TOKENS.TOOLTIP_FG], theme[THEME_TOKENS.TOOLTIP_BG]),
      ).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: activity-bar glyphs read on the activity bar`, () => {
      expect(
        contrast(theme[THEME_TOKENS.ACTIVITY_BAR_FG], theme[THEME_TOKENS.ACTIVITY_BAR_BG]),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("the state accent is a genuinely different value in dark", () => {
    // The light value is under 3:1 on the dark surface; copying it across is
    // the ICON_DANGER mistake again.
    expect(darkTheme[THEME_TOKENS.STATE_ACCENT]).not.toBe(defaultTheme[THEME_TOKENS.STATE_ACCENT]);
  });

  it("the icon accent, focus ring and tab indicator all FOLLOW the state accent", () => {
    // They are references, not copies, so a skin that changes --state-accent
    // (Calcula Soft does) recolours every one of them without restating it.
    // A literal here would be a second source of truth that drifts on the
    // first skin that retunes the accent. The light icon accent is DERIVED
    // (the state colour one step darker) but still names --state-accent.
    for (const [, theme] of BASELINES) {
      expect(theme[THEME_TOKENS.FOCUS_RING_COLOR]).toBe("var(--state-accent)");
      expect(theme[THEME_TOKENS.RIBBON_TAB_INDICATOR]).toBe("var(--state-accent)");
      expect(theme[THEME_TOKENS.ACTIVITY_BAR_INDICATOR]).toBe("var(--state-accent)");
    }
    expect(defaultTheme[THEME_TOKENS.ICON_ACCENT]).toBe(
      "color-mix(in oklab, var(--state-accent) 88%, black)",
    );
    expect(darkTheme[THEME_TOKENS.ICON_ACCENT]).toBe("var(--state-accent)");
  });

  it("light: the icon green sits BETWEEN the 50% grey and near-black", () => {
    // No single green clears 3:1 from both the SOFT grey and STRONG (the best
    // any luminance can do is 2.2:1 each), so the icon green is placed
    // between them and the drawings give it a pixel of background instead
    // (docs/design/ICONS.md 2.2). This pins BOTH sides of that trade:
    // today's undarkened #047857 (a 100% mix) is 1.50 on the grey and fails
    // the first floor; an 80% mix is 2.06 under STRONG and fails the second.
    const t = defaultTheme;
    const m = /^color-mix\(in oklab, var\(--state-accent\) (\d+)%, black\)$/.exec(
      t[THEME_TOKENS.ICON_ACCENT],
    );
    expect(m, "ICON_ACCENT must stay a derived reference").not.toBeNull();
    const green = mixWithBlackOklab(t[THEME_TOKENS.STATE_ACCENT], Number(m![1]) / 100);
    const soft = /currentColor (\d+)%/.exec(t[THEME_TOKENS.ICON_FILL_SOFT]);
    expect(soft, "ICON_FILL_SOFT must stay a tint of currentColor").not.toBeNull();
    const cluster = t[THEME_TOKENS.RIBBON_CLUSTER_BG];
    const strong = t[THEME_TOKENS.TEXT_PRIMARY];
    const grey = compositeOver(strong, Number(soft![1]) / 100, cluster);
    // #036448 today: 6.53 / 7.19 / 1.97 / 2.47.
    expect(contrast(green, cluster)).toBeGreaterThanOrEqual(3);
    expect(contrast(green, t[THEME_TOKENS.RIBBON_BAND_BG])).toBeGreaterThanOrEqual(3);
    expect(contrast(green, grey)).toBeGreaterThanOrEqual(1.9);
    expect(contrast(green, strong)).toBeGreaterThanOrEqual(2.4);
  });
});
