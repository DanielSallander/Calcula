// FILENAME: app/extensions/ModelEditor/components/editorShared.tsx
// PURPOSE: Shared building blocks for the Model Editor window: the section
//          context contract, the neutral light-theme style kit, and small
//          primitives (Modal, ErrorBanner, Badge, Field) used by all sections.

import React, { useRef } from "react";
import type { ModelMeasureInfo, ModelOverview } from "@api";

// ============================================================================
// Section contract (provided by ModelEditorApp to every model section)
// ============================================================================

export interface SectionCtx {
  connectionId: string;
  overview: ModelOverview;
  /** True when the model rejects edits (readOnlyReason banner is shown). */
  readOnly: boolean;
  /** Install the fresh overview a mutation returned; also notifies the main
   * window (emitModelChanged) so CUBE cells re-evaluate there. */
  applyOverview: (overview: ModelOverview) => void;
  /** Same, for the measure endpoints that return only the measure list. */
  applyMeasures: (measures: ModelMeasureInfo[]) => void;
  /** Surface an API error in the window-level dismissible banner. */
  reportError: (err: unknown) => void;
}

// ============================================================================
// Style kit (neutral light theme, 12-13px, matching the old dialog's look)
// ============================================================================

export const ACCENT = "#2f6fce";
export const SELECTION_BG = "rgba(100, 148, 237, 0.18)";

export const styles = {
  input: {
    padding: "4px 6px",
    border: "1px solid #ccc",
    borderRadius: 3,
    fontSize: 13,
    background: "#fff",
    color: "#222",
    fontFamily: "inherit",
  },
  textarea: {
    padding: "4px 6px",
    border: "1px solid #ccc",
    borderRadius: 3,
    fontSize: 12,
    background: "#fff",
    color: "#222",
    fontFamily: "Consolas, 'Cascadia Code', monospace",
    resize: "vertical",
  },
  btn: {
    padding: "4px 12px",
    fontSize: 12,
    border: "1px solid #bbb",
    borderRadius: 3,
    background: "#fff",
    color: "#222",
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  primaryBtn: {
    padding: "4px 12px",
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid #2f6fce",
    borderRadius: 3,
    background: "#2f6fce",
    color: "#fff",
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  smallBtn: {
    padding: "1px 7px",
    fontSize: 11,
    border: "1px solid #bbb",
    borderRadius: 3,
    background: "#fff",
    color: "#222",
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  field: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 },
  label: { fontSize: 12, fontWeight: 600, color: "#444" },
  muted: { color: "#777" },
  hint: { fontSize: 11, color: "#888" },
  th: {
    textAlign: "left",
    padding: "4px 8px",
    borderBottom: "1px solid #ddd",
    fontWeight: 600,
    fontSize: 12,
    color: "#555",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "4px 8px",
    borderBottom: "1px solid #eee",
    fontSize: 12,
    verticalAlign: "top",
  },
  card: { background: "#fff", border: "1px solid #ddd", borderRadius: 6, padding: 12 },
  sectionHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 2 },
  sectionTitle: { fontSize: 14, fontWeight: 600, flex: 1 },
  listRow: {
    padding: "6px 8px",
    borderBottom: "1px solid #eee",
    borderRadius: 3,
    cursor: "pointer",
  },
} satisfies Record<string, React.CSSProperties>;

// ============================================================================
// ErrorBanner (window-level, dismissible)
// ============================================================================

export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "6px 12px",
        background: "#fdecea",
        color: "#a4262c",
        fontSize: 12,
        borderBottom: "1px solid #f3c1c4",
        flexShrink: 0,
      }}
    >
      <div style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{message}</div>
      <button
        onClick={onDismiss}
        title="Dismiss"
        style={{
          border: "none",
          background: "transparent",
          color: "#a4262c",
          cursor: "pointer",
          fontSize: 14,
          lineHeight: 1,
          padding: 0,
        }}
      >
        &times;
      </button>
    </div>
  );
}

// ============================================================================
// Badge
// ============================================================================

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "warn" | "ok";
}): React.ReactElement {
  const colors = {
    neutral: { bg: "#eef0f2", fg: "#555" },
    warn: { bg: "#fff3cd", fg: "#7a5b00" },
    ok: { bg: "#e2f4e5", fg: "#1e7a34" },
  }[tone];
  return (
    <span
      style={{
        background: colors.bg,
        color: colors.fg,
        borderRadius: 3,
        padding: "1px 6px",
        fontSize: 11,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

// ============================================================================
// Field (label above a control, optional hint below)
// ============================================================================

export function Field({
  label,
  hint,
  flex,
  children,
}: {
  label: string;
  hint?: string;
  flex?: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ ...styles.field, ...(flex !== undefined ? { flex } : {}) }}>
      <label style={styles.label}>{label}</label>
      {children}
      {hint && <div style={styles.hint}>{hint}</div>}
    </div>
  );
}

// ============================================================================
// Modal (window-local, light theme — NOT a Tauri dialog)
// ============================================================================

export function Modal({
  title,
  width = 560,
  onClose,
  children,
  footer,
}: {
  title: string;
  width?: number;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement {
  // Close on backdrop click only when the interaction both STARTS and ENDS on
  // the backdrop. A drag that starts inside the dialog (e.g. selecting text)
  // and is released over the backdrop must NOT discard the user's input.
  const mouseDownOnBackdrop = useRef(false);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0, 0, 0, 0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onMouseDown={(e) => {
        mouseDownOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (mouseDownOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 6,
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.25)",
          width,
          maxWidth: "94vw",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0, padding: "14px 16px 10px", fontSize: 15 }}>{title}</h3>
        <div style={{ padding: "0 16px", overflowY: "auto", flex: 1, minHeight: 0 }}>
          {children}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 16px",
          }}
        >
          {footer}
        </div>
      </div>
    </div>
  );
}
