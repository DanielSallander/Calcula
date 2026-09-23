//! FILENAME: app/extensions/BuiltIn/DocumentTheme/lib/themeChoices.ts
//! PURPOSE: The data the Page Layout theme heroes offer — the accent slots a
//!          theme row previews, the theme font pairs — and their stable test ids.
//! CONTEXT: Kept out of the component files so those export only components
//!          (React fast refresh), and so tests can name rows without copying
//!          the lists.

/** The six accent slots a theme row previews, in Office order. */
export const THEME_ACCENT_KEYS = [
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
] as const;

/** Predefined font pairs (matching common Excel font combinations). */
export const FONT_PAIRS: { heading: string; body: string }[] = [
  { heading: "Calibri Light", body: "Calibri" },
  { heading: "Cambria", body: "Calibri" },
  { heading: "Century Gothic", body: "Century Gothic" },
  { heading: "Trebuchet MS", body: "Trebuchet MS" },
  { heading: "Georgia", body: "Verdana" },
  { heading: "Arial", body: "Arial" },
  { heading: "Segoe UI", body: "Segoe UI" },
  { heading: "Consolas", body: "Consolas" },
];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Stable test id for a theme row in the Themes gallery. */
export function themeRowTestId(name: string): string {
  return `page-layout-theme-${slug(name)}`;
}

/** Stable test id for a font-pair row in the Fonts list. */
export function fontPairTestId(pair: { heading: string; body: string }): string {
  return `page-layout-font-${slug(pair.heading)}--${slug(pair.body)}`;
}
