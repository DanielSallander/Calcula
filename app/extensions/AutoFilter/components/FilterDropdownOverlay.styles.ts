//! FILENAME: app/extensions/AutoFilter/components/FilterDropdownOverlay.styles.ts
// PURPOSE: Styled components for the filter dropdown overlay.

import styled from "styled-components";

export const DropdownContainer = styled.div`
  position: fixed;
  background: var(--menu-dropdown-bg, #ffffff);
  border: 1px solid var(--menu-border, #d0d0d0);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  min-width: 220px;
  max-width: 300px;
  z-index: 10000;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 13px;
  color: var(--menu-text, #333333);
  display: flex;
  flex-direction: column;
`;

export const SearchContainer = styled.div`
  padding: 8px;
  border-bottom: 1px solid var(--menu-border, #e0e0e0);
`;

export const SearchInput = styled.input`
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #c0c0c0;
  border-radius: 3px;
  font-size: 12px;
  outline: none;
  box-sizing: border-box;

  &:focus {
    border-color: #1a73e8;
    box-shadow: 0 0 0 2px rgba(26, 115, 232, 0.2);
  }
`;

export const CheckboxList = styled.div`
  max-height: 250px;
  overflow-y: auto;
  padding: 4px 0;
`;

export const CheckboxItem = styled.label<{ $dimmed?: boolean }>`
  display: flex;
  align-items: center;
  padding: 4px 12px;
  cursor: pointer;
  gap: 8px;
  opacity: ${(p) => (p.$dimmed ? 0.5 : 1)};

  &:hover {
    background: var(--menu-button-hover-bg, #f0f0f0);
  }
`;

export const CheckboxInput = styled.input`
  margin: 0;
  cursor: pointer;
  accent-color: #1a73e8;
`;

export const ValueLabel = styled.span`
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
`;

export const ButtonRow = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid var(--menu-border, #e0e0e0);
`;

export const ActionButton = styled.button<{ $primary?: boolean }>`
  padding: 5px 16px;
  border: 1px solid ${(p) => (p.$primary ? "#1a73e8" : "#c0c0c0")};
  border-radius: 3px;
  background: ${(p) => (p.$primary ? "#1a73e8" : "#ffffff")};
  color: ${(p) => (p.$primary ? "#ffffff" : "#333333")};
  font-size: 12px;
  cursor: pointer;

  &:hover {
    background: ${(p) => (p.$primary ? "#1557b0" : "#f0f0f0")};
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

export const ClearFilterLink = styled.button`
  padding: 6px 12px;
  border: none;
  background: none;
  color: #1a73e8;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  border-bottom: 1px solid var(--menu-border, #e0e0e0);

  &:hover {
    background: var(--menu-button-hover-bg, #f0f0f0);
  }
`;

export const SelectAllItem = styled(CheckboxItem)`
  font-weight: 600;
  border-bottom: 1px solid var(--menu-border, #e0e0e0);
  padding: 6px 12px;
`;

export const EmptyMessage = styled.div`
  padding: 16px;
  text-align: center;
  color: #999;
  font-size: 12px;
`;

// ============================================================================
// Sort Section
// ============================================================================

export const SortSection = styled.div`
  border-bottom: 1px solid var(--menu-border, #e0e0e0);
  padding: 4px 0;
`;

export const SortItem = styled.div`
  display: flex;
  align-items: center;
  padding: 5px 12px;
  cursor: pointer;
  gap: 8px;
  font-size: 12px;
  color: var(--menu-text, #333333);

  &:hover {
    background: var(--menu-button-hover-bg, #f0f0f0);
  }
`;

export const SortIcon = styled.span`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;

  svg {
    width: 16px;
    height: 16px;
  }
`;

export const SortByColorContainer = styled.div`
  position: relative;
`;

export const SortByColorSubmenu = styled.div`
  position: absolute;
  left: 100%;
  top: -4px;
  background: var(--menu-dropdown-bg, #ffffff);
  border: 1px solid var(--menu-border, #d0d0d0);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  min-width: 180px;
  z-index: 10001;
  padding: 4px 0;
`;

export const SubmenuArrow = styled.span`
  margin-left: auto;
  font-size: 10px;
  color: #999;
`;

export const ColorSwatchRow = styled.div`
  display: flex;
  align-items: center;
  padding: 5px 12px;
  cursor: pointer;
  gap: 8px;
  font-size: 12px;

  &:hover {
    background: var(--menu-button-hover-bg, #f0f0f0);
  }
`;

export const ColorSwatch = styled.span<{ $color: string }>`
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 2px;
  border: 1px solid #c0c0c0;
  background: ${(p) => p.$color};
  flex-shrink: 0;
`;

export const SubMenuLabel = styled.div`
  padding: 4px 12px 2px;
  font-size: 11px;
  color: #999;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
`;

export const SubMenuDivider = styled.div`
  height: 1px;
  background: var(--menu-border, #e0e0e0);
  margin: 4px 0;
`;

export const NoColorsMessage = styled.div`
  padding: 8px 12px;
  font-size: 11px;
  color: #999;
  font-style: italic;
`;

// ============================================================================
// Expression Filter Section
// ============================================================================

export const ExpressionSection = styled.div`
  border-top: 1px solid var(--menu-border, #e0e0e0);
  padding: 8px;
`;

export const ExpressionLabel = styled.div`
  font-size: 11px;
  color: #666;
  margin-bottom: 4px;
`;

export const ExpressionRow = styled.div`
  display: flex;
  gap: 4px;
`;

export const ExpressionInput = styled.input`
  flex: 1;
  padding: 4px 6px;
  border: 1px solid #c0c0c0;
  border-radius: 3px;
  font-size: 12px;
  font-family: "Consolas", "Courier New", monospace;
  outline: none;
  box-sizing: border-box;

  &:focus {
    border-color: #1a73e8;
    box-shadow: 0 0 0 2px rgba(26, 115, 232, 0.2);
  }
`;

export const ExpressionApplyButton = styled.button`
  padding: 4px 10px;
  border: 1px solid #1a73e8;
  border-radius: 3px;
  background: #1a73e8;
  color: #ffffff;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: #1557b0;
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;
