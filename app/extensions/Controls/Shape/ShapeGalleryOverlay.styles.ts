//! FILENAME: app/extensions/Controls/Shape/ShapeGalleryOverlay.styles.ts
// PURPOSE: Styled-components for the shape gallery panel.
// CONTEXT: Rendered inside the menu SubMenuDropdown; no positioning needed.

import styled from "styled-components";

const v = (name: string) => `var(${name})`;

export const GalleryContainer = styled.div`
  width: 290px;
  max-height: 420px;
  overflow-y: auto;
  padding: 4px 8px;
`;

export const CategoryHeader = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: ${v("--menu-shortcut-text")};
  padding: 6px 4px 4px;
  border-bottom: 1px solid ${v("--menu-separator")};
  margin-bottom: 4px;
  margin-top: 4px;

  &:first-child {
    margin-top: 0;
  }
`;

export const ShapeGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
  margin-bottom: 4px;
`;

export const ShapeCell = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;

  &:hover {
    background-color: ${v("--menu-item-hover-bg")};
    border-color: ${v("--menu-border")};
  }

  svg {
    width: 100%;
    height: 100%;
  }
`;
