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
        borderRight: "1px solid #e0e0e0",
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
          fontSize: "11px",
          color: "#666",
          textAlign: "center",
          marginTop: "4px",
          paddingTop: "4px",
          borderTop: "1px solid #f0f0f0",
        }}
      >
        {label}
      </div>
    </div>
  );
}
