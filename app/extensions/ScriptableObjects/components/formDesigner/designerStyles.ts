//! FILENAME: app/extensions/ScriptableObjects/components/formDesigner/designerStyles.ts
// PURPOSE: The designer's own chrome, as plain style objects.
// CONTEXT: M5b of docs/design/typescript-forms.md §14. The Object Script Editor
//          is a separate Tauri window painted with literal dark-editor colours
//          and an `ose-btn` class rather than the app's theme tokens
//          (ObjectScriptEditorApp.tsx), so the designer that lives inside it
//          matches ITS surroundings. The FORM being designed is a different
//          matter: it is painted by the shared `FormWidgetTree` under
//          `panelLayout`, so what the user sees on the canvas inherits the app
//          skin exactly as the real dialog will.

import type React from "react";

export const COLORS = {
  panel: "#252526",
  panelBorder: "#333",
  surface: "#1E1E1E",
  text: "#D4D4D4",
  muted: "#888",
  faint: "#555",
  accent: "#0E639C",
  accentText: "#9CDCFE",
  warn: "#CCA700",
  warnSurface: "#3A3320",
  error: "#F48771",
  errorSurface: "#4A2B2B",
} as const;

export const panel: React.CSSProperties = {
  backgroundColor: COLORS.panel,
  borderRight: `1px solid ${COLORS.panelBorder}`,
  overflowY: "auto",
  padding: "8px 10px",
  fontSize: 11,
  color: COLORS.text,
  flexShrink: 0,
};

export const sectionHeading: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 10,
  color: COLORS.muted,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  margin: "10px 0 4px",
};

export const paletteButton: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  marginBottom: 3,
  cursor: "grab",
};

export const canvasSurface: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflowY: "auto",
  backgroundColor: COLORS.surface,
  padding: 12,
};

export const nodeCard = (selected: boolean): React.CSSProperties => ({
  border: `1px solid ${selected ? COLORS.accentText : COLORS.panelBorder}`,
  borderRadius: 3,
  marginBottom: 6,
  backgroundColor: selected ? "rgba(156, 220, 254, 0.06)" : COLORS.panel,
  outline: "none",
});

export const nodeHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 6px",
  borderBottom: `1px solid ${COLORS.panelBorder}`,
  fontSize: 10,
  color: COLORS.muted,
  cursor: "grab",
};

/**
 * The rendered widget itself. `pointerEvents: "none"` is not cosmetic: the
 * canvas paints REAL controls through the shared tree, and a designer where a
 * click lands in the text box instead of selecting the widget is a designer
 * that cannot be used at all.
 */
export const nodePreview: React.CSSProperties = {
  padding: "6px 8px",
  pointerEvents: "none",
};

/**
 * A container card's BODY, which is where a drop lands INSIDE that container.
 *
 * The header is deliberately left out of it. The header is the drag handle, and
 * it is also the only band of a container's card where a release still means
 * "put this next to the container" — a whole-card target would make a group that
 * fills the canvas impossible to move a widget PAST.
 */
export const containerDropZone = (over: boolean): React.CSSProperties => ({
  border: `1px dashed ${over ? COLORS.accentText : "transparent"}`,
  borderRadius: 2,
  backgroundColor: over ? "rgba(156, 220, 254, 0.08)" : undefined,
});

export const dropMarker: React.CSSProperties = {
  height: 2,
  backgroundColor: COLORS.accentText,
  margin: "2px 0",
};

export const banner = (tone: "warn" | "error"): React.CSSProperties => ({
  padding: "6px 12px",
  fontSize: 11,
  lineHeight: 1.5,
  backgroundColor: tone === "error" ? COLORS.errorSurface : COLORS.warnSurface,
  color: tone === "error" ? COLORS.error : "#FFD666",
  borderBottom: `1px solid ${COLORS.panelBorder}`,
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
});

export const fieldRow: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  marginBottom: 6,
};

export const fieldLabel: React.CSSProperties = {
  fontSize: 10,
  color: COLORS.muted,
};

export const fieldInput: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  backgroundColor: COLORS.surface,
  color: COLORS.text,
  border: `1px solid ${COLORS.panelBorder}`,
  borderRadius: 2,
  padding: "2px 4px",
  fontSize: 11,
  fontFamily: "inherit",
};
