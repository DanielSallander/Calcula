import styled, { css } from 'styled-components';

const v = (name: string) => `var(${name})`;

export const MenuContainer = styled.div`
  position: fixed;
  background-color: ${v('--ctx-menu-bg')};
  border: 1px solid ${v('--ctx-menu-border')};
  border-radius: 4px;
  box-shadow: ${v('--ctx-menu-shadow')};
  padding: 4px 0;
  min-width: 180px;
  max-width: 280px;
  z-index: ${v('--z-context-menu')};
  
  /* Prevent browser default context menu on the custom menu itself */
  user-select: none;
`;

export const MenuItem = styled.button<{ disabled?: boolean }>`
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background-color: transparent;
  cursor: pointer;
  font-size: 12px;
  color: ${v('--text-primary')};
  text-align: left;
  gap: 8px;
  outline: none;

  ${(props) =>
    props.disabled
      ? css`
          color: ${v('--text-disabled')};
          cursor: default;
        `
      : css`
          &:hover, &:focus {
            background-color: ${v('--ctx-menu-item-hover-bg')};
          }
        `}
`;

export const IconWrapper = styled.span`
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: inherit;
`;

export const Label = styled.span`
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

export const Shortcut = styled.span`
  color: ${v('--text-secondary')};
  font-size: 11px;
  margin-left: auto;
  padding-left: 16px;
`;

export const Separator = styled.div`
  height: 1px;
  background-color: ${v('--ctx-menu-separator')};
  margin: 4px 0;
`;