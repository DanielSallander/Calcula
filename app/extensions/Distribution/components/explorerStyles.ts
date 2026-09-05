// FILENAME: app/extensions/Distribution/components/explorerStyles.ts
// PURPOSE: The handful of styles and the one date formatter that every
//          Application Explorer section shares.
// CONTEXT: These lived at the bottom of WorkingCopySection.tsx, which was fine
//          while it was the only section. The Environments section sits directly
//          beside it and must look identical — a second copy of `warnBoxStyle`
//          would drift on the first theme change and produce two different
//          shades of "pay attention to this" in one panel.

import type React from "react";

export const linkButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--link-color, #0b5cad)",
  cursor: "pointer",
  padding: 0,
  fontSize: "11px",
  textDecoration: "underline",
};

export const mutedStyle: React.CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "11px",
};

export const dtStyle: React.CSSProperties = { color: "var(--text-secondary)" };

export const ddStyle: React.CSSProperties = { margin: 0 };

export const warnBoxStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "6px 8px",
  borderRadius: 4,
  background: "#fff3cd",
  color: "#664d03",
  lineHeight: 1.4,
};

export const errorTextStyle: React.CSSProperties = {
  color: "var(--text-error, #d33)",
  fontSize: "11px",
  lineHeight: 1.4,
};

/** RFC3339 → something a person reads, falling back to the raw string. */
export function formatWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
