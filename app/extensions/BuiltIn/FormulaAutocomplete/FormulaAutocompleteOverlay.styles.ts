//! FILENAME: app/extensions/BuiltIn/FormulaAutocomplete/FormulaAutocompleteOverlay.styles.ts
// PURPOSE: Styled-components for the formula autocomplete dropdown and argument hints.
// CONTEXT: Uses the same theme token pattern as the rest of the codebase.

import styled from "styled-components";

const v = (name: string) => `var(${name})`;

// ============================================================================
// Dropdown Container & Items
// ============================================================================

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
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  column-gap: 8px;
  padding: 5px 10px;
  cursor: pointer;
  background: ${(p) => (p.$isSelected ? v("--accent-color-light") : "transparent")};

  &:hover {
    background: ${v("--accent-color-light")};
  }
`;

export const FunctionNameContainer = styled.span`
  font-weight: 600;
  font-size: 12px;
  color: ${v("--text-primary")};
  grid-column: 1;
  grid-row: 1;
  font-family: "Consolas", "Courier New", monospace;
`;

export const CategoryTag = styled.span`
  font-size: 10px;
  color: ${v("--text-secondary")};
  background: ${v("--bg-surface-disabled")};
  padding: 1px 5px;
  border-radius: 3px;
  grid-column: 2;
  grid-row: 1;
  align-self: center;
  white-space: nowrap;
`;

export const Description = styled.span`
  font-size: 11px;
  color: ${v("--text-secondary")};
  grid-column: 1 / -1;
  grid-row: 2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
`;

export const MatchHighlight = styled.span`
  color: ${v("--accent-color")};
  font-weight: 700;
`;

// ============================================================================
// Argument Hint Tooltip
// ============================================================================

export const ArgumentHintContainer = styled.div`
  position: fixed;
  z-index: 10001;
  background: ${v("--bg-surface")};
  border: 1px solid ${v("--border-default")};
  border-radius: 3px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  padding: 4px 10px;
  font-size: 12px;
  font-family: "Consolas", "Courier New", monospace;
  color: ${v("--text-secondary")};
  white-space: nowrap;
`;

export const FnName = styled.span`
  font-weight: 700;
  color: ${v("--text-primary")};
`;

export const ActiveArg = styled.span`
  font-weight: 700;
  color: ${v("--text-primary")};
  text-decoration: underline;
  text-underline-offset: 2px;
`;
