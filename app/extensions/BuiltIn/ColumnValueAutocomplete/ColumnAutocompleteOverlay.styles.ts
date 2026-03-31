//! FILENAME: app/extensions/BuiltIn/ColumnValueAutocomplete/ColumnAutocompleteOverlay.styles.ts
// PURPOSE: Styled-components for the column value autocomplete dropdown.
// CONTEXT: Uses the same theme token pattern as FormulaAutocomplete.

import styled from "styled-components";

const v = (name: string) => `var(${name})`;

export const DropdownContainer = styled.div`
  position: fixed;
  z-index: 10000;
  background: ${v("--bg-surface")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  overflow-y: auto;
  padding: 2px 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
`;

export const DropdownItem = styled.div<{ $isSelected: boolean }>`
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
  color: ${v("--text-primary")};
  background: ${(p) => (p.$isSelected ? v("--accent-color-light") : "transparent")};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  &:hover {
    background: ${v("--accent-color-light")};
  }
`;

export const MatchHighlight = styled.span`
  font-weight: 700;
`;
