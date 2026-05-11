//! FILENAME: app/src/shell/FormulaBar/FormulaInput.styles.ts
import styled from 'styled-components';

const v = (name: string) => `var(${name})`;

interface StyledInputProps {
  $isFocused: boolean;
  $isSpillRef?: boolean;
}

export const StyledInput = styled.input<StyledInputProps>`
  flex: 1;
  height: 22px;
  border: 1px solid ${v('--formula-input-border')};
  border-radius: 0;
  padding: 0 4px;
  font-size: 12px;
  font-family: Consolas, 'Courier New', monospace;
  outline: none;
  background-color: ${props => props.$isFocused ? v('--formula-input-bg-focused') : v('--formula-input-bg')};
  color: ${props => props.$isSpillRef ? '#888' : v('--formula-input-text')};
`;