//! FILENAME: app/extensions/MacroRecorder/components/styles.ts
// PURPOSE: Shared inline styles for the recorder's dialogs and status-bar item.
// CONTEXT: Values come from the app's CSS custom properties so the dialogs
//          follow the active skin (see project_app_skins).

import type React from "react";

const v = (name: string) => `var(${name})`;

/**
 * A button style that LOOKS disabled when it is disabled.
 *
 * Not cosmetic. `btn`/`btnPrimary` set `background`, `color`, `border` and
 * `cursor` as INLINE styles, which override the user agent's `button:disabled`
 * appearance in every property that would have greyed the control out. The
 * result shipped once: a disabled Run button that rendered byte-identically to
 * an enabled one, complete with a pointer cursor — and a disabled button fires
 * no `onClick`, so the user clicked a normal-looking button and got literally
 * nothing. No event, no toast, no error. "Nothing happens" was the bug report.
 *
 * Any refusal is allowed to be a refusal; a refusal that is invisible is not.
 */
export function disabledIf(
  base: React.CSSProperties,
  disabled: boolean,
): React.CSSProperties {
  if (!disabled) return base;
  return {
    ...base,
    opacity: 0.45,
    cursor: "not-allowed",
    filter: "grayscale(1)",
  };
}

export const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1050,
    background: "rgba(0, 0, 0, 0.45)",
  },

  dialog: {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    zIndex: 1051,
    background: v("--panel-bg"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    display: "flex",
    flexDirection: "column",
    color: v("--text-primary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },

  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: `1px solid ${v("--border-default")}`,
    cursor: "move",
    userSelect: "none",
  },

  title: { fontWeight: 600, fontSize: 15 },

  closeBtn: {
    background: "transparent",
    border: "none",
    color: v("--text-secondary"),
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 14,
    lineHeight: 1,
  },

  body: {
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    overflow: "auto",
    flex: 1,
    minHeight: 0,
  },

  label: { fontSize: 12, color: v("--text-secondary") },

  input: {
    padding: "5px 8px",
    fontSize: 13,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    width: "100%",
    boxSizing: "border-box",
  },

  code: {
    flex: 1,
    minHeight: 220,
    padding: 10,
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 12,
    lineHeight: 1.45,
    borderRadius: 4,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    outline: "none",
    resize: "none",
    whiteSpace: "pre",
    boxSizing: "border-box",
  },

  radioRow: {
    display: "flex",
    gap: 16,
    alignItems: "flex-start",
    flexWrap: "wrap",
  },

  radioLabel: {
    display: "flex",
    gap: 6,
    alignItems: "flex-start",
    cursor: "pointer",
    maxWidth: 320,
  },

  hint: { fontSize: 11, color: v("--text-secondary"), lineHeight: 1.4 },

  warning: {
    fontSize: 12,
    color: "#c9821a",
    lineHeight: 1.45,
    border: "1px solid rgba(201, 130, 26, 0.4)",
    borderRadius: 4,
    padding: "8px 10px",
  },

  /** "Your recording is safe, here is where it lives" — the reassurance the
   *  review dialog leads with now that Close can no longer lose anything. */
  saved: {
    fontSize: 12,
    color: v("--text-primary"),
    lineHeight: 1.45,
    border: `1px solid ${v("--border-default")}`,
    borderLeft: "3px solid #3a9a5c",
    borderRadius: 4,
    padding: "8px 10px",
    background: v("--grid-bg"),
  },

  /** Loud failure box — the auto-save fell over and the user must act. */
  error: {
    fontSize: 12,
    color: "#d05353",
    lineHeight: 1.45,
    border: "1px solid rgba(208, 83, 83, 0.5)",
    borderRadius: 4,
    padding: "8px 10px",
  },

  list: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    overflow: "auto",
    minHeight: 120,
    flex: 1,
  },

  listRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "7px 10px",
    cursor: "pointer",
    borderBottom: `1px solid ${v("--border-default")}`,
  },

  listRowSelected: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "7px 10px",
    cursor: "pointer",
    borderBottom: `1px solid ${v("--border-default")}`,
    background: v("--accent-primary"),
    color: "#ffffff",
  },

  badge: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    borderRadius: 3,
    padding: "1px 6px",
    border: `1px solid ${v("--border-default")}`,
    whiteSpace: "nowrap",
  },

  output: {
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 11,
    lineHeight: 1.45,
    whiteSpace: "pre-wrap",
    maxHeight: 120,
    overflow: "auto",
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    padding: "8px 10px",
    background: v("--grid-bg"),
  },

  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
    flexWrap: "wrap",
  },

  btn: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 80,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },

  btnPrimary: {
    padding: "6px 16px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 80,
    background: v("--accent-primary"),
    color: "#ffffff",
    border: `1px solid ${v("--accent-primary")}`,
  },
};
