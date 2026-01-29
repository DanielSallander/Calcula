//! FILENAME: app/src/shell/MenuBar/MenuBar.styles.ts
// PURPOSE: Styled components for the MenuBar.
// CONTEXT: The Shell owns the "Pixels" (CSS), while Extensions own the "Data".
// Uses CSS Variables to allow Theme Extensions to control colors.

import styled, { css } from 'styled-components';

// Helper to access CSS variables injected by Theme Extensions
const v = (name: string) => `var(${name})`;

export const MenuBarContainer = styled.div`
  display: flex;
  align-items: center;
  height: 28px;
  background-color: ${v('--menu-bar-bg')};
  border-bottom: 1px solid ${v('--menu-bar-border')};
  padding: 0 8px;
  user-select: none;
`;

export const MenuContainer = styled.div`
  position: relative;
`;

interface MenuButtonProps {
  $isOpen?: boolean;
}

export const MenuButton = styled.button<MenuButtonProps>`
  background-color: transparent;
  border: none;
  color: ${v('--menu-text')};
  padding: 4px 8px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;

  /* Theme-aware hover states */
  &:hover {
    background-color: ${v('--menu-button-hover-bg')};
  }

  ${({ $isOpen }) =>
    $isOpen &&
    css`
      background-color: ${v('--menu-button-active-bg')};
      
      &:hover {
        background-color: ${v('--menu-button-active-bg')};
      }
    `}
`;

export const Dropdown = styled.div`
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 260px;
  background-color: ${v('--menu-dropdown-bg')};
  border: 1px solid ${v('--menu-border')};
  border-radius: 4px;
  padding: 4px 0;
  z-index: 1000;
  box-shadow: 0 4px 12px ${v('--menu-shadow')};
`;

interface MenuItemButtonProps {
  $disabled?: boolean;
}

export const MenuItemButton = styled.button<MenuItemButtonProps>`
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 6px 24px 6px 12px;
  background-color: transparent;
  border: none;
  color: ${v('--menu-text')};
  font-size: 13px;
  cursor: pointer;
  text-align: left;

  &:hover {
    background-color: ${v('--menu-item-hover-bg')};
  }

  ${({ $disabled }) =>
    $disabled &&
    css`
      color: ${v('--menu-text-disabled')};
      cursor: default;
      pointer-events: none;

      &:hover {
        background-color: transparent;
      }
    `}
`;

export const MenuItemContent = styled.span`
  display: flex;
  align-items: center;
  gap: 8px;
`;

export const Checkmark = styled.span`
  font-family: monospace;
  font-size: 11px;
  width: 24px;
`;

export const Shortcut = styled.span`
  color: ${v('--menu-shortcut-text')};
  font-size: 12px;
  margin-left: 24px;
`;

export const Separator = styled.div`
  height: 1px;
  background-color: ${v('--menu-separator')};
  margin: 4px 0;
`;