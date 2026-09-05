//! FILENAME: app/extensions/ScriptableObjects/components/scriptPane/ScriptPaneSection.styles.ts
// PURPOSE: Styled-components for the trusted script TASK PANE renderer (M2).
//          The identity band and the body text are the SAME pieces the modal
//          form and the five-field dialog paint, re-exported from their styles
//          so the three surfaces cannot drift apart; what a pane adds is only
//          its own root (no backdrop, no drag handle — it is hosted by the
//          panel system) and a band that is not a drag handle. Every colour is
//          a theme token (a `--*` CSS variable), so a script's pane is skinned
//          by the app and can never be made to look like something it is not.

import styled from "styled-components";

export {
  ScriptGlyph,
  HeaderText,
  AskedBy,
  Provenance,
  CloseButton,
  ScriptTitle,
  Message,
} from "../ScriptDialogPrompt.styles";
export { MessageBanner } from "../scriptForm/ScriptFormDialog.styles";

const v = (name: string) => `var(${name})`;

/** The pane's root inside the panel section: a column that never overflows sideways. */
export const PaneRoot = styled.div`
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  color: ${v("--text-primary")};
  font-family: ${v("--font-family-sans")}, "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
`;

/**
 * The ATTRIBUTION band: which script, where it came from, which sheet its
 * bindings are pinned to, and the one close affordance. Host-derived to the
 * last character; a script's own heading is body content below it.
 */
export const Band = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid ${v("--dialog-border")};
  flex-shrink: 0;
`;

/** The script's content: title, description, banner, then the widget tree. */
export const PaneBody = styled.div`
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
`;
