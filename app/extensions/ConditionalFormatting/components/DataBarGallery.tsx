//! FILENAME: app/extensions/ConditionalFormatting/components/DataBarGallery.tsx
// PURPOSE: Conditional Formatting > Data Bars: Excel's six colours as Gradient
//          Fill and as Solid Fill bars, then More Rules....
// CONTEXT: Hosted by the menu bar AND by the Home tab's Conditional Formatting
//          hero, so it paints its own @api/layout surface (galleryChrome.ts
//          says why -- the old tiles were the menu bar's #252526, which on the
//          ribbon's light card read as dark holes). Excel's layout: two groups,
//          three per row. Each preview is three bars of different lengths on a
//          cell-white ground, the way Excel draws it; its colours are DATA.
//
//          The gradient bars keep a tooltip beginning "Gradient": the
//          fixall-edit journey picks one by `button[title^="Gradient"]`.

import React from "react";
import { css } from "@emotion/css";
import { PRESET_DATA_BARS } from "../types";
import {
  galleryRoot,
  groupHeading,
  optionGrid,
  optionButton,
  footerRule,
  moreRulesRow,
  handleGalleryKeyDown,
  OPTION_ATTR,
  COLUMNS_ATTR,
  MORE_RULES_ATTR,
} from "./galleryChrome";

const COLUMNS = 3;
/** Bar lengths in the preview, longest first (percent of the cell). */
const BAR_LENGTHS = [90, 60, 35];

const preview = css`
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  box-sizing: border-box;
  width: 30px;
  height: 30px;
  padding: 3px 2px;
`;

const bar = css`
  display: block;
  height: 5px;
  border-radius: 1px;
`;

function barFill(color: string, gradient: boolean): string {
  return gradient ? `linear-gradient(to right, ${color}, ${color}22)` : color;
}

export interface DataBarGalleryProps {
  onSelect: (color: string, gradientFill: boolean) => void;
  onMoreRules: () => void;
  onClose: () => void;
}

const GROUPS: Array<{ label: string; gradient: boolean; slug: string }> = [
  { label: "Gradient Fill", gradient: true, slug: "gradient" },
  { label: "Solid Fill", gradient: false, slug: "solid" },
];

export function DataBarGallery({
  onSelect,
  onMoreRules,
  onClose,
}: DataBarGalleryProps): React.ReactElement {
  return (
    <div className={galleryRoot} data-testid="cf-gallery-dataBars" onKeyDown={handleGalleryKeyDown}>
      {GROUPS.map((group) => (
        <div key={group.slug} role="group" aria-label={group.label}>
          <div className={groupHeading} aria-hidden>
            {group.label}
          </div>
          <div
            className={optionGrid}
            style={{ gridTemplateColumns: `repeat(${COLUMNS}, auto)` }}
            {...{ [COLUMNS_ATTR]: COLUMNS }}
          >
            {PRESET_DATA_BARS.map((preset, idx) => (
              <button
                key={`${group.slug}-${preset.color}`}
                type="button"
                className={optionButton}
                title={`${group.label}: ${preset.name}`}
                aria-label={preset.name}
                data-testid={`cf-dataBar-${group.slug}-${idx}`}
                {...{ [OPTION_ATTR]: "" }}
                onClick={() => {
                  onSelect(preset.color, group.gradient);
                  onClose();
                }}
              >
                <span className={preview} data-colour-data="">
                  {BAR_LENGTHS.map((length) => (
                    <span
                      key={length}
                      className={bar}
                      style={{ width: `${length}%`, background: barFill(preset.color, group.gradient) }}
                    />
                  ))}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className={footerRule} role="separator" />
      <button
        type="button"
        className={moreRulesRow}
        data-testid="cf-dataBars-moreRules"
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
