//! FILENAME: app/extensions/Sparklines/components/CreateSparklineDialog.styles.ts
// PURPOSE: Styled-components for the Create Sparkline dialog.
// CONTEXT: Follows same pattern as CreateChartDialog.styles.ts.

import styled from "styled-components";

const v = (name: string) => `var(${name})`;

export const DialogContainer = styled.div`
  background: ${v("--panel-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  width: 420px;
  display: flex;
  flex-direction: column;
  color: ${v("--text-primary")};
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
`;

export const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px 0 16px;
  flex-shrink: 0;
  cursor: grab;
  user-select: none;

  &:active {
    cursor: grabbing;
  }
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

export const Body = styled.div`
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

export const FieldGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

export const Label = styled.label`
  font-size: 12px;
  font-weight: 500;
  color: ${v("--text-secondary")};
`;

export const Input = styled.input`
  background: ${v("--input-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  padding: 6px 8px;
  color: ${v("--text-primary")};
  font-size: 13px;
  font-family: "Segoe UI", system-ui, sans-serif;

  &:focus {
    outline: none;
    border-color: ${v("--accent-color")};
  }
`;

export const TypeSelector = styled.div`
  display: flex;
  gap: 8px;
`;

export const TypeButton = styled.button<{ $active: boolean }>`
  flex: 1;
  padding: 8px 12px;
  border: 1px solid ${(p) => (p.$active ? "#2563EB" : v("--border-default"))};
  background: transparent;
  color: ${(p) => (p.$active ? "#2563EB" : v("--text-primary"))};
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: ${(p) => (p.$active ? 600 : 500)};
  transition: all 0.15s ease;

  &:hover {
    border-color: #2563EB;
    color: #2563EB;
  }
`;

export const Footer = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 16px 16px 16px;
`;

export const Button = styled.button<{ $primary?: boolean }>`
  padding: 6px 20px;
  border: 1px solid ${(p) => (p.$primary ? v("--accent-primary") : v("--border-default"))};
  background: ${(p) => (p.$primary ? v("--accent-primary") : "transparent")};
  color: ${(p) => (p.$primary ? "#fff" : v("--text-primary"))};
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;

  &:hover {
    opacity: 0.9;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

export const ErrorMessage = styled.div`
  color: #d94735;
  font-size: 12px;
  padding: 4px 0;
`;

// ============================================================================
// Collapsed Bar (shown during range selection)
// ============================================================================

export const CollapsedBar = styled.div`
  background: ${v("--panel-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  color: ${v("--text-primary")};
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
`;

/** Wrapper for the two field rows (stacked vertically inside the bar). */
export const CollapsedFields = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

/** A single field row inside the collapsed bar. Click to make it the active selection target. */
export const CollapsedFieldRow = styled.div<{ $active: boolean }>`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: ${(p) => (p.$active ? "grab" : "pointer")};
  user-select: none;
  background: ${(p) => (p.$active ? "rgba(37, 99, 235, 0.08)" : "transparent")};
  border: 1px solid ${(p) => (p.$active ? "rgba(37, 99, 235, 0.3)" : "transparent")};

  &:active {
    cursor: grabbing;
  }
`;

export const CollapsedLabel = styled.span`
  font-size: 12px;
  font-weight: 500;
  color: ${v("--text-secondary")};
  white-space: nowrap;
  min-width: 72px;
`;

export const CollapsedInput = styled.input`
  background: ${v("--input-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  padding: 3px 6px;
  color: ${v("--text-primary")};
  font-size: 13px;
  font-family: "Segoe UI", system-ui, sans-serif;
  width: 120px;

  &:focus {
    outline: none;
    border-color: ${v("--accent-color")};
  }
`;

export const ExpandButton = styled.button`
  background: transparent;
  border: none;
  color: ${v("--text-secondary")};
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  font-size: 18px;
  line-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  align-self: center;

  &:hover {
    background: ${v("--grid-bg")};
    color: ${v("--text-primary")};
  }
`;
