//! FILENAME: app/extensions/TimelineSlicer/lib/timelineStyles.ts
// PURPOSE: The timeline style presets as DATA, and the colours a stored preset
//          id paints with.
// CONTEXT: Moved out of components/TimelineSlicerStylesGallery.tsx (the
//          presets) and rendering/timelineSlicerRenderer.ts (the lookup) so the
//          canvas renderer and the format provider's DEFAULTS
//          (lib/timelineObjectFormat.ts) read ONE answer without pulling a React
//          component into the paint path -- the Slicer's lib/slicerStyles.ts
//          precedent. The colours are categorical data, not chrome.

// ============================================================================
// Style Definition
// ============================================================================

export interface TimelineStyleDef {
  id: string;
  name: string;
  colors: {
    bg: string;
    headerBg: string;
    headerFg: string;
    selectedBg: string;
    selectedFg: string;
    periodBg: string;
    periodFg: string;
    noDataFg: string;
    groupFg: string;
    border: string;
    levelBg: string;
    levelFg: string;
    levelActiveBg: string;
    levelActiveFg: string;
    selectionBarBg: string;
  };
}

// ============================================================================
// Built-in Styles
// ============================================================================

export const TIMELINE_STYLES: TimelineStyleDef[] = [
  {
    id: "TimelineStyleLight1",
    name: "Blue Light",
    colors: {
      bg: "#FFFFFF",
      headerBg: "#4472C4",
      headerFg: "#FFFFFF",
      selectedBg: "#4472C4",
      selectedFg: "#FFFFFF",
      periodBg: "#F5F5F5",
      periodFg: "#333333",
      noDataFg: "#CCCCCC",
      groupFg: "#666666",
      border: "#8FAADC",
      levelBg: "#E8E8E8",
      levelFg: "#666666",
      levelActiveBg: "#4472C4",
      levelActiveFg: "#FFFFFF",
      selectionBarBg: "rgba(68, 114, 196, 0.3)",
    },
  },
  {
    id: "TimelineStyleLight2",
    name: "Orange Light",
    colors: {
      bg: "#FFFFFF",
      headerBg: "#ED7D31",
      headerFg: "#FFFFFF",
      selectedBg: "#ED7D31",
      selectedFg: "#FFFFFF",
      periodBg: "#F5F5F5",
      periodFg: "#333333",
      noDataFg: "#CCCCCC",
      groupFg: "#666666",
      border: "#F4B183",
      levelBg: "#E8E8E8",
      levelFg: "#666666",
      levelActiveBg: "#ED7D31",
      levelActiveFg: "#FFFFFF",
      selectionBarBg: "rgba(237, 125, 49, 0.3)",
    },
  },
  {
    id: "TimelineStyleLight3",
    name: "Green Light",
    colors: {
      bg: "#FFFFFF",
      headerBg: "#548235",
      headerFg: "#FFFFFF",
      selectedBg: "#548235",
      selectedFg: "#FFFFFF",
      periodBg: "#F5F5F5",
      periodFg: "#333333",
      noDataFg: "#CCCCCC",
      groupFg: "#666666",
      border: "#A9D18E",
      levelBg: "#E8E8E8",
      levelFg: "#666666",
      levelActiveBg: "#548235",
      levelActiveFg: "#FFFFFF",
      selectionBarBg: "rgba(84, 130, 53, 0.3)",
    },
  },
  {
    id: "TimelineStyleLight4",
    name: "Purple Light",
    colors: {
      bg: "#FFFFFF",
      headerBg: "#7B57A0",
      headerFg: "#FFFFFF",
      selectedBg: "#7B57A0",
      selectedFg: "#FFFFFF",
      periodBg: "#F5F5F5",
      periodFg: "#333333",
      noDataFg: "#CCCCCC",
      groupFg: "#666666",
      border: "#B59FCC",
      levelBg: "#E8E8E8",
      levelFg: "#666666",
      levelActiveBg: "#7B57A0",
      levelActiveFg: "#FFFFFF",
      selectionBarBg: "rgba(123, 87, 160, 0.3)",
    },
  },
  {
    id: "TimelineStyleDark1",
    name: "Blue Dark",
    colors: {
      bg: "#333333",
      headerBg: "#4472C4",
      headerFg: "#FFFFFF",
      selectedBg: "#4472C4",
      selectedFg: "#FFFFFF",
      periodBg: "#444444",
      periodFg: "#EEEEEE",
      noDataFg: "#666666",
      groupFg: "#AAAAAA",
      border: "#555555",
      levelBg: "#444444",
      levelFg: "#AAAAAA",
      levelActiveBg: "#4472C4",
      levelActiveFg: "#FFFFFF",
      selectionBarBg: "rgba(68, 114, 196, 0.4)",
    },
  },
  {
    id: "TimelineStyleDark2",
    name: "Orange Dark",
    colors: {
      bg: "#333333",
      headerBg: "#ED7D31",
      headerFg: "#FFFFFF",
      selectedBg: "#ED7D31",
      selectedFg: "#FFFFFF",
      periodBg: "#444444",
      periodFg: "#EEEEEE",
      noDataFg: "#666666",
      groupFg: "#AAAAAA",
      border: "#555555",
      levelBg: "#444444",
      levelFg: "#AAAAAA",
      levelActiveBg: "#ED7D31",
      levelActiveFg: "#FFFFFF",
      selectionBarBg: "rgba(237, 125, 49, 0.4)",
    },
  },
];

