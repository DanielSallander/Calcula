//! FILENAME: app/extensions/ConditionalFormatting/components/IconSetGallery.tsx
// PURPOSE: Visual gallery of icon set presets for the Conditional Formatting menu.
// CONTEXT: Shows icon set previews grouped by category, similar to Excel.

import React, { useRef, useEffect } from "react";
import styled from "styled-components";
import type { IconSetType } from "@api";
import { drawIcon } from "../rendering/iconShapes";

const v = (name: string) => `var(${name})`;

// ============================================================================
// Icon Set Categories (matching Excel's grouping)
// ============================================================================

interface IconSetEntry {
  id: IconSetType;
  label: string;
  count: number; // number of icons in the set
}

interface IconSetCategory {
  label: string;
  sets: IconSetEntry[];
}

const ICON_SET_CATEGORIES: IconSetCategory[] = [
  {
    label: "Directional",
    sets: [
      { id: "threeArrows", label: "3 Arrows (Colored)", count: 3 },
      { id: "threeArrowsGray", label: "3 Arrows (Gray)", count: 3 },
      { id: "threeTriangles", label: "3 Triangles", count: 3 },
      { id: "fourArrows", label: "4 Arrows (Colored)", count: 4 },
      { id: "fourArrowsGray", label: "4 Arrows (Gray)", count: 4 },
      { id: "fiveArrows", label: "5 Arrows (Colored)", count: 5 },
      { id: "fiveArrowsGray", label: "5 Arrows (Gray)", count: 5 },
    ],
  },
  {
    label: "Shapes",
    sets: [
      { id: "threeTrafficLights1", label: "3 Traffic Lights", count: 3 },
      { id: "threeTrafficLights2", label: "3 Traffic Lights (Rimmed)", count: 3 },
      { id: "threeSigns", label: "3 Signs", count: 3 },
      { id: "fourTrafficLights", label: "4 Traffic Lights", count: 4 },
      { id: "fourRedToBlack", label: "4 Red to Black", count: 4 },
      { id: "fiveQuarters", label: "5 Quarters", count: 5 },
    ],
  },
  {
    label: "Indicators",
    sets: [
      { id: "threeSymbols", label: "3 Symbols (Circled)", count: 3 },
      { id: "threeSymbols2", label: "3 Symbols (Uncircled)", count: 3 },
      { id: "threeFlags", label: "3 Flags", count: 3 },
    ],
  },
  {
    label: "Ratings",
    sets: [
      { id: "threeStars", label: "3 Stars", count: 3 },
      { id: "fourRating", label: "4 Ratings", count: 4 },
      { id: "fiveRating", label: "5 Ratings", count: 5 },
      { id: "fiveBoxes", label: "5 Boxes", count: 5 },
    ],
  },
];

// ============================================================================
// Styles
// ============================================================================

const GalleryContainer = styled.div`
  padding: 6px 8px;
  width: 260px;
  max-height: 420px;
  overflow-y: auto;
`;

const SectionHeader = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: ${v("--menu-shortcut-text")};
  padding: 4px 2px 4px;
  border-bottom: 1px solid ${v("--menu-separator")};
  margin-bottom: 4px;
  margin-top: 4px;

  &:first-child {
    margin-top: 0;
  }
`;

const SetGrid = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
`;

const SetButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3px 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;

  &:hover {
    background-color: ${v("--menu-item-hover-bg")};
    border-color: ${v("--menu-border")};
  }
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
// Icon Set Preview (renders icons on a small canvas)
// ============================================================================

const ICON_SIZE = 14;
const ICON_GAP = 2;

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
    const ctx = canvas.getContext("2d");
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
    <canvas
      ref={canvasRef}
      style={{ width: `${width}px`, height: `${ICON_SIZE}px` }}
    />
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
    <GalleryContainer>
      {ICON_SET_CATEGORIES.map((category) => (
        <React.Fragment key={category.label}>
          <SectionHeader>{category.label}</SectionHeader>
          <SetGrid>
            {category.sets.map((entry) => (
              <SetButton
                key={entry.id}
                title={entry.label}
                onClick={() => { onSelect(entry.id, entry.count); onClose(); }}
              >
                <IconSetPreview iconSetId={entry.id} iconCount={entry.count} />
              </SetButton>
            ))}
          </SetGrid>
        </React.Fragment>
      ))}
      <MoreRulesButton
        onClick={() => { onMoreRules(); onClose(); }}
      >
        More Rules...
      </MoreRulesButton>
    </GalleryContainer>
  );
}
