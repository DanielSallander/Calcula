//! FILENAME: app/extensions/_shared/lib/fontList.ts
// PURPOSE: Common font names/sizes shared by the Format Cells dialog Font tab
//          and the Home tab's ribbon font pickers -- and Excel's Increase /
//          Decrease Font Size ladder, re-exported from @api/fontSizeLadder so
//          the Home tab's buttons and the shell's mini format toolbar step
//          through ONE ladder (review finding (i), 2026-10-04: the toolbar's own
//          copy had no 26 and wrote past both ends). The shell cannot import
//          this folder, which is why the one copy lives in @api.

export { FONT_SIZE_LADDER, fontSizeStep } from "@api/fontSizeLadder";

/** Theme font keywords - resolve to the active theme's heading/body fonts. */
export const THEME_FONTS = ["Body", "Headings"] as const;

export const FONT_LIST: string[] = [
  "system-ui",
  "Arial",
  "Arial Black",
  "Calibri",
  "Calibri Light",
  "Cambria",
  "Cambria Math",
  "Candara",
  "Century Gothic",
  "Comic Sans MS",
  "Consolas",
  "Constantia",
  "Corbel",
  "Courier New",
  "Franklin Gothic Medium",
  "Garamond",
  "Georgia",
  "Impact",
  "Lucida Console",
  "Lucida Sans Unicode",
  "Palatino Linotype",
  "Segoe UI",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
];

export const FONT_SIZES: number[] = [
  6, 7, 8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72,
];
