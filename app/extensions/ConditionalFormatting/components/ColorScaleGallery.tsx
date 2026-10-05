//! FILENAME: app/extensions/ConditionalFormatting/components/ColorScaleGallery.tsx
// PURPOSE: Conditional Formatting > Color Scales: Excel's twelve presets as
//          swatches, then More Rules....
// CONTEXT: Hosted twice -- the menu bar's Format > Conditional Formatting
//          flyout and the Home tab's Conditional Formatting hero (the kit's
//          RegisteredMenuButton draws this item's customContent in a MenuSub
//          card) -- so it paints its own @api/layout surface (galleryChrome.ts
//          says why). Excel's layout: four per row, three rows.
//
//          Each swatch shows the scale the way Excel's picture does: the
//          HIGHEST value's colour on top, the lowest at the bottom, which is
//          also the order of the words in its name ("Green - Yellow - Red").
//          The preview colours are DATA, inside `data-colour-data`.

import React from "react";
import { css } from "@emotion/css";
import type { PresetColorScale } from "../types";
import { PRESET_COLOR_SCALES, colorScaleName } from "../types";
import {
  galleryRoot,
  optionGrid,
  optionButton,
  footerRule,
  moreRulesRow,
  handleGalleryKeyDown,
  OPTION_ATTR,
  COLUMNS_ATTR,
  MORE_RULES_ATTR,
} from "./galleryChrome";

const COLUMNS = 4;

const swatch = css`
  display: block;
  width: 30px;
  height: 30px;
  border-radius: 2px;
`;

/** Top (highest value) to bottom (lowest), as the name reads. */
function buildGradient(preset: PresetColorScale): string {
  const stops = preset.midColor
    ? [preset.maxColor, preset.midColor, preset.minColor]
    : [preset.maxColor, preset.minColor];
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

export interface ColorScaleGalleryProps {
  onSelect: (preset: PresetColorScale) => void;
  onMoreRules: () => void;
  onClose: () => void;
}

export function ColorScaleGallery({
  onSelect,
  onMoreRules,
  onClose,
}: ColorScaleGalleryProps): React.ReactElement {
  return (
    <div className={galleryRoot} data-testid="cf-gallery-colorScales" onKeyDown={handleGalleryKeyDown}>
      <div
        role="group"
        aria-label="Color Scales"
        className={optionGrid}
        style={{ gridTemplateColumns: `repeat(${COLUMNS}, auto)` }}
        {...{ [COLUMNS_ATTR]: COLUMNS }}
      >
        {PRESET_COLOR_SCALES.map((preset, idx) => {
          const name = colorScaleName(preset);
          return (
            <button
              key={preset.label}
              type="button"
              className={optionButton}
              title={name}
              aria-label={name}
              data-testid={`cf-colorScale-${idx}`}
              {...{ [OPTION_ATTR]: "" }}
              onClick={() => {
                onSelect(preset);
                onClose();
              }}
            >
              <span className={swatch} data-colour-data="" style={{ background: buildGradient(preset) }} />
            </button>
          );
        })}
      </div>
      <div className={footerRule} role="separator" />
      <button
        type="button"
        className={moreRulesRow}
        data-testid="cf-colorScales-moreRules"
        {...{ [MORE_RULES_ATTR]: "" }}
        onClick={() => {
          onMoreRules();
          onClose();
        }}
      >
        More Rules...
      </button>
    </div>
  );
}
