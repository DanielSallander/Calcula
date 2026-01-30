import styled from 'styled-components';

const v = (name: string) => `var(${name})`;

export const Container = styled.div`
  display: flex;
  align-items: center;
  height: 26px;
  background-color: ${v('--sheet-tabs-bg')};
  border-top: 1px solid ${v('--sheet-tabs-border')};
  user-select: none;
  font-size: 12px;
  position: relative;
`;

export const NavArea = styled.div`
  display: flex;
  align-items: center;
  padding: 0 4px;
  border-right: 1px solid ${v('--sheet-tabs-border')};
`;

export const NavButton = styled.button`
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background-color: transparent;
  color: ${v('--text-secondary')};
  cursor: pointer;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

export const TabsArea = styled.div`
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  overflow: hidden;
  padding: 0 4px;
`;

interface TabProps {
  $isActive?: boolean;
  $isFormulaSource?: boolean;
  $isFormulaTarget?: boolean;
}

export const Tab = styled.button<TabProps>`
  padding: 4px 12px;
  border: 1px solid ${v('--sheet-tab-border')};
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  background-color: ${props => 
    props.$isFormulaSource 
      ? v('--sheet-tab-formula-source-bg')
      : props.$isFormulaTarget
      ? v('--sheet-tab-formula-target-bg')
      : props.$isActive
      ? v('--sheet-tab-active-bg')
      : v('--sheet-tab-bg')
  };
  border-color: ${props =>
    props.$isFormulaSource
      ? v('--sheet-tab-formula-source-border')
      : props.$isFormulaTarget
      ? v('--sheet-tab-formula-target-border')
      : v('--sheet-tab-border')
  };
  color: ${v('--text-primary')};
  cursor: pointer;
  font-size: 11px;
  margin-right: 2px;
  white-space: nowrap;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  
  ${props => props.$isActive && `
    border-bottom: 1px solid ${v('--sheet-tab-active-bg')};
    margin-bottom: -1px;
    font-weight: 500;
  `}
`;

export const SourceIndicator = styled.span`
  color: ${v('--sheet-tab-formula-source-border')};
  font-weight: bold;
`;

interface AddButtonProps {
  $disabled?: boolean;
}

export const AddButton = styled.button<AddButtonProps>`
  width: 22px;
  height: 20px;
  padding: 0;
  border: 1px solid ${v('--sheet-tab-border')};
  border-radius: 4px;
  background-color: ${v('--sheet-tab-bg')};
  color: ${v('--text-secondary')};
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: 4px;

  ${props => props.$disabled && `
    opacity: 0.5;
    cursor: not-allowed;
  `}
`;

export const ScrollArea = styled.div`
  flex: 1;
  min-width: 50px;
`;

export const LoadingText = styled.span`
  color: ${v('--text-tertiary')};
  font-style: italic;
  padding: 0 8px;
`;

export const ErrorText = styled.span`
  color: ${v('--text-error')};
  font-style: italic;
  padding: 0 8px;
  cursor: help;
`;

export const FormulaModeIndicator = styled.div`
  padding: 0 8px;
  color: ${v('--sheet-tab-formula-indicator-text')};
  font-size: 11px;
  font-style: italic;
  background-color: ${v('--sheet-tab-formula-indicator-bg')};
  border-radius: 3px;
  margin-left: 4px;
`;

interface ContextMenuProps {
  $x: number;
  $y: number;
}

export const ContextMenu = styled.div<ContextMenuProps>`
  position: fixed;
  left: ${props => props.$x}px;
  top: ${props => props.$y}px;
  background-color: ${v('--ctx-menu-bg')};
  border: 1px solid ${v('--ctx-menu-border')};
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  padding: 4px 0;
  min-width: 150px;
  z-index: 10000;
`;

interface ContextMenuItemProps {
  $disabled?: boolean;
}

export const ContextMenuItem = styled.button<ContextMenuItemProps>`
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background-color: transparent;
  cursor: pointer;
  font-size: 12px;
  color: ${props => props.$disabled ? v('--text-disabled') : v('--text-primary')};
  text-align: left;

  ${props => props.$disabled && `
    cursor: default;
  `}

  &:hover:not(:disabled) {
    background-color: ${v('--ctx-menu-item-hover-bg')};
  }
`;

export const ContextMenuIcon = styled.span`
  margin-right: 8px;
  width: 16px;
`;

export const ContextMenuSeparator = styled.div`
  height: 1px;
  background-color: ${v('--ctx-menu-separator')};
  margin: 4px 0;
`;