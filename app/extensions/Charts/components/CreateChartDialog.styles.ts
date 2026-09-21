//! FILENAME: app/extensions/Charts/components/CreateChartDialog.styles.ts
// PURPOSE: Styled-components for the Create Chart dialog.
// CONTEXT: Follows same pattern as FormatCellsDialog.styles.ts.

import styled from "styled-components";

const v = (name: string) => `var(${name})`;

export const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 1050;
  pointer-events: none;
`;

/**
 * Sized for a two-pane body (settings | live preview) rather than the old
 * 620px column, which parked the 220px preview below the settings and turned
 * the dialog into a scrolling straw. `min(px, vw)` keeps it honest on a small
 * screen; the user's own drag-resize (useDialogWindow) overrides both.
 */
export const DialogContainer = styled.div`
  position: fixed;
  z-index: 1051;
  pointer-events: auto;
  background: ${v("--panel-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  width: min(1060px, 95vw);
  height: min(660px, 88vh);
  max-width: 95vw;
  max-height: 88vh;
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

export const TabBar = styled.div`
  display: flex;
  padding: 8px 16px 0 16px;
  gap: 0;
  border-bottom: 1px solid ${v("--border-default")};
  flex-shrink: 0;
`;

export const Tab = styled.button<{ $active: boolean }>`
  padding: 7px 14px;
  font-size: 12px;
  font-weight: ${(p) => (p.$active ? 600 : 400)};
  background: ${(p) => (p.$active ? v("--panel-bg") : "transparent")};
  color: ${(p) =>
    p.$active ? v("--accent-primary") : v("--text-secondary")};
  border: 1px solid
    ${(p) => (p.$active ? v("--border-default") : "transparent")};
  border-bottom: ${(p) =>
    p.$active
      ? `2px solid ${v("--accent-primary")}`
      : "1px solid transparent"};
  margin-bottom: -1px;
  cursor: pointer;
  border-radius: 4px 4px 0 0;
  transition: color 0.1s;

  &:hover {
    color: ${v("--text-primary")};
  }
`;

export const TabContent = styled.div`
  padding: 16px;
  overflow-y: auto;
  flex: 1;
`;

/**
 * The commit-error strip. Full width, directly above the footer, so the reason
 * the Insert button refused sits next to the button that refused — not buried
 * at the bottom of a scrolled settings pane.
 */
export const ErrorBar = styled.div`
  flex-shrink: 0;
  max-height: 96px;
  overflow-y: auto;
  padding: 8px 16px;
  border-top: 1px solid ${v("--border-default")};
  background: rgba(220, 53, 69, 0.12);
  color: #ff6b6b;
  font-size: 12px;
  white-space: pre-wrap;
`;

export const Footer = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid ${v("--border-default")};
  flex-shrink: 0;
`;

export const Button = styled.button<{ $primary?: boolean }>`
  padding: 6px 16px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: ${(p) => (p.$primary ? 500 : 400)};
  background: ${(p) =>
    p.$primary ? v("--accent-primary") : "transparent"};
  color: ${(p) =>
    p.$primary ? "#ffffff" : v("--text-secondary")};
  border: 1px solid
    ${(p) => (p.$primary ? v("--accent-primary") : v("--border-default"))};

  &:hover {
    opacity: 0.9;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

export const FieldGroup = styled.div`
  margin-bottom: 14px;
`;

export const Label = styled.label`
  display: block;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: ${v("--text-secondary")};
  margin-bottom: 6px;
  padding-bottom: 3px;
  border-bottom: 1px solid ${v("--border-default")};
`;

/**
 * Responsive multi-column layout for tab bodies: option groups flow into as
 * many columns as the pane is wide enough for, and collapse back to one when
 * the user drags the dialog narrow. 220px is tuned so the ~600px settings pane
 * holds two columns and a widened dialog picks up a third on its own.
 */
export const DesignGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  column-gap: 24px;
  row-gap: 2px;
  align-items: start;
`;

/** A DesignGrid child that spans every column (a list, an editor, a hint). */
export const GridSpan = styled.div`
  grid-column: 1 / -1;
  min-width: 0;
`;

export const Input = styled.input`
  width: 100%;
  padding: 6px 10px;
  font-size: 12px;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  color: ${v("--text-primary")};
  outline: none;
  box-sizing: border-box;
  font-family: inherit;

  &:focus {
    border-color: ${v("--accent-primary")};
  }
`;

export const Select = styled.select`
  padding: 6px 10px;
  font-size: 12px;
  background: ${v("--grid-bg")};
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  color: ${v("--text-primary")};
  outline: none;
  font-family: inherit;
  cursor: pointer;

  &:focus {
    border-color: ${v("--accent-primary")};
  }
`;

export const CheckboxLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: ${v("--text-primary")};
  cursor: pointer;
  margin-bottom: 6px;
`;

export const RadioGroup = styled.div`
  display: flex;
  gap: 16px;
  margin-bottom: 10px;
`;

export const RadioLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: ${v("--text-primary")};
  cursor: pointer;
`;

export const ErrorMessage = styled.div`
  padding: 8px 10px;
  background: rgba(220, 53, 69, 0.15);
  border: 1px solid #dc3545;
  border-radius: 4px;
  color: #ff6b6b;
  font-size: 12px;
  margin-top: 8px;
`;

export const SeriesList = styled.div`
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  max-height: 180px;
  overflow-y: auto;
  background: ${v("--grid-bg")};
`;

export const SeriesItem = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid ${v("--border-default")};

  &:last-child {
    border-bottom: none;
  }
`;

export const ColorSwatch = styled.input`
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid ${v("--border-default")};
  border-radius: 3px;
  cursor: pointer;
  background: transparent;

  &::-webkit-color-swatch-wrapper {
    padding: 1px;
  }

  &::-webkit-color-swatch {
    border: none;
    border-radius: 2px;
  }
`;

export const PalettePreview = styled.div`
  display: flex;
  gap: 3px;
  margin-top: 4px;
`;

export const PaletteSwatch = styled.div<{ $color: string }>`
  width: 16px;
  height: 16px;
  border-radius: 2px;
  background: ${(p) => p.$color};
`;

/**
 * The preview fills whatever pane hosts it instead of holding a fixed 220px.
 * Both call sites (the dialog's pinned preview pane and the Spec tab's full
 * view) are flex columns, so `flex: 1` gives the chart the whole height of the
 * dialog — the reason to widen the dialog in the first place.
 */
export const PreviewContainer = styled.div`
  border: 1px solid ${v("--border-default")};
  border-radius: 4px;
  overflow: hidden;
  background: #ffffff;
  flex: 1 1 auto;
  min-height: 160px;
`;

export const PreviewCanvas = styled.canvas`
  display: block;
  width: 100%;
  height: 100%;
`;
