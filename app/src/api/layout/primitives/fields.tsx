//! FILENAME: app/src/api/layout/primitives/fields.tsx
// PURPOSE: Form primitives: Field (the transposition workhorse) and FieldGrid.
// CONTEXT: A labeled field is ~40px tall with the label above (sidebar) but
//          only ~24px with the label inline-left (ribbon band). This single
//          flip is what makes labeled forms viable in the 92px band.

import React from "react";
import { useSurfaceLayout } from "../context";
import { FONT_FAMILY, GAP_SM, GAP_XS, LABEL_FONT_SIZE } from "../tokens";

// ============================================================================
// Field
// ============================================================================

export interface FieldProps {
  label: string;
  /** Forwarded to the label element for a11y when the control has an id. */
  htmlFor?: string;
  children: React.ReactNode;
}

const labelStyle: React.CSSProperties = {
  fontSize: LABEL_FONT_SIZE,
  opacity: 0.75,
  fontFamily: FONT_FAMILY,
  whiteSpace: "nowrap",
};

/**
 * A labeled control. Panel/popover: label above the control (~40px).
 * Band: label inline-left of the control on one compact row (~24px).
 */
export function Field({ label, htmlFor, children }: FieldProps): React.ReactElement {
  const layout = useSurfaceLayout();

  if (layout.container === "band") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: GAP_XS, minWidth: 0 }}>
        <label htmlFor={htmlFor} style={labelStyle}>
          {label}
        </label>
        <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <label htmlFor={htmlFor} style={{ ...labelStyle, marginBottom: 2 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ============================================================================
// FieldGrid
// ============================================================================

export interface FieldGridProps {
  /** Sidebar width (px) above which fields arrange in two columns. */
  twoColumnMinWidth?: number;
  children: React.ReactNode;
}

/**
 * A group of Fields. Band: one inline row of narrow labeled inputs
 * (`Cell [B1] From [0] To [10] Step [1]`). Panel: label-above fields stacked,
 * switching to a 2-column grid when the panel is wide enough.
 */
export function FieldGrid({
  twoColumnMinWidth = 260,
  children,
}: FieldGridProps): React.ReactElement {
  const layout = useSurfaceLayout();

  if (layout.container === "band") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: GAP_SM,
          minWidth: 0,
        }}
      >
        {children}
      </div>
    );
  }

  const twoCol = layout.width >= twoColumnMinWidth;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: twoCol ? "1fr 1fr" : "1fr",
        gap: GAP_SM,
      }}
    >
      {children}
    </div>
  );
}
