//! FILENAME: app/extensions/Sorting/components/SortDialog.styles.ts
// PURPOSE: Styled-components for the Sort dialog.
// CONTEXT: Follows the FormatCellsDialog styling patterns.

import styled from "styled-components";

const v = (name: string) => `var(${name})`;

// ============================================================================
// Layout
// ============================================================================

export const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 1050;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
`;

export const DialogContainer = styled.div`
  background: ${v("--panel-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  width: 620px;
  max-height: 560px;
  display: flex;
  flex-direction: column;
  color: ${v("--text-primary")};
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
`;

// ============================================================================
// Header
// ============================================================================

export const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid ${v("--border-default")};
  flex-shrink: 0;
`;

export const Title = styled.span`
  font-weight: 600;
  font-size: 15px;
  color: ${v("--text-primary")};
`;

export const CloseButton = styled.button`
  background: transparent;
  border: none;
  color: ${v("--text-secondary")};
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1;

  &:hover {
    background: ${v("--grid-bg")};
    color: ${v("--text-primary")};
  }
`;

// ============================================================================
// Toolbar
// ============================================================================

export const Toolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 16px;
  flex-shrink: 0;
`;

export const ToolbarButton = styled.button<{ $disabled?: boolean }>`
  padding: 4px 12px;
  font-size: 12px;
  border-radius: 4px;
  cursor: ${(p) => (p.$disabled ? "default" : "pointer")};
  background: ${v("--grid-bg")};
  color: ${(p) => (p.$disabled ? v("--text-disabled") : v("--text-primary"))};
  border: 1px solid ${v("--border-default")};
  white-space: nowrap;
  opacity: ${(p) => (p.$disabled ? 0.5 : 1)};
  transition: opacity 0.1s;

  &:hover {
    opacity: ${(p) => (p.$disabled ? 0.5 : 0.85)};
  }
`;

export const ToolbarSeparator = styled.div`
  width: 1px;
  height: 20px;
  background: ${v("--border-default")};
  margin: 0 4px;
`;

// ============================================================================
// Level List
// ============================================================================

export const LevelListContainer = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 0 16px;
  min-height: 120px;
  max-height: 300px;

  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-thumb {
    background: ${v("--text-disabled")};
    border-radius: 3px;
  }
`;

// ============================================================================
// Column Headers Row
// ============================================================================

export const ColumnLabelsRow = styled.div`
  display: grid;
  grid-template-columns: 80px 1fr 1fr 1fr;
  gap: 8px;
  padding: 4px 16px 4px 16px;
  flex-shrink: 0;
`;

export const ColumnLabel = styled.span`
  font-size: 11px;
  font-weight: 600;
  color: ${v("--text-secondary")};
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

// ============================================================================
// Level Row
// ============================================================================

export const LevelRow = styled.div<{ $selected: boolean }>`
  display: grid;
  grid-template-columns: 80px 1fr 1fr 1fr;
  gap: 8px;
  padding: 6px 0;
  align-items: center;
  border-radius: 4px;
  cursor: pointer;
  background: ${(p) => (p.$selected ? v("--grid-bg") : "transparent")};
  border: 1px solid ${(p) => (p.$selected ? v("--accent-primary") : "transparent")};
  padding-left: 4px;
  padding-right: 4px;

  &:hover {
    background: ${v("--grid-bg")};
  }
`;

export const LevelLabel = styled.span`
  font-size: 12px;
  color: ${v("--text-secondary")};
  white-space: nowrap;
  padding-left: 4px;
`;

// ============================================================================
// Form Controls
// ============================================================================

export const Select = styled.select`
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid ${v("--border-default")};
  background: ${v("--grid-bg")};
  color: ${v("--text-primary")};
  cursor: pointer;
  width: 100%;
  min-width: 0;

  &:focus {
    outline: none;
    border-color: ${v("--accent-primary")};
  }

  option {
    background: ${v("--panel-bg")};
    color: ${v("--text-primary")};
  }
`;

export const Checkbox = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: ${v("--text-primary")};
  cursor: pointer;
  user-select: none;

  input {
    cursor: pointer;
    accent-color: ${v("--accent-primary")};
  }
`;

// ============================================================================
// Options Section
// ============================================================================

export const OptionsBar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-top: 1px solid ${v("--border-default")};
  flex-shrink: 0;
`;

// ============================================================================
// Options Popup
// ============================================================================

export const OptionsPopupBackdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 1060;
  background: rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
`;

export const OptionsPopupContainer = styled.div`
  background: ${v("--panel-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  padding: 16px;
  width: 320px;
  color: ${v("--text-primary")};
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
`;

export const OptionsPopupTitle = styled.div`
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 12px;
`;

export const OptionsGroup = styled.div`
  margin-bottom: 12px;
`;

export const OptionsGroupLabel = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: ${v("--text-secondary")};
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
`;

export const RadioLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: ${v("--text-primary")};
  cursor: pointer;
  user-select: none;
  padding: 3px 0;

  input {
    cursor: pointer;
    accent-color: ${v("--accent-primary")};
  }
`;

export const OptionsPopupFooter = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
`;

// ============================================================================
// Color Swatch
// ============================================================================

export const ColorSwatch = styled.span<{ $color: string }>`
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 2px;
  background: ${(p) => p.$color};
  border: 1px solid ${v("--border-default")};
  vertical-align: middle;
  margin-right: 6px;
`;

// ============================================================================
// Footer
// ============================================================================

export const Footer = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid ${v("--border-default")};
  flex-shrink: 0;
`;

export const Button = styled.button<{ $primary?: boolean }>`
  padding: 6px 20px;
  font-size: 13px;
  border-radius: 4px;
  cursor: pointer;
  min-width: 80px;
  transition: opacity 0.1s;

  background: ${(p) =>
    p.$primary ? v("--accent-primary") : v("--grid-bg")};
  color: ${(p) => (p.$primary ? "#ffffff" : v("--text-primary"))};
  border: 1px solid
    ${(p) => (p.$primary ? v("--accent-primary") : v("--border-default"))};

  &:hover {
    opacity: 0.85;
  }

  &:active {
    opacity: 0.7;
  }
`;

// ============================================================================
// Error Message
// ============================================================================

export const ErrorMessage = styled.div`
  padding: 8px 16px;
  color: #e74c3c;
  font-size: 12px;
  flex-shrink: 0;
`;
