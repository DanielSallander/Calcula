//! FILENAME: app/extensions/TimelineSlicer/components/TimelineSlicerStylesGallery.tsx
// PURPOSE: Timeline slicer style presets and gallery component.

import React from "react";
import { css } from "@emotion/css";

// The preset DATA lives in lib/timelineStyles.ts (the renderer and the format
// provider read it without pulling this component in); re-exported here for
// the gallery's existing importers.
import { TIMELINE_STYLES } from "../lib/timelineStyles";
export { TIMELINE_STYLES, TIMELINE_STYLES_BY_ID, type TimelineStyleDef } from "../lib/timelineStyles";

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
