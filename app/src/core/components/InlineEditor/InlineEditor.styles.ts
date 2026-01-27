//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.styles.ts
import styled from 'styled-components';

// Helper to keep syntax clean and consistent
const v = (name: string) => `var(${name})`;

export interface EditorInputProps {
  $x: number;
  $y: number;
  $width: number;
  $height: number;
}

export const EditorInput = styled.input<EditorInputProps>`
  position: absolute;
  left: ${(p) => p.$x}px;
  top: ${(p) => p.$y}px;
  width: ${(p) => p.$width}px;
  height: ${(p) => p.$height}px;
  
  /* Layout & Spacing */
  padding: 0 4px;
  margin: 0;
  box-sizing: border-box;
  
  /* Typography */
  font-family: ${v('--font-family-sans')};
  font-size: ${v('--font-size-cell')};
  line-height: calc(${(p) => p.$height}px - 4px);
  
  /* Appearance */
  border: 2px solid ${v('--accent-color')};
  border-radius: 0;
  outline: none;
  background-color: ${v('--bg-surface')};
  color: ${v('--text-primary')};
  z-index: ${v('--z-index-editor')};

  /* Disabled State */
  &:disabled {
    background-color: ${v('--bg-surface-disabled')};
    color: ${v('--text-disabled')};
    border-color: ${v('--border-disabled')};
  }
`;