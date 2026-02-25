//! FILENAME: app/src/shell/Overlays/ContextMenu/ContextMenu.styles.ts
import styled, { css } from "styled-components";

const v = (name: string) => `var(${name})`;

export const MenuContainer = styled.div`
  position: fixed;
  background-color: ${v("--ctx-menu-bg")};
  border: 1px solid ${v("--ctx-menu-border")};
  border-radius: 4px;
  box-shadow: ${v("--ctx-menu-shadow")};
  padding: 4px 0;
  min-width: 180px;
  max-width: 280px;
  z-index: ${v("--z-context-menu")};

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
  color: ${v("--text-primary")};
  text-align: left;
  gap: 8px;
  outline: none;
  position: relative;

  ${(props) =>
    props.disabled
      ? css`
          color: ${v("--text-disabled")};
          cursor: default;
        `
      : css`
          &:hover,
          &:focus {
            background-color: ${v("--ctx-menu-item-hover-bg")};
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
  color: ${v("--text-secondary")};
  font-size: 11px;
  margin-left: auto;
  padding-left: 16px;
`;

export const SubMenuIndicator = styled.span`
  color: ${v("--text-secondary")};
  font-size: 10px;
  margin-left: auto;
  padding-left: 12px;
  line-height: 1;
`;

export const Separator = styled.div`
  height: 1px;
  background-color: ${v("--ctx-menu-separator")};
  margin: 4px 0;
`;

export const SearchInput = styled.input`
  display: block;
  width: calc(100% - 16px);
  margin: 4px 8px 4px 8px;
  padding: 5px 8px;
  border: 1px solid ${v("--ctx-menu-border")};
  border-radius: 3px;
  font-size: 12px;
  color: ${v("--text-primary")};
  background-color: ${v("--ctx-menu-bg")};
  outline: none;
  box-sizing: border-box;

  &:focus {
    border-color: #0078d4;
  }

  &::placeholder {
    color: ${v("--text-disabled")};
  }
`;
