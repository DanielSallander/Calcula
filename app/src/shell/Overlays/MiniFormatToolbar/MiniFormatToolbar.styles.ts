//! FILENAME: app/src/shell/Overlays/MiniFormatToolbar/MiniFormatToolbar.styles.ts
// PURPOSE: Styled components for the Mini Format Toolbar overlay.
// CONTEXT: Appears above the grid context menu on right-click, similar to Excel.

import styled, { css } from "styled-components";

const v = (name: string) => `var(${name})`;

export const ToolbarContainer = styled.div`
  position: fixed;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 3px 4px;
  background-color: ${v("--ctx-menu-bg")};
  border: 1px solid ${v("--ctx-menu-border")};
  border-radius: 4px;
  box-shadow: ${v("--ctx-menu-shadow")};
  z-index: calc(${v("--z-context-menu")} + 1);
  user-select: none;
`;

/** Wrapper for a group of related buttons with a subtle separator */
export const ButtonGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 1px;

  & + & {
    margin-left: 2px;
    padding-left: 3px;
    border-left: 1px solid ${v("--ctx-menu-separator")};
  }
`;

export const ToolbarButton = styled.button<{
  $active?: boolean;
  disabled?: boolean;
}>`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: ${v("--text-primary")};
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  position: relative;
  flex-shrink: 0;

  ${(props) =>
    props.disabled
      ? css`
          color: ${v("--text-disabled")};
          cursor: default;
        `
      : css`
          &:hover {
            background-color: ${v("--ctx-menu-item-hover-bg")};
            border-color: ${v("--ctx-menu-border")};
          }
        `}

  ${(props) =>
    props.$active &&
    !props.disabled &&
    css`
      background-color: ${v("--ctx-menu-item-hover-bg")};
      border-color: ${v("--ctx-menu-border")};
    `}
`;

/** Small select for font family / font size */
export const MiniSelect = styled.select`
  height: 22px;
  padding: 0 2px;
  border: 1px solid ${v("--ctx-menu-border")};
  border-radius: 3px;
  background: ${v("--ctx-menu-bg")};
  color: ${v("--text-primary")};
  font-size: 11px;
  cursor: pointer;
  outline: none;

  &:hover {
    border-color: ${v("--text-secondary")};
  }

  &:focus {
    border-color: #0078d4;
  }
`;

export const FontFamilySelect = styled(MiniSelect)`
  width: 90px;
`;

export const FontSizeSelect = styled(MiniSelect)`
  width: 38px;
  text-align: center;
`;

/** Color indicator bar under font/highlight icon buttons */
export const ColorIndicator = styled.span<{ $color: string }>`
  position: absolute;
  bottom: 2px;
  left: 4px;
  right: 4px;
  height: 3px;
  background-color: ${(p) => p.$color};
  border-radius: 1px;
`;

/** Color picker dropdown that appears below a color button */
export const ColorDropdown = styled.div`
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 1;
  margin-top: 2px;
  padding: 6px;
  background: ${v("--ctx-menu-bg")};
  border: 1px solid ${v("--ctx-menu-border")};
  border-radius: 4px;
  box-shadow: ${v("--ctx-menu-shadow")};
`;

export const ColorGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 2px;
`;

export const ColorCell = styled.button<{ $color: string; $selected?: boolean }>`
  width: 14px;
  height: 14px;
  padding: 0;
  border: ${(p) =>
    p.$selected ? "2px solid #0078d4" : "1px solid rgba(128,128,128,0.3)"};
  border-radius: 2px;
  background-color: ${(p) => p.$color};
  cursor: pointer;

  &:hover {
    border: 2px solid ${v("--text-primary")};
    transform: scale(1.15);
  }
`;
