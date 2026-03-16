//! FILENAME: app/extensions/ConditionalFormatting/components/DataBarGallery.tsx
// PURPOSE: Visual gallery of data bar presets for the Conditional Formatting menu.
// CONTEXT: Shows gradient and solid fill data bar swatches, similar to Excel.

import React from "react";
import styled from "styled-components";
import { PRESET_DATA_BAR_COLORS } from "../types";

const v = (name: string) => `var(${name})`;

// ============================================================================
// Styles
// ============================================================================

const GalleryContainer = styled.div`
  padding: 6px 8px;
  width: 200px;
`;

const SectionHeader = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: ${v("--menu-shortcut-text")};
  padding: 4px 2px 4px;

  &:first-child {
    padding-top: 0;
  }
`;

const SwatchGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
  margin-bottom: 4px;
`;

const SwatchButton = styled.button`
  display: flex;
  align-items: flex-end;
  width: 28px;
  height: 28px;
  border: 1px solid ${v("--menu-border")};
  border-radius: 2px;
  cursor: pointer;
  padding: 2px;
  background: ${v("--menu-dropdown-bg")};

  &:hover {
    border-color: ${v("--menu-text")};
    box-shadow: 0 0 0 1px ${v("--menu-text")};
  }
`;

const BarPreview = styled.div<{ $color: string; $gradient: boolean }>`
  width: 100%;
  height: 60%;
  border-radius: 1px;
  background: ${({ $color, $gradient }) =>
    $gradient
      ? `linear-gradient(to right, ${$color}, ${$color}00)`
      : $color};
`;

const MoreRulesButton = styled.button`
  display: block;
  width: 100%;
  margin-top: 4px;
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
// Component
// ============================================================================

export interface DataBarGalleryProps {
  onSelect: (color: string, gradientFill: boolean) => void;
  onMoreRules: () => void;
  onClose: () => void;
}

export function DataBarGallery({
  onSelect,
  onMoreRules,
  onClose,
}: DataBarGalleryProps): React.ReactElement {
  return (
    <GalleryContainer>
      <SectionHeader>Gradient Fill</SectionHeader>
      <SwatchGrid>
        {PRESET_DATA_BAR_COLORS.map((color, idx) => (
          <SwatchButton
            key={`grad-${idx}`}
            title={`Gradient ${color}`}
            onClick={() => { onSelect(color, true); onClose(); }}
          >
            <BarPreview $color={color} $gradient={true} />
          </SwatchButton>
        ))}
      </SwatchGrid>
      <SectionHeader>Solid Fill</SectionHeader>
      <SwatchGrid>
        {PRESET_DATA_BAR_COLORS.map((color, idx) => (
          <SwatchButton
            key={`solid-${idx}`}
            title={`Solid ${color}`}
            onClick={() => { onSelect(color, false); onClose(); }}
          >
            <BarPreview $color={color} $gradient={false} />
          </SwatchButton>
        ))}
      </SwatchGrid>
      <MoreRulesButton
        onClick={() => { onMoreRules(); onClose(); }}
      >
        More Rules...
      </MoreRulesButton>
    </GalleryContainer>
  );
}
