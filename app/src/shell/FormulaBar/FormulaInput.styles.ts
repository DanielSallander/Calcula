//! FILENAME: app/src/shell/FormulaBar/FormulaInput.styles.ts
import styled, { css } from 'styled-components';
import { FORMULA_BAR_COLLAPSED_EDITOR_HEIGHT } from '../../core/types';

const v = (name: string) => `var(${name})`;

interface StyledInputProps {
  $isFocused: boolean;
  $isSpillRef?: boolean;
}

/**
 * Everything the one-line <input> and the expanded <textarea> must agree on.
 * Swapping the element at the chevron must not move a single character: same
 * font, same padding, same border, same colours — only the height and the
 * wrapping change.
 */
const editorSurface = css<StyledInputProps>`
  flex: 1;
  border: 1px solid ${v('--formula-input-border')};
  border-radius: 0;
  font-size: 12px;
  font-family: Consolas, 'Courier New', monospace;
  outline: none;
  background-color: ${props => props.$isFocused ? v('--formula-input-bg-focused') : v('--formula-input-bg')};
  color: ${props => props.$isSpillRef ? v('--text-tertiary') : v('--formula-input-text')};
`;

export const StyledInput = styled.input<StyledInputProps>`
  ${editorSurface}
  height: ${FORMULA_BAR_COLLAPSED_EDITOR_HEIGHT}px;
  padding: 0 4px;
`;

interface StyledTextAreaProps extends StyledInputProps {
  /** Editor height in px — the value the user dragged the bar's edge to. */
  $height: number;
}

export const StyledTextArea = styled.textarea<StyledTextAreaProps>`
  ${editorSurface}
  height: ${props => props.$height}px;
  /* 3px of lead-in keeps the first line where the collapsed input's single line
     sat, so expanding does not make the text jump. */
  padding: 3px 4px;
  line-height: 16px;

  /* The expanded bar WRAPS rather than scrolling sideways — that is the whole
     point of expanding it — and pre-wrap is what wraps while still honouring
     the hard breaks Alt+Enter puts in the buffer. overflow-wrap: anywhere is
     for formulas: a nested =IF(SUMIFS(...)...) has no spaces to break at. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;

  /* Vertical only. The height is the user's choice, not the content's, so an
     entry taller than the bar has to scroll somewhere; sideways it must never
     go, or wrapping would have bought nothing. */
  overflow-x: hidden;
  overflow-y: auto;

  /* Chromium's own corner grip would resize the textarea out of the bar it is
     laid out in, and it competes with the bar's bottom-edge drag for the same
     few pixels. */
  resize: none;
`;
