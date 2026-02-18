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
