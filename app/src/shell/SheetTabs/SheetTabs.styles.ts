//! FILENAME: app/src/shell/SheetTabs/SheetTabs.styles.ts
import styled from 'styled-components';

const v = (name: string) => `var(${name})`;

export const Container = styled.div`
  display: flex;
  align-items: center;
  height: 28px;
  flex: none;
  background-color: ${v('--sheet-tabs-bg')};
  border-top: 1px solid ${v('--sheet-tabs-border')};
  user-select: none;
  font-size: 12px;
  position: relative;
`;

export const NavArea = styled.div`
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 0 4px;
`;

export const NavButton = styled.button`
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background-color: transparent;
  color: ${v('--text-secondary')};
  cursor: pointer;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 80ms ease-out;

  &:hover:not(:disabled) {
    background-color: ${v('--sheet-tab-bg')};
    color: ${v('--text-primary')};
  }

  &:disabled {
    cursor: default;
    opacity: 0.3;
  }
`;

export const HiddenCount = styled.span`
  font-size: 10px;
  color: ${v('--text-tertiary')};
  padding: 0 4px;
  white-space: nowrap;
  flex-shrink: 0;
`;

export const TabsArea = styled.div`
  display: flex;
  align-items: stretch;
  align-self: stretch;
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0 2px;

  /* Hide scrollbar but keep scrollable */
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
`;

interface TabProps {
  $isActive?: boolean;
  $isGrouped?: boolean;
  $isFormulaSource?: boolean;
  $isFormulaTarget?: boolean;
  $tabColor?: string;
  /** Thin Excel-style divider on the left edge; hidden next to selected tabs. */
  $withSeparator?: boolean;
}

/** True when the tab renders "selected" (raised on the grid background). */
const isSelected = (p: TabProps) =>
  !!(p.$isActive || p.$isGrouped || p.$isFormulaSource || p.$isFormulaTarget);

/** Color of the 2px underline shown under selected tabs. */
const underlineColor = (p: TabProps) => {
  if (p.$isFormulaSource) return v('--sheet-tab-formula-source-border');
  if (p.$isFormulaTarget) return v('--sheet-tab-formula-target-border');
  if (p.$tabColor) return p.$tabColor;
  return v('--accent-primary');
};

export const Tab = styled.button<TabProps>`
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 100%;
  padding: 0 14px;
  border: none;
  background-color: ${props =>
    props.$isFormulaSource
      ? v('--sheet-tab-formula-source-bg')
      : props.$isFormulaTarget
      ? v('--sheet-tab-formula-target-bg')
      : isSelected(props)
      ? v('--sheet-tab-active-bg')
      : 'transparent'
  };
  color: ${props =>
    props.$isActive && !props.$tabColor
      ? v('--accent-primary')
      : isSelected(props)
      ? v('--text-primary')
      : v('--text-secondary')
  };
  font-weight: ${props => (props.$isActive ? 600 : 400)};
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background-color 80ms ease-out, color 80ms ease-out;

  /* Selected tabs sit on the grid background with a colored underline. */
  ${props => isSelected(props) && `
    box-shadow: inset 0 -2px 0 ${underlineColor(props)};
  `}

  &:hover {
    ${props => !isSelected(props) && `
      background-color: ${v('--sheet-tab-bg')};
      color: ${v('--text-primary')};
    `}
  }

  /* Excel-style thin divider between unselected neighbors. */
  ${props => props.$withSeparator && `
    &::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 1px;
      height: 14px;
      background-color: ${v('--sheet-tab-border')};
    }
  `}

  /* Colored-tab hint while the tab is not selected: a short bottom stripe. */
  ${props => props.$tabColor && !isSelected(props) && `
    &::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 6px;
      right: 6px;
      height: 3px;
      border-radius: 2px 2px 0 0;
      background-color: ${props.$tabColor};
    }
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
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background-color: transparent;
  color: ${v('--text-secondary')};
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: 5px;
  transition: background-color 80ms ease-out;

  &:hover:not(:disabled) {
    background-color: ${v('--sheet-tab-bg')};
    color: ${v('--text-primary')};
  }

  ${props => props.$disabled && `
    opacity: 0.4;
    cursor: not-allowed;
  `}
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
  bottom: ${props => window.innerHeight - props.$y}px;
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

// ---------------------------------------------------------------------------
// Drag indicator
// ---------------------------------------------------------------------------

export const DragIndicator = styled.div`
  position: fixed;
  width: 2px;
  background-color: ${v('--accent-primary')};
  z-index: 10000;
  pointer-events: none;
`;

// ---------------------------------------------------------------------------
// Unhide Dialog
// ---------------------------------------------------------------------------

export const DialogOverlay = styled.div`
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.4);
  z-index: 20000;
  display: flex;
  align-items: center;
  justify-content: center;
`;

export const DialogBox = styled.div`
  background-color: ${v('--ctx-menu-bg')};
  border: 1px solid ${v('--ctx-menu-border')};
  border-radius: 6px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  min-width: 260px;
  max-width: 360px;
  padding: 16px;
`;

export const DialogTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${v('--text-primary')};
  margin-bottom: 12px;
`;

export const DialogList = styled.div`
  max-height: 200px;
  overflow-y: auto;
  margin-bottom: 12px;
  border: 1px solid ${v('--ctx-menu-border')};
  border-radius: 4px;
`;

interface DialogListItemProps {
  $selected?: boolean;
}

export const DialogListItem = styled.div<DialogListItemProps>`
  padding: 6px 10px;
  font-size: 12px;
  color: ${v('--text-primary')};
  cursor: pointer;
  background-color: ${props => props.$selected ? v('--ctx-menu-item-hover-bg') : 'transparent'};

  &:hover {
    background-color: ${v('--ctx-menu-item-hover-bg')};
  }
`;

export const DialogButtons = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
`;

export const DialogButton = styled.button`
  padding: 4px 16px;
  border: 1px solid ${v('--ctx-menu-border')};
  border-radius: 4px;
  background-color: ${v('--sheet-tab-bg')};
  color: ${v('--text-primary')};
  font-size: 12px;
  cursor: pointer;

  &:hover {
    background-color: ${v('--ctx-menu-item-hover-bg')};
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

export const DialogButtonPrimary = styled(DialogButton)`
  background-color: ${v('--accent-primary')};
  border-color: ${v('--accent-primary')};
  color: #fff;

  &:hover:not(:disabled) {
    opacity: 0.9;
  }
`;