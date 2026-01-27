//! FILENAME: app/src/core/components/Scrollbar/Scrollbar.styles.ts
import styled, { css } from 'styled-components';

// Helper for CSS variables
const v = (name: string) => `var(${name})`;

export interface ScrollbarTrackProps {
  $isHorizontal: boolean;
  $thickness: number;
}

export const Track = styled.div<ScrollbarTrackProps>`
  position: absolute;
  background-color: ${v('--scrollbar-track-bg')};
  user-select: none;
  z-index: 100; /* Ensure it sits above grid content */
  
  /* Borders based on orientation */
  border-left: ${({ $isHorizontal }) => 
    $isHorizontal ? 'none' : `1px solid ${v('--scrollbar-border-color')}`};
  border-top: ${({ $isHorizontal }) => 
    $isHorizontal ? `1px solid ${v('--scrollbar-border-color')}` : 'none'};

  /* Orientation specific geometry */
  ${({ $isHorizontal, $thickness }) =>
    $isHorizontal
      ? css`
          bottom: 0;
          left: 0;
          right: ${$thickness}px; /* Leave space for corner */
          height: ${$thickness}px;
          cursor: default;
        `
      : css`
          top: 0;
          right: 0;
          bottom: ${$thickness}px; /* Leave space for corner */
          width: ${$thickness}px;
          cursor: default;
        `}
`;

export interface ScrollbarThumbProps {
  $isHorizontal: boolean;
  $isDragging: boolean;
}

export const Thumb = styled.div<ScrollbarThumbProps>`
  position: absolute;
  box-sizing: border-box;
  border-radius: 0;
  cursor: default;
  
  /* The "padding" look inside the track */
  border: 1px solid ${v('--scrollbar-thumb-border-color')};

  /* Colors */
  background-color: ${({ $isDragging }) =>
    $isDragging ? v('--scrollbar-thumb-bg-active') : v('--scrollbar-thumb-bg-default')};

  /* Transitions */
  transition: ${({ $isDragging }) => ($isDragging ? 'none' : 'background-color 0.1s')};

  &:hover {
    background-color: ${({ $isDragging }) =>
      $isDragging ? v('--scrollbar-thumb-bg-active') : v('--scrollbar-thumb-bg-hover')};
  }

  /* Fixed cross-axis positioning */
  ${({ $isHorizontal }) =>
    $isHorizontal
      ? css`
          top: 1px;
        `
      : css`
          left: 1px;
        `}
`;

export const Corner = styled.div<{ $size: number }>`
  position: absolute;
  bottom: 0;
  right: 0;
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  
  background-color: ${v('--scrollbar-track-bg')};
  border-top: 1px solid ${v('--scrollbar-border-color')};
  border-left: 1px solid ${v('--scrollbar-border-color')};
  z-index: 101;
`;