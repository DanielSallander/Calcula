// FILENAME: app/src/core/components/Spreadsheet/Spreadsheet.styles.ts
// PURPOSE: Styled components for the Spreadsheet shell
// CONTEXT: Handles the layout of the grid, scrollbars, and formula bar integration

import styled from "styled-components";

// Helper for CSS variables
const v = (name: string) => `var(${name})`;

export const SpreadsheetContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  outline: none;
  background-color: ${v('--spreadsheet-bg')};
  color: ${v('--text-primary')};

  /* Ensure focus ring is handled by semantic tokens or suppressed if custom */
  &:focus {
    outline: none;
  }
`;

export const GridArea = styled.div`
  flex: 1;
  position: relative;
  overflow: hidden;
  background-color: ${v('--grid-area-bg')};
`;

interface CanvasLayerProps {
  $scrollbarSize: number;
}

export const CanvasLayer = styled.div<CanvasLayerProps>`
  position: absolute;
  top: 0;
  left: 0;
  right: ${(props) => props.$scrollbarSize}px;
  bottom: ${(props) => props.$scrollbarSize}px;
  overflow: hidden;
  background-color: ${v('--canvas-bg')};
  z-index: 1; /* Ensure canvas sits below floating UI if needed */
`;