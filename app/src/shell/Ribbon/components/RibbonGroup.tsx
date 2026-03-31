//! FILENAME: app/src/shell/Ribbon/components/RibbonGroup.tsx
// PURPOSE: Container component for a group of ribbon controls.
// CONTEXT: Used by add-ins to group related controls together.

import React from "react";

export interface RibbonGroupProps {
  /** Group label (shown at bottom) */
  label: string;
  /** Child controls */
  children: React.ReactNode;
}

export function RibbonGroup({ label, children }: RibbonGroupProps): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid #e5e5e5",
        paddingRight: "12px",
        marginRight: "12px",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "4px",
          alignItems: "flex-start",
          flex: 1,
        }}
      >
        {children}
      </div>
      <div
        style={{
          fontSize: "10px",
          color: "#999",
          textAlign: "center",
          marginTop: "4px",
          paddingTop: "4px",
          textTransform: "uppercase" as const,
          letterSpacing: "0.5px",
          fontWeight: 400,
        }}
      >
        {label}
      </div>
    </div>
  );
}
