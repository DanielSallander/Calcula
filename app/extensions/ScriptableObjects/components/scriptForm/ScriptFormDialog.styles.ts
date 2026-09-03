//! FILENAME: app/extensions/ScriptableObjects/components/scriptForm/ScriptFormDialog.styles.ts
// PURPOSE: Styled-components for the trusted script FORM renderer. The chrome
//          (backdrop, container, attribution band, body, footer, buttons) is
//          the SAME chrome the five-field script dialog paints, re-exported
//          from its styles so the two surfaces cannot drift apart; only what a
//          form adds (banners, tabs, progress, the stale-cell marker) is new.
//          Every colour is a theme token (a `--*` CSS variable), so a script's
//          form is skinned by the app and can never be made to look like
//          something it is not.

import styled from "styled-components";

export {
  Backdrop,
  DialogContainer,
  Header,
  ScriptGlyph,
  HeaderText,
  AskedBy,
  Provenance,
  CloseButton,
  Body,
  ScriptTitle,
  Message,
  Footer,
  Button,
  PrimaryButton,
  Help,
  ErrorText,
  Required,
  TextArea,
  CheckboxRow,
} from "../ScriptDialogPrompt.styles";

const v = (name: string) => `var(${name})`;

// ============================================================================
// Band additions (host-derived lines a script cannot address)
// ============================================================================

/** "Preview — nothing will be written": chrome, in the band, never body. */
export const PreviewBanner = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: ${v("--accent-color")};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

// ============================================================================
// Body
// ============================================================================

/** The script's banner (`form.update({ message })`) or a refused submit's message. */
export const MessageBanner = styled.div<{ $kind: "info" | "warning" | "error" }>`
  font-size: 12px;
  line-height: 1.5;
  padding: 6px 10px;
  border-radius: 4px;
  border: 1px solid
    ${(p) => (p.$kind === "error" ? v("--text-error") : p.$kind === "warning" ? v("--accent-color") : v("--dialog-border"))};
  color: ${(p) => (p.$kind === "error" ? v("--text-error") : v("--text-primary"))};
  background: ${v("--dialog-category-bg")};
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

/** The widget column. */
export const WidgetList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
`;

/** One widget's frame: control + help + error + stale marker, stacked. */
export const WidgetFrame = styled.div`
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
`;

/** A `label` widget in its normal style — wraps, unlike an ellipsizing status line. */
export const LabelText = styled.div`
  font-size: 12px;
  line-height: 1.5;
  color: ${v("--text-primary")};
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

export const Heading = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: ${v("--text-primary")};
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

export const Muted = styled.div`
  font-size: 11px;
  color: ${v("--text-secondary")};
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

/** "The cell changed while you were editing" — shown on a dirty widget after a re-seed. */
export const StaleMarker = styled.span`
  font-size: 11px;
  color: ${v("--accent-color")};
`;

/** Holds an `image` widget's picture (host-resolved URL only) or its alt text. */
export const ImageFrame = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-start;
  min-width: 0;

  img {
    max-width: 100%;
    display: block;
  }
`;

/** "… n more" under a clipped table. */
export const MoreRows = styled.div`
  font-size: 11px;
  color: ${v("--text-secondary")};
`;

// ============================================================================
// Radio / listbox
// ============================================================================

export const RadioFieldset = styled.fieldset<{ $row: boolean }>`
  border: none;
  margin: 0;
  padding: 0;
  min-width: 0;
  display: flex;
  flex-direction: ${(p) => (p.$row ? "row" : "column")};
  flex-wrap: wrap;
  gap: ${(p) => (p.$row ? "12px" : "4px")};
`;

export const RadioLegend = styled.legend`
  font-size: 11px;
  opacity: 0.75;
  padding: 0;
  margin-bottom: 2px;
`;

export const RadioOption = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: ${v("--text-primary")};
  cursor: pointer;

  input {
    margin: 0;
  }
`;

/** A native multi-row select (the listbox widget). */
export const ListSelect = styled.select`
  width: 100%;
  box-sizing: border-box;
  padding: 2px 4px;
  font-size: 12px;
  font-family: inherit;
  border-radius: 4px;
  background: ${v("--dialog-input-bg")};
  color: ${v("--dialog-input-text")};
  border: 1px solid ${v("--dialog-input-border")};

  &:focus {
    outline: none;
    border-color: ${v("--dialog-input-border-focus")};
  }

  &:disabled {
    opacity: 0.5;
  }
`;

// ============================================================================
// Tabs
// ============================================================================

export const TabList = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  border-bottom: 1px solid ${v("--dialog-border")};
`;

export const Tab = styled.button<{ $active: boolean }>`
  appearance: none;
  border: none;
  border-bottom: 2px solid ${(p) => (p.$active ? v("--accent-color") : "transparent")};
  background: transparent;
  padding: 5px 10px;
  margin-bottom: -1px;
  font-size: 12px;
  font-family: inherit;
  font-weight: ${(p) => (p.$active ? 600 : 400)};
  color: ${(p) => (p.$active ? v("--text-primary") : v("--text-secondary"))};
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;

  &:hover {
    background: ${v("--dialog-button-hover-bg")};
  }
`;

/** Error count on a tab whose page holds a widget with an error. */
export const TabBadge = styled.span`
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 8px;
  color: ${v("--dialog-insert-text")};
  background: ${v("--text-error")};
`;

export const TabPanel = styled.div`
  padding-top: 8px;
  min-width: 0;
`;

// ============================================================================
// Progress
// ============================================================================

export const ProgressTrack = styled.div`
  width: 100%;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  background: ${v("--dialog-category-bg")};
  border: 1px solid ${v("--dialog-border")};
  box-sizing: border-box;
`;

export const ProgressBar = styled.div`
  height: 100%;
  background: ${v("--accent-color")};
  transition: width 120ms ease-out;
`;

export const ProgressText = styled.div`
  font-size: 11px;
  color: ${v("--text-secondary")};
`;

// ============================================================================
// Preview summary
// ============================================================================

export const PreviewList = styled.dl`
  margin: 0;
  padding: 8px 10px;
  border: 1px solid ${v("--dialog-border")};
  border-radius: 4px;
  background: ${v("--dialog-category-bg")};
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 12px;
  row-gap: 4px;
  font-size: 12px;

  dt {
    font-weight: 600;
    color: ${v("--text-primary")};
    white-space: nowrap;
  }

  dd {
    margin: 0;
    color: ${v("--text-primary")};
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
`;

export const PreviewHeading = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: ${v("--text-primary")};
`;
