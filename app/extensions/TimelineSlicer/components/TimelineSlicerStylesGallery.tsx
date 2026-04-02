//! FILENAME: app/extensions/TimelineSlicer/components/TimelineSlicerStylesGallery.tsx
// PURPOSE: Timeline slicer style presets and gallery component.

import React from "react";
import { css } from "@emotion/css";

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
// Gallery Component
// ============================================================================

const galleryStyles = {
  container: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  `,
  swatch: css`
    width: 64px;
    height: 40px;
    border: 2px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    position: relative;
    overflow: hidden;

    &:hover {
      border-color: #999;
    }
  `,
  swatchSelected: css`
    border-color: #0078d4 !important;
  `,
  swatchHeader: css`
    height: 12px;
  `,
  swatchBody: css`
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
  `,
  swatchBar: css`
    height: 4px;
    width: 60%;
    border-radius: 2px;
  `,
};

interface TimelineStylesGalleryProps {
  selected: string;
  onSelect: (styleId: string) => void;
}

export function TimelineStylesGallery({
  selected,
  onSelect,
}: TimelineStylesGalleryProps): React.ReactElement {
  return (
    <div className={galleryStyles.container}>
      {TIMELINE_STYLES.map((style) => (
        <div
          key={style.id}
          className={`${galleryStyles.swatch} ${
            style.id === selected ? galleryStyles.swatchSelected : ""
          }`}
          title={style.name}
          onClick={() => onSelect(style.id)}
        >
          <div
            className={galleryStyles.swatchHeader}
            style={{ backgroundColor: style.colors.headerBg }}
          />
          <div
            className={galleryStyles.swatchBody}
            style={{ backgroundColor: style.colors.bg }}
          >
            <div
              className={galleryStyles.swatchBar}
              style={{ backgroundColor: style.colors.selectedBg }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
