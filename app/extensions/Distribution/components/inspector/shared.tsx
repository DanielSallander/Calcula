// FILENAME: app/extensions/Distribution/components/inspector/shared.tsx
// PURPOSE: Shared visual language for the Package Inspector window — light
//          standalone-window chrome like the Model Editor (secondary windows
//          do not load the app skin), plus small presentation helpers.

import React from "react";

export const ACCENT = "#0f6cbd";
export const MUTED = "#6b7076";
export const BORDER = "#ddd";
export const OK_GREEN = "#1e7e34";
export const WARN_AMBER = "#b8860b";
export const ERR_RED = "#c0392b";

export const sectionTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  margin: "0 0 10px 0",
};

export const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: `1px solid ${BORDER}`,
  borderRadius: 4,
  padding: "10px 14px",
  marginBottom: 12,
};

export const cardHeaderStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 8,
};

export const mutedStyle: React.CSSProperties = { color: MUTED };

export const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  fontSize: 12,
  width: "100%",
};

export const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "3px 10px 3px 0",
  borderBottom: `1px solid ${BORDER}`,
  color: MUTED,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

export const tdStyle: React.CSSProperties = {
  padding: "3px 10px 3px 0",
  borderBottom: "1px solid #eee",
  verticalAlign: "top",
};

export const preStyle: React.CSSProperties = {
  fontFamily: "Consolas, 'Courier New', monospace",
  fontSize: 12,
  background: "#f7f8f9",
  border: `1px solid ${BORDER}`,
  borderRadius: 4,
  padding: 10,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 420,
};

export const buttonStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: 12,
  border: `1px solid ${BORDER}`,
  borderRadius: 3,
  background: "#fff",
  cursor: "pointer",
};

export const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: ACCENT,
  borderColor: ACCENT,
  color: "#fff",
};

export const inputStyle: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  border: `1px solid ${BORDER}`,
  borderRadius: 3,
};

/** Small colored pill (trust status, capability, verify result...). */
export function Badge({
  color,
  children,
}: {
  color: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 8px",
        borderRadius: 9,
        fontSize: 11,
        fontWeight: 600,
        color: "#fff",
        background: color,
        marginRight: 4,
      }}
    >
      {children}
    </span>
  );
}

/** One "label: value" row for identity/metadata cards. */
export function KV({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", gap: 8, padding: "2px 0", fontSize: 12 }}>
      <span style={{ color: MUTED, minWidth: 150, flexShrink: 0 }}>{label}</span>
      <span style={{ wordBreak: "break-all" }}>{children}</span>
    </div>
  );
}

/** Standard placeholder while a section's data loads / errors / is empty. */
export function StatusLine({
  error,
  loading,
  empty,
  emptyText,
}: {
  error?: string | null;
  loading?: boolean;
  empty?: boolean;
  emptyText?: string;
}): React.ReactElement | null {
  if (error) return <div style={{ color: ERR_RED, fontSize: 12, padding: 8 }}>{error}</div>;
  if (loading) return <div style={{ ...mutedStyle, fontSize: 12, padding: 8 }}>Loading…</div>;
  if (empty)
    return (
      <div style={{ ...mutedStyle, fontSize: 12, padding: 8 }}>
        {emptyText ?? "Nothing of this kind in the package."}
      </div>
    );
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
