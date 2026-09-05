//! FILENAME: app/extensions/ScriptableObjects/components/scriptEmbed/ScriptEmbeddedFormSurface.styles.ts
// PURPOSE: Styled-components for the trusted renderer of a form EMBEDDED on a
//          sheet (M3c). Like the task pane's styles, the identity band and the
//          body text are RE-EXPORTED from the dialog's and the form's, so the
//          three surfaces cannot drift; what this file adds is the on-grid box
//          — a card with a border and a shadow, because unlike a pane it has no
//          panel around it and has to read as an object sitting on the sheet —
//          and the ORPHAN chrome.
// CONTEXT: Every colour is a theme token (`var(--…)`) with the single exception
//          of the orphan tint, and that exception is deliberate: it is the SAME
//          red the cell-behaviour orphan badge and highlight already paint
//          (`lib/cellBehaviorUx.ts`, `rgba(200, 60, 60, …)`), so "this object
//          lost its anchor" looks the same everywhere in the grid. A token
//          would have made two orphan colours out of one meaning.

import styled from "styled-components";

export {
  ScriptGlyph,
  HeaderText,
  AskedBy,
  Provenance,
  ScriptTitle,
  Message,
} from "../ScriptDialogPrompt.styles";
export { MessageBanner } from "../scriptForm/ScriptFormDialog.styles";

const v = (name: string): string => `var(${name})`;

/** The one colour that is not a token — see the file header. */
const ORPHAN = "rgba(200, 60, 60, 0.85)";
const ORPHAN_TINT = "rgba(200, 60, 60, 0.10)";

/**
 * The card on the grid. It fills the region the placement declares, and scrolls
 * INSIDE that box rather than growing: an embedded surface that grew with its
 * content would cover cells the user never gave it.
 */
export const EmbedRoot = styled.div<{ $orphaned: boolean }>`
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
  border-radius: 4px;
  border: 1px solid ${(p) => (p.$orphaned ? ORPHAN : v("--dialog-border"))};
  background: ${(p) => (p.$orphaned ? ORPHAN_TINT : v("--dialog-bg"))};
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  color: ${v("--text-primary")};
  font-family: ${v("--font-family-sans")}, "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
`;

/**
 * The ATTRIBUTION band — the same construction the pane and the modal use, and
 * the same rule: every character in it is host-derived. There is no close
 * button, because a script cannot close this surface and the USER removes it by
 * deleting the object from the sheet (`pane.close` is refused for it in
 * scriptPanes.ts, and the reason says so).
 */
export const Band = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid ${v("--dialog-border")};
  flex-shrink: 0;
`;

/**
 * The badge a script pinned (`pane.setBadge`), painted here because an embedded
 * surface has no tab to carry one. Bounded to 8 characters by the wire row, and
 * set apart from the host-derived text so it cannot be read as chrome.
 */
export const Badge = styled.span`
  margin-left: auto;
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 16px;
  background: ${v("--dialog-category-active-bg")};
  color: ${v("--text-secondary")};
`;

/** The script's content: title, description, banners, then the widget tree. */
export const EmbedBody = styled.div`
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  overflow: auto;
`;

/**
 * What an ORPHAN says instead of a widget tree. It is a sentence and two facts
 * — which script, and that its anchor is gone — never a blank box: a surface
 * that simply stopped painting is indistinguishable from a script that crashed.
 */
export const OrphanNotice = styled.div`
  margin: 0;
  padding: 10px;
  color: ${v("--text-primary")};
  font-size: 12px;
  line-height: 1.45;
`;

/** The refusal an unopened surface paints (script not running, no layout yet). */
export const RefusalNotice = styled.div`
  margin: 0;
  padding: 10px;
  color: ${v("--text-secondary")};
  font-size: 12px;
  line-height: 1.45;
`;
