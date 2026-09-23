//! FILENAME: app/extensions/Slicer/lib/slicerStyles.ts
// PURPOSE: The slicer style presets — Excel's Slicer Styles gallery as DATA.
// CONTEXT: Moved out of components/SlicerStylesGallery.tsx when the gallery
//          became the shared @api/layout StyleGallery. The colours here are
//          categorical data, not chrome: they are what a slicer PAINTS (the
//          canvas renderer reads `thumb` through SLICER_STYLES_BY_ID) and what
//          a gallery thumbnail previews, so they stay literal and must not
//          follow the skin. The gallery marks every thumbnail it renders with
//          `data-colour-data`, which is how the chrome colour scan tells the
//          two apart.
//
//          Ids are stable wire values (`slicer-light-1` ... `slicer-dark-14`):
//          they are persisted as `Slicer.stylePreset`, so they may never be
//          renumbered. Numbering follows Excel: within a category, style
//          `group * 7 + accentIndex + 1`, so each run of seven is one design
//          across the seven Office accents.

// ============================================================================
// Types
// ============================================================================

/** The eight colours a slicer style paints with. */
export interface SlicerThumbColors {
  headerBg: string;
  headerFg: string;
  selectedBg: string;
  selectedFg: string;
  itemBg: string;
  itemFg: string;
  bg: string;
  border: string;
}

export interface SlicerStyleDef {
  id: string;
  category: "light" | "dark";
  /** Design row within the category (seven styles per group). */
  group: number;
  /** Office accent the style is built on (0 = neutral, 1-6 = Accent 1-6). */
  accentIndex: number;
  thumb: SlicerThumbColors;
}

// ============================================================================
// Accent Color Palette (matches Excel Office theme)
// ============================================================================

interface AccentColor {
  base: string;
  light: string;
  lighter: string;
  medium: string;
  dark: string;
}

const STYLE_ACCENTS: AccentColor[] = [
  // 0: No accent (gray/neutral)
  { base: "#999999", light: "#f2f2f2", lighter: "#f8f8f8", medium: "#d9d9d9", dark: "#595959" },
  // 1: Blue (Accent 1)
  { base: "#4472c4", light: "#d6e4f0", lighter: "#edf2f9", medium: "#8faadc", dark: "#2f5496" },
  // 2: Orange (Accent 2)
  { base: "#ed7d31", light: "#fbe5d6", lighter: "#fdf2eb", medium: "#f4b183", dark: "#c55a11" },
  // 3: Gray (Accent 3)
  { base: "#a5a5a5", light: "#ededed", lighter: "#f6f6f6", medium: "#c9c9c9", dark: "#7f7f7f" },
  // 4: Gold (Accent 4)
  { base: "#ffc000", light: "#fff2cc", lighter: "#fff9e5", medium: "#ffd966", dark: "#bf9000" },
  // 5: Light Blue (Accent 5)
  { base: "#5b9bd5", light: "#deeaf6", lighter: "#eff5fb", medium: "#9bc2e6", dark: "#2e75b6" },
  // 6: Green (Accent 6)
  { base: "#70ad47", light: "#e2efda", lighter: "#f0f7ec", medium: "#a9d18e", dark: "#548235" },
];

// ============================================================================
// Style Generation
// ============================================================================

/** The number a style carries in its id and its name ("Light 9"). */
export function slicerStyleNumber(style: Pick<SlicerStyleDef, "group" | "accentIndex">): number {
  return style.group * 7 + style.accentIndex + 1;
}

function addStyle(
  styles: SlicerStyleDef[],
  category: SlicerStyleDef["category"],
  group: number,
  accentIndex: number,
  thumb: SlicerThumbColors,
): void {
  const num = slicerStyleNumber({ group, accentIndex });
  styles.push({ id: `slicer-${category}-${num}`, category, group, accentIndex, thumb });
}

/** Build every preset, sorted light-then-dark and by number within each. */
export function generateSlicerStyles(): SlicerStyleDef[] {
  const styles: SlicerStyleDef[] = [];

  STYLE_ACCENTS.forEach((accent, i) => {
    // --- LIGHT Group 0 (Light 1-7): White bg, colored header, light item bg ---
    addStyle(styles, "light", 0, i, {
      headerBg: accent.base,
      headerFg: "#ffffff",
      selectedBg: accent.base,
      selectedFg: "#ffffff",
      itemBg: accent.lighter,
      itemFg: "#333333",
      bg: "#ffffff",
      border: accent.medium,
    });
    // --- LIGHT Group 1 (Light 8-14): White bg, subtle header, bordered items ---
    addStyle(styles, "light", 1, i, {
      headerBg: accent.light,
      headerFg: accent.dark,
      selectedBg: accent.base,
      selectedFg: "#ffffff",
      itemBg: "#ffffff",
      itemFg: "#333333",
      bg: "#ffffff",
      border: accent.medium,
    });
    // --- LIGHT Group 2 (Light 15-21): Clean white, no item bg, accent selected ---
    addStyle(styles, "light", 2, i, {
      headerBg: "#ffffff",
      headerFg: accent.dark,
      selectedBg: accent.light,
      selectedFg: accent.dark,
      itemBg: "#ffffff",
      itemFg: "#666666",
      bg: "#ffffff",
      border: accent.medium,
    });
    // --- LIGHT Group 3 (Light 22-28): Banded look, accent header border ---
    addStyle(styles, "light", 3, i, {
      headerBg: accent.base,
      headerFg: "#ffffff",
      selectedBg: accent.medium,
      selectedFg: "#ffffff",
      itemBg: accent.light,
      itemFg: "#333333",
      bg: accent.lighter,
      border: accent.base,
    });

    // --- DARK Group 0 (Dark 1-7): Dark bg, accent header, lighter items ---
    addStyle(styles, "dark", 0, i, {
      headerBg: accent.dark,
      headerFg: "#ffffff",
      selectedBg: accent.base,
      selectedFg: "#ffffff",
      itemBg: "#444444",
      itemFg: "#eeeeee",
      bg: "#333333",
      border: "#555555",
    });
    // --- DARK Group 1 (Dark 8-14): Full accent dark ---
    addStyle(styles, "dark", 1, i, {
      headerBg: accent.dark,
      headerFg: "#ffffff",
      selectedBg: accent.medium,
      selectedFg: "#ffffff",
      itemBg: accent.dark,
      itemFg: "#eeeeee",
      bg: "#2a2a2a",
      border: accent.dark,
    });
  });

  // Sort by category order (light, dark), then by id number
  const catOrder = { light: 0, dark: 1 };
  styles.sort((a, b) => {
    const catDiff = catOrder[a.category] - catOrder[b.category];
    if (catDiff !== 0) return catDiff;
    return slicerStyleNumber(a) - slicerStyleNumber(b);
  });

  return styles;
}

export const SLICER_STYLES = generateSlicerStyles();
export const SLICER_STYLES_BY_ID = new Map(SLICER_STYLES.map((s) => [s.id, s]));

/** Default style: Light 2 — blue accent, coloured header. */
export const DEFAULT_SLICER_STYLE_ID = "slicer-light-2";

// ============================================================================
// Gallery metadata
// ============================================================================

/** Category headings, in gallery order. */
export const SLICER_STYLE_CATEGORY_LABELS: Record<SlicerStyleDef["category"], string> = {
  light: "Light",
  dark: "Dark",
};

/** The name a style shows in the gallery and announces ("Light 2"). */
export function slicerStyleName(style: SlicerStyleDef): string {
  return `${SLICER_STYLE_CATEGORY_LABELS[style.category]} ${slicerStyleNumber(style)}`;
}
