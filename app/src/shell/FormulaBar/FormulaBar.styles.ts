//! FILENAME: app/src/shell/FormulaBar/FormulaBar.styles.ts
import styled from 'styled-components';
import { FORMULA_BAR_COLLAPSED_EDITOR_HEIGHT } from '../../core/types';

const v = (name: string) => `var(${name})`;

interface FormulaBarContainerProps {
  $expanded: boolean;
  /** Total bar height in px, chrome included — computed by FormulaBar. */
  $height: number;
}

export const FormulaBarContainer = styled.div<FormulaBarContainerProps>`
  /* The resize grip is positioned against this box's bottom edge. */
  position: relative;
  display: flex;
  /* Expanded, the Name Box and the buttons stay level with the FIRST line of
     the formula instead of floating down the middle of a 400px bar. */
  align-items: ${props => (props.$expanded ? 'flex-start' : 'center')};
  /* Layout stacks this bar and the grid in one flex column, so the bar's own
     height is what pushes the grid down. Never let it be the item that gets
     compressed: the expanded bar exists to be taller than its content-driven
     size, and flex would happily take that back. */
  flex: 0 0 auto;
  height: ${props => props.$height}px;
  border-bottom: 1px solid ${v('--formula-bar-border')};
  background-color: ${v('--formula-bar-bg')};
  padding: ${props => (props.$expanded ? '3px 4px' : '0 4px')};
  gap: 2px;
`;

interface ButtonGroupProps {
  $expanded: boolean;
}

export const ButtonGroup = styled.div<ButtonGroupProps>`
  display: flex;
  align-items: center;
  border-left: 1px solid ${v('--formula-bar-button-border')};
  border-right: 1px solid ${v('--formula-bar-button-border')};
  /* 100% of an expanded bar is a pair of separator rules running the whole way
     down beside the formula; pinned to one line, they frame the buttons the way
     they do collapsed. */
  height: ${props => (props.$expanded ? `${FORMULA_BAR_COLLAPSED_EDITOR_HEIGHT}px` : '100%')};
  padding: 0 2px;
  gap: 1px;
`;

interface IconButtonProps {
  disabled?: boolean;
  $variant?: 'cancel' | 'enter' | 'function' | 'expand';
}

export const IconButton = styled.button<IconButtonProps>`
  width: 24px;
  height: 24px;
  border: none;
  background-color: transparent;
  cursor: ${props => props.disabled ? 'default' : 'pointer'};
  display: flex;
  align-items: center;
  justify-content: center;
  color: ${props => {
    if (props.disabled) return v('--formula-bar-button-disabled');
    if (props.$variant === 'cancel') return v('--formula-bar-cancel-color');
    if (props.$variant === 'enter') return v('--formula-bar-enter-color');
    // 'expand' shares the fx button's palette: the theme carries no chevron
    // token, and the two are the same kind of neutral affordance.
    return v('--formula-bar-function-color');
  }};
  border-radius: 2px;
  opacity: ${props => props.disabled ? 0.5 : 1};

  &:hover:not(:disabled) {
    background-color: ${props => {
      if (props.$variant === 'cancel') return v('--formula-bar-cancel-hover-bg');
      if (props.$variant === 'enter') return v('--formula-bar-enter-hover-bg');
      return v('--formula-bar-function-hover-bg');
    }};
  }
`;

/**
 * The bar's bottom edge, as a drag target.
 *
 * Excel resizes the formula bar by dragging this edge, so the target spans the
 * full width. It is 4px rather than the border's 1px because a 1px strip is not
 * a thing a mouse can be asked to hit, and it sits INSIDE the bar rather than
 * straddling the border: 2px of overhang would sit on top of the column headers
 * and swallow clicks meant for the grid.
 */
export const ResizeGrip = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 4px;
  cursor: row-resize;
`;

export const InsertFunctionIconSpan = styled.span`
  font-size: 14px;
  font-style: italic;
  font-family: Times New Roman, Georgia, serif;
  font-weight: normal;
  line-height: 1;
`;
