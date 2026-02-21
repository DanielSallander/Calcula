//! FILENAME: app/src/shell/FormulaBar/NameBox.styles.ts
import styled from 'styled-components';

const v = (name: string) => `var(${name})`;

interface StyledNameBoxInputProps {
  $isEditing: boolean;
}

export const NameBoxWrapper = styled.div`
  position: relative;
  display: flex;
  align-items: center;
`;

export const StyledNameBoxInput = styled.input<StyledNameBoxInputProps>`
  width: 120px;
  height: 22px;
  border: 1px solid ${v('--namebox-border')};
  border-radius: 0;
  padding: 0 4px;
  font-size: 12px;
  font-family: system-ui, -apple-system, sans-serif;
  outline: none;
  background-color: ${props => props.$isEditing ? v('--namebox-bg-editing') : v('--namebox-bg')};
  color: ${v('--namebox-text')};
  caret-color: ${v('--namebox-text')};
  -webkit-text-fill-color: ${v('--namebox-text')};
  text-align: left;
`;

export const DropdownArrow = styled.button`
  width: 16px;
  height: 22px;
  border: 1px solid ${v('--namebox-border')};
  border-left: none;
  background: ${v('--namebox-bg')};
  color: ${v('--namebox-text')};
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-size: 8px;
  line-height: 1;

  &:hover {
    background: ${v('--namebox-bg-editing')};
  }
`;

export const DropdownContainer = styled.div`
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 200px;
  max-height: 300px;
  overflow-y: auto;
  background: ${v('--namebox-bg')};
  border: 1px solid ${v('--namebox-border')};
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  z-index: 1000;
`;

export const DropdownItem = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 12px;
  font-family: system-ui, -apple-system, sans-serif;
  color: ${v('--namebox-text')};
  gap: 12px;

  &:hover {
    background: ${v('--namebox-bg-editing')};
  }
`;

export const DropdownItemName = styled.span`
  font-weight: 600;
  white-space: nowrap;
`;

export const DropdownItemRef = styled.span`
  color: ${v('--namebox-text')};
  opacity: 0.6;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;
