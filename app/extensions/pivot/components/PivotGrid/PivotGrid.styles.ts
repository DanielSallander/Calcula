//! FILENAME: app/extensions/pivot/components/PivotGrid/PivotGrid.styles.ts
// PURPOSE: Styled components for the PivotGrid canvas component
// CONTEXT: Provides styles for the pivot table grid with frozen panes and scrollbars

import styled from "styled-components";

const v = (name: string) => `var(${name})`;

export const PivotGridContainer = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: ${v("--grid-bg")};
`;

export const GridArea = styled.div`
  position: relative;
  flex: 1;
  overflow: hidden;
`;

export const StyledCanvas = styled.canvas`
  display: block;
  position: absolute;
  top: 0;
  left: 0;
`;

export const ScrollbarArea = styled.div`
  position: absolute;
  right: 0;
  bottom: 0;
`;

export const VerticalScrollbarContainer = styled.div`
  position: absolute;
  right: 0;
  top: 0;
  bottom: 14px;
  width: 14px;
`;

export const HorizontalScrollbarContainer = styled.div`
  position: absolute;
  left: 0;
  bottom: 0;
  right: 14px;
  height: 14px;
`;

export const ScrollbarCornerContainer = styled.div`
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  background-color: ${v("--scrollbar-track-bg")};
`;
