//! FILENAME: app/src/core/components/InlineEditor/InlineEditor.styles.ts
import styled from 'styled-components';
import { EDITOR_BORDER_PX, EDITOR_PADDING_X_PX } from './expansion';

// Helper to keep syntax clean and consistent
const v = (name: string) => `var(${name})`;

export interface EditorInputProps {
  $x: number;
  $y: number;
  $width: number;
  /** Box height in DEVICE px: measured from real layout once the entry has been
   *  laid out, so it already accounts for every soft wrap. */
  $height: number;
  /**
   * Height of a SINGLE line, device px — the unexpanded cell's height less its
   * border. Kept separate from `$height` on purpose: line-height must stay
   * per-line as the box grows, or three lines would each try to fill the whole
   * box. It is also what makes the measured and counted height paths agree
   * exactly (see expansion.ts).
   */
  $lineHeight: number;
  $zoom?: number;
}

/**
 * A <textarea>, not an <input>. HTML's value sanitization algorithm strips
 * CR/LF from <input type="text">, which did not merely render an Alt+Enter
 * entry on one line — it destroyed the newline as soon as the next character
 * was typed, because the change handler reads back the sanitized value.
 *
 * The chrome numbers below are imported, not typed in. expansion.ts sizes the
 * box by adding this exact padding and border back on; two hand-kept copies of
 * "4" and "2px" would drift on the first restyle and the box would be wrong by
 * a few pixels in a way nothing would fail on.
 */
export const EditorTextArea = styled.textarea<EditorInputProps>`
  position: absolute;
  left: ${(p) => p.$x}px;
  top: ${(p) => p.$y}px;
  width: ${(p) => p.$width}px;
  height: ${(p) => p.$height}px;

  /* Layout & Spacing */
  padding: 0 ${(p) => EDITOR_PADDING_X_PX * (p.$zoom ?? 1)}px;
  margin: 0;
  box-sizing: border-box;

  /* Excel's in-cell editor wraps: out of horizontal room it takes another line
     and grows downward over the rows beneath, rather than scrolling the entry
     out of sight. pre-wrap (not plain pre) is what allows that while still
     honouring the hard breaks Alt+Enter puts in the buffer, and overflow-wrap
     anywhere is what lets it break a long unbroken token -- a formula has no
     spaces to break at, and a formula is the entry most likely to outgrow its
     column.
     The box's HEIGHT is measured from this layout rather than predicted, so the
     wrap the browser chooses is by definition the wrap the box is sized for. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;

  /* NEVER auto. A cell is ~64x20px, so a scrollbar is most of the box: an entry
     too long for its column drew a horizontal bar, that bar ate the 16px content
     height, and the vertical bar appeared too -- scrollbars painted over the
     user's half-typed value. Excel shows none, ever; it wraps instead, which is
     what the rule above now does.
     hidden is not "cannot scroll": the box stays programmatically scrollable, so
     Chromium goes on carrying the caret into view in the one case wrapping
     cannot solve -- an entry so long it outgrows the grid itself. */
  overflow: hidden;
  /* Chromium puts a drag handle on every textarea; this one is positioned by
     the grid, so the handle would only offer to break that. */
  resize: none;

  /* Typography — mirror the canvas cell font (Excel: Calibri 11pt => 14.667px)
     so text does not shift/resize when the user starts editing a cell. */
  font-family: ${v('--font-family-cell')};
  font-size: calc(${v('--font-size-cell')} * ${(p) => p.$zoom ?? 1});
  line-height: ${(p) => p.$lineHeight}px;

  /* Appearance */
  border: ${EDITOR_BORDER_PX}px solid ${v('--accent-color')};
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
