//! FILENAME: app/extensions/Controls/Shape/ShapeGalleryOverlay.tsx
// PURPOSE: Gallery panel showing shape icons grouped by category.
// CONTEXT: Rendered as customContent inside the menu submenu flyout.

import React, { useCallback } from "react";
import { getShapeCategories, type ShapeDefinition } from "./shapeCatalog";
import { shapePathToSvgD } from "./shapePathToSvg";
import {
  GalleryContainer,
  CategoryHeader,
  ShapeGrid,
  ShapeCell,
} from "./ShapeGalleryOverlay.styles";

// ============================================================================
// Shape Thumbnail
// ============================================================================

function ShapeThumbnail({
  shape,
  onClick,
}: {
  shape: ShapeDefinition;
  onClick: () => void;
}): React.ReactElement {
  const d = shapePathToSvgD(shape.path);
  const isLine = shape.isLine === true;

  return (
    <ShapeCell onClick={onClick} title={shape.label}>
      <svg viewBox="-0.05 -0.05 1.1 1.1" preserveAspectRatio="xMidYMid meet">
        <path
          d={d}
          fill={isLine ? "none" : "var(--menu-item-hover-bg)"}
          stroke="var(--menu-text)"
          strokeWidth={0.04}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </ShapeCell>
  );
}

// ============================================================================
// Shape Gallery Panel
// ============================================================================

export interface ShapeGalleryPanelProps {
  insertShape: (shapeId: string) => void;
  onClose: () => void;
}

export function ShapeGalleryPanel({
  insertShape,
  onClose,
}: ShapeGalleryPanelProps): React.ReactElement {
  const categories = getShapeCategories();

  const handleShapeClick = useCallback(
    (shapeId: string) => {
      insertShape(shapeId);
      onClose();
    },
    [insertShape, onClose],
  );

  return (
    <GalleryContainer>
      {categories.map((category) => (
        <React.Fragment key={category.id}>
          <CategoryHeader>{category.label}</CategoryHeader>
          <ShapeGrid>
            {category.shapes.map((shape) => (
              <ShapeThumbnail
                key={shape.id}
                shape={shape}
                onClick={() => handleShapeClick(shape.id)}
              />
            ))}
          </ShapeGrid>
        </React.Fragment>
      ))}
    </GalleryContainer>
  );
}
