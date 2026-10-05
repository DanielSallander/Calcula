//! FILENAME: app/extensions/ConditionalFormatting/components/IconSetGallery.tsx
// PURPOSE: Conditional Formatting > Icon Sets: Excel's twenty sets in Excel's
//          four groups, then More Rules....
// CONTEXT: Hosted by the menu bar AND by the Home tab's Conditional Formatting
//          hero, so it paints its own @api/layout surface (galleryChrome.ts
//          says why). The icons are drawn with the SAME drawIcon the grid
//          overlay uses (rendering/iconShapes.ts), so a preview is exactly what
//          the cells will show; on the menu bar's old dark ground the black and
//          grey sets (Red To Black, the gray arrows) were barely visible.
//          Excel's layout: two sets per row. The groups and names are DATA in
//          ../types.ts (ICON_SET_CATEGORIES), read from live Excel.

import React, { useRef, useEffect } from "react";
import { css } from "@emotion/css";
import type { IconSetType } from "@api";
import { drawIcon } from "../rendering/iconShapes";
import { ICON_SET_CATEGORIES } from "../types";
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

const COLUMNS = 2;
const ICON_SIZE = 14;
const ICON_GAP = 2;
/** Every option is as wide as the widest (5-icon) preview, so the two columns align. */
const PREVIEW_WIDTH = 5 * (ICON_SIZE + ICON_GAP) - ICON_GAP;

const scroller = css`
  max-height: 420px;
  overflow-y: auto;
`;

const previewBox = css`
  display: flex;
  align-items: center;
  justify-content: flex-start;
  width: ${PREVIEW_WIDTH}px;
  height: ${ICON_SIZE}px;
`;

// ============================================================================
// Icon Set Preview (renders icons on a small canvas)
// ============================================================================

function IconSetPreview({
  iconSetId,
  iconCount,
}: {
  iconSetId: IconSetType;
  iconCount: number;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = iconCount * (ICON_SIZE + ICON_GAP) - ICON_GAP;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext?.("2d");
    if (!ctx) return;

    // Scale for high-DPI
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = ICON_SIZE * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, ICON_SIZE);

    // Draw icons left to right, highest index (best) first to match Excel order
    for (let i = 0; i < iconCount; i++) {
      const iconIndex = iconCount - 1 - i;
      const x = i * (ICON_SIZE + ICON_GAP);
      drawIcon(ctx, iconSetId, iconIndex, x, 0, ICON_SIZE);
    }
  }, [iconSetId, iconCount, width]);

  return (
    <span className={previewBox} data-colour-data="">
      <canvas ref={canvasRef} style={{ width: `${width}px`, height: `${ICON_SIZE}px` }} />
    </span>
  );
}

// ============================================================================
// Component
// ============================================================================

export interface IconSetGalleryProps {
  onSelect: (iconSetId: IconSetType, iconCount: number) => void;
  onMoreRules: () => void;
  onClose: () => void;
}

export function IconSetGallery({
  onSelect,
  onMoreRules,
  onClose,
}: IconSetGalleryProps): React.ReactElement {
  return (
    <div className={galleryRoot} data-testid="cf-gallery-iconSets" onKeyDown={handleGalleryKeyDown}>
      <div className={scroller}>
        {ICON_SET_CATEGORIES.map((category) => (
          <div key={category.label} role="group" aria-label={category.label}>
            <div className={groupHeading} aria-hidden>
              {category.label}
            </div>
            <div
              className={optionGrid}
              style={{ gridTemplateColumns: `repeat(${COLUMNS}, auto)` }}
              {...{ [COLUMNS_ATTR]: COLUMNS }}
            >
              {category.sets.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={optionButton}
                  title={entry.label}
                  aria-label={entry.label}
                  data-testid={`cf-iconSet-${entry.id}`}
                  {...{ [OPTION_ATTR]: "" }}
                  onClick={() => {
                    onSelect(entry.id, entry.count);
                    onClose();
                  }}
                >
                  <IconSetPreview iconSetId={entry.id} iconCount={entry.count} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className={footerRule} role="separator" />
      <button
        type="button"
        className={moreRulesRow}
        data-testid="cf-iconSets-moreRules"
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
