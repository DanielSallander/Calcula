//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.styles.ts
import styled from 'styled-components';

// Helper to keep syntax clean and consistent
const v = (name: string) => `var(${name})`;

export interface EditorInputProps {
  $x: number;
  $y: number;
  $width: number;
  /** Expanded height: one row, plus one line per Alt+Enter break. */
  $height: number;
  /**
   * Height of a SINGLE line, i.e. the unexpanded cell's height less its border.
   * Kept separate from `$height` on purpose: line-height must stay per-line as
   * the box grows, or three lines would each try to fill the whole box.
   */
  $lineHeight: number;
  $zoom?: number;
}

/**
 * A <textarea>, not an <input>. HTML's value sanitization algorithm strips
 * CR/LF from <input type="text">, which did not merely render an Alt+Enter
 * entry on one line — it destroyed the newline as soon as the next character
 * was typed, because the change handler reads back the sanitized value.
 */
export const EditorTextArea = styled.textarea<EditorInputProps>`
  position: absolute;
  left: ${(p) => p.$x}px;
  top: ${(p) => p.$y}px;
  width: ${(p) => p.$width}px;
  height: ${(p) => p.$height}px;

  /* Layout & Spacing */
  padding: 0 ${(p) => 4 * (p.$zoom ?? 1)}px;
  margin: 0;
  box-sizing: border-box;

  /* The entry is laid out exactly as it will be stored: hard breaks only, never
     a soft wrap. The expansion geometry measures the widest line on that
     assumption, and a soft wrap would silently disagree with it. */
  white-space: pre;
  overflow: auto;
  /* Chromium puts a drag handle on every textarea; this one is positioned by
     the grid, so the handle would only offer to break that. */
  resize: none;

  /* Typography — mirror the canvas cell font (Excel: Calibri 11pt => 14.667px)
     so text does not shift/resize when the user starts editing a cell. */
  font-family: ${v('--font-family-cell')};
  font-size: calc(${v('--font-size-cell')} * ${(p) => p.$zoom ?? 1});
  line-height: ${(p) => p.$lineHeight}px;

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