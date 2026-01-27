//! FILENAME: app/src/shell/FormulaBar/FormulaBar.styles.ts
import styled from 'styled-components';

const v = (name: string) => `var(${name})`;

export const FormulaBarContainer = styled.div`
  display: flex;
  align-items: center;
  height: 28px;
  border-bottom: 1px solid ${v('--formula-bar-border')};
  background-color: ${v('--formula-bar-bg')};
  padding: 0 4px;
  gap: 2px;
`;

export const ButtonGroup = styled.div`
  display: flex;
  align-items: center;
  border-left: 1px solid ${v('--formula-bar-button-border')};
  border-right: 1px solid ${v('--formula-bar-button-border')};
  height: 100%;
  padding: 0 2px;
  gap: 1px;
`;

interface IconButtonProps {
  disabled?: boolean;
  variant?: 'cancel' | 'enter' | 'function';
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
    if (props.variant === 'cancel') return v('--formula-bar-cancel-color');
    if (props.variant === 'enter') return v('--formula-bar-enter-color');
    return v('--formula-bar-function-color');
  }};
  border-radius: 2px;
  opacity: ${props => props.disabled ? 0.5 : 1};

  &:hover:not(:disabled) {
    background-color: ${props => {
      if (props.variant === 'cancel') return v('--formula-bar-cancel-hover-bg');
      if (props.variant === 'enter') return v('--formula-bar-enter-hover-bg');
      return v('--formula-bar-function-hover-bg');
    }};
  }
`;

export const CancelIconSpan = styled.span`
  font-size: 16px;
  font-weight: bold;
  line-height: 1;
  font-family: Arial, sans-serif;
`;

export const EnterIconSpan = styled.span`
  font-size: 18px;
  font-weight: bold;
  line-height: 1;
  font-family: Arial, sans-serif;
`;

export const InsertFunctionIconSpan = styled.span`
  font-size: 14px;
  font-style: italic;
  font-family: Times New Roman, Georgia, serif;
  font-weight: normal;
  line-height: 1;
`;