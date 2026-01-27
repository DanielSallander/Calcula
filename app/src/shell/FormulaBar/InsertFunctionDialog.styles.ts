//! FILENAME: app/src/shell/FormulaBar/InsertFunctionDialog.styles.ts
import styled from 'styled-components';

const v = (name: string) => `var(${name})`;

export const Overlay = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: ${v('--dialog-overlay-bg')};
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`;

export const DialogContainer = styled.div`
  background-color: ${v('--dialog-bg')};
  border-radius: 4px;
  box-shadow: 0 4px 20px ${v('--dialog-shadow')};
  width: 500px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

export const Header = styled.div`
  padding: 16px;
  border-bottom: 1px solid ${v('--dialog-border')};
  display: flex;
  justify-content: space-between;
  align-items: center;
`;

export const Title = styled.h2`
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: ${v('--dialog-title-text')};
`;

export const CloseButton = styled.button`
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 18px;
  color: ${v('--dialog-close-button')};
  padding: 4px;

  &:hover {
    color: ${v('--dialog-close-button-hover')};
  }
`;

export const SearchContainer = styled.div`
  padding: 12px 16px;
  border-bottom: 1px solid ${v('--dialog-border')};
`;

export const SearchInput = styled.input`
  width: 100%;
  padding: 8px 12px;
  border: 1px solid ${v('--dialog-input-border')};
  border-radius: 4px;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  background-color: ${v('--dialog-input-bg')};
  color: ${v('--dialog-input-text')};

  &:focus {
    border-color: ${v('--dialog-input-border-focus')};
  }
`;

export const CategoryContainer = styled.div`
  padding: 8px 16px;
  border-bottom: 1px solid ${v('--dialog-border')};
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
`;

interface CategoryButtonProps {
  isActive: boolean;
}

export const CategoryButton = styled.button<CategoryButtonProps>`
  padding: 4px 8px;
  font-size: 11px;
  border: 1px solid ${v('--dialog-category-border')};
  border-radius: 3px;
  background-color: ${props => props.isActive ? v('--dialog-category-active-bg') : v('--dialog-category-bg')};
  color: ${props => props.isActive ? v('--dialog-category-active-text') : v('--dialog-category-text')};
  cursor: pointer;

  &:hover {
    background-color: ${props => props.isActive ? v('--dialog-category-active-bg') : v('--dialog-category-hover-bg')};
  }
`;

export const FunctionListContainer = styled.div`
  flex: 1;
  overflow: auto;
  min-height: 200px;
  max-height: 300px;
`;

export const LoadingMessage = styled.div`
  padding: 20px;
  text-align: center;
  color: ${v('--dialog-loading-text')};
`;

export const EmptyMessage = styled.div`
  padding: 20px;
  text-align: center;
  color: ${v('--dialog-empty-text')};
`;

interface FunctionItemProps {
  isSelected: boolean;
}

export const FunctionItem = styled.div<FunctionItemProps>`
  padding: 8px 16px;
  cursor: pointer;
  background-color: ${props => props.isSelected ? v('--dialog-function-selected-bg') : 'transparent'};
  border-left: 3px solid ${props => props.isSelected ? v('--dialog-function-selected-border') : 'transparent'};

  &:hover {
    background-color: ${v('--dialog-function-hover-bg')};
  }
`;

export const FunctionName = styled.div`
  font-weight: 500;
  font-size: 13px;
  color: ${v('--dialog-function-name')};
`;

export const FunctionDescription = styled.div`
  font-size: 11px;
  color: ${v('--dialog-function-description')};
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

export const FunctionDetails = styled.div`
  padding: 12px 16px;
  border-top: 1px solid ${v('--dialog-border')};
  background-color: ${v('--dialog-details-bg')};
`;

export const FunctionSignature = styled.div`
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
  color: ${v('--dialog-function-signature')};
`;

export const FunctionFullDescription = styled.div`
  font-size: 12px;
  color: ${v('--dialog-function-full-description')};
`;

export const Footer = styled.div`
  padding: 12px 16px;
  border-top: 1px solid ${v('--dialog-border')};
  display: flex;
  justify-content: flex-end;
  gap: 8px;
`;

export const CancelButton = styled.button`
  padding: 6px 16px;
  border: 1px solid ${v('--dialog-button-border')};
  border-radius: 4px;
  background-color: ${v('--dialog-button-bg')};
  color: ${v('--dialog-button-text')};
  cursor: pointer;
  font-size: 13px;

  &:hover {
    background-color: ${v('--dialog-button-hover-bg')};
  }
`;

interface InsertButtonProps {
  disabled: boolean;
}

export const InsertButton = styled.button<InsertButtonProps>`
  padding: 6px 16px;
  border: none;
  border-radius: 4px;
  background-color: ${props => props.disabled ? v('--dialog-insert-disabled-bg') : v('--dialog-insert-bg')};
  color: ${v('--dialog-insert-text')};
  cursor: ${props => props.disabled ? 'default' : 'pointer'};
  font-size: 13px;

  &:hover:not(:disabled) {
    background-color: ${v('--dialog-insert-hover-bg')};
  }
`;