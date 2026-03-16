//! FILENAME: app/extensions/ConditionalFormatting/components/ColorScaleGallery.tsx
// PURPOSE: Visual gallery of color scale presets for the Conditional Formatting menu.
// CONTEXT: Replaces text labels with gradient swatches, similar to Excel.

import React from "react";
import styled from "styled-components";
import type { PresetColorScale } from "../types";
import { PRESET_COLOR_SCALES } from "../types";

const v = (name: string) => `var(${name})`;

// ============================================================================
// Styles
// ============================================================================

const GalleryContainer = styled.div`
  padding: 6px 8px;
  width: 200px;
`;

const SwatchGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
`;

const SwatchButton = styled.button`
  display: block;
  width: 44px;
  height: 28px;
  border: 1px solid ${v("--menu-border")};
  border-radius: 2px;
  cursor: pointer;
  padding: 0;

  &:hover {
    border-color: ${v("--menu-text")};
    box-shadow: 0 0 0 1px ${v("--menu-text")};
  }
`;

const MoreRulesButton = styled.button`
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 5px 8px;
  background: transparent;
  border: none;
  color: ${v("--menu-text")};
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  border-radius: 3px;

  &:hover {
    background-color: ${v("--menu-item-hover-bg")};
  }
`;

// ============================================================================
// Helpers
// ============================================================================

function buildGradient(preset: PresetColorScale): string {
  if (preset.midColor) {
    return `linear-gradient(to right, ${preset.minColor}, ${preset.midColor}, ${preset.maxColor})`;
  }
  return `linear-gradient(to right, ${preset.minColor}, ${preset.maxColor})`;
}

// ============================================================================
// Component
// ============================================================================

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
    <GalleryContainer>
      <SwatchGrid>
        {PRESET_COLOR_SCALES.map((preset, idx) => (
          <SwatchButton
            key={idx}
            title={preset.label}
            style={{ background: buildGradient(preset) }}
            onClick={() => {
              onSelect(preset);
              onClose();
            }}
          />
        ))}
      </SwatchGrid>
      <MoreRulesButton
        onClick={() => {
          onMoreRules();
          onClose();
        }}
      >
        More Rules...
      </MoreRulesButton>
    </GalleryContainer>
  );
}