/** Map of style ID -> style definition for quick lookup. */
export const TIMELINE_STYLES_BY_ID = new Map<string, TimelineStyleDef>(
  TIMELINE_STYLES.map((s) => [s.id, s]),
);

// ============================================================================
// The colours a stored preset id paints with
// ============================================================================

/** The colours a timeline style paints with. */
export interface TimelineStyleColors {
  bg: string;
  headerBg: string;
  headerFg: string;
  selectedBg: string;
  selectedFg: string;
  periodBg: string;
  periodFg: string;
  noDataFg: string;
  groupFg: string;
  border: string;
  levelBg: string;
  levelFg: string;
  levelActiveBg: string;
  levelActiveFg: string;
  selectionBarBg: string;
}

/** What an unknown preset id paints with. */
export const DEFAULT_TIMELINE_STYLE_COLORS: TimelineStyleColors = {
  bg: "#FFFFFF",
  headerBg: "#4472C4",
  headerFg: "#FFFFFF",
  selectedBg: "#4472C4",
  selectedFg: "#FFFFFF",
  periodBg: "#F5F5F5",
  periodFg: "#333333",
  noDataFg: "#CCCCCC",
  groupFg: "#666666",
  border: "#8FAADC",
  levelBg: "#E8E8E8",
  levelFg: "#666666",
  levelActiveBg: "#4472C4",
  levelActiveFg: "#FFFFFF",
  selectionBarBg: "rgba(68, 114, 196, 0.3)",
};

/** Excel's stored preset names, kept so an old id still paints. */
export const LEGACY_TIMELINE_STYLE_COLORS: Readonly<Record<string, TimelineStyleColors>> = {
  TimelineStyleLight1: DEFAULT_TIMELINE_STYLE_COLORS,
  TimelineStyleLight2: {
    ...DEFAULT_TIMELINE_STYLE_COLORS,
    headerBg: "#ED7D31",
    selectedBg: "#ED7D31",
    border: "#F4B183",
    levelActiveBg: "#ED7D31",
    selectionBarBg: "rgba(237, 125, 49, 0.3)",
  },
  TimelineStyleLight3: {
    ...DEFAULT_TIMELINE_STYLE_COLORS,
    headerBg: "#548235",
    selectedBg: "#548235",
    border: "#A9D18E",
    levelActiveBg: "#548235",
    selectionBarBg: "rgba(84, 130, 53, 0.3)",
  },
  TimelineStyleDark1: {
    bg: "#333333",
    headerBg: "#4472C4",
    headerFg: "#FFFFFF",
    selectedBg: "#4472C4",
    selectedFg: "#FFFFFF",
    periodBg: "#444444",
    periodFg: "#EEEEEE",
    noDataFg: "#666666",
    groupFg: "#AAAAAA",
    border: "#555555",
    levelBg: "#444444",
    levelFg: "#AAAAAA",
    levelActiveBg: "#4472C4",
    levelActiveFg: "#FFFFFF",
    selectionBarBg: "rgba(68, 114, 196, 0.4)",
  },
};

/** The colours a stored `TimelineSlicer.stylePreset` paints with: a gallery style, a legacy id, else the default. */
export function timelineStyleColors(preset: string): TimelineStyleColors {
  const galleryStyle = TIMELINE_STYLES_BY_ID.get(preset);
  if (galleryStyle) return galleryStyle.colors;
  return LEGACY_TIMELINE_STYLE_COLORS[preset] || DEFAULT_TIMELINE_STYLE_COLORS;
}

