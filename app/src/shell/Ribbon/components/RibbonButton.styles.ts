import styled, { css } from 'styled-components';
import { THEME_TOKENS } from '../../../core/theme/tokens';

const v = (name: string) => `var(${name})`;

type RibbonButtonSize = 'small' | 'medium' | 'large';

interface StyledButtonProps {
  $active: boolean;
  $size: RibbonButtonSize;
}

const sizeStyles = {
  small: css`
    padding: 2px 6px;
    font-size: 11px;
  `,
  medium: css`
    padding: 4px 8px;
    font-size: 12px;
  `,
  large: css`
    padding: 6px 12px;
    font-size: 13px;
  `,
};

export const StyledButton = styled.button<StyledButtonProps>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px solid transparent;
  border-radius: 3px;
  background-color: ${({ $active }) => ($active ? v(THEME_TOKENS.RIBBON_BUTTON_ACTIVE_BG) : 'transparent')};
  color: ${v(THEME_TOKENS.TEXT_PRIMARY)};
  cursor: pointer;
  opacity: 1;
  ${({ $size }) => sizeStyles[$size]}

  &:disabled {
    color: ${v(THEME_TOKENS.TEXT_DISABLED)};
    cursor: not-allowed;
    opacity: 0.5;
  }

  &:hover:not(:disabled) {
    background-color: ${({ $active }) =>
      $active ? v(THEME_TOKENS.RIBBON_BUTTON_ACTIVE_BG) : v(THEME_TOKENS.RIBBON_BUTTON_HOVER_BG)};
    border-color: ${v(THEME_TOKENS.BORDER_DEFAULT)};
  }
`;

export const IconWrapper = styled.span`
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
`;