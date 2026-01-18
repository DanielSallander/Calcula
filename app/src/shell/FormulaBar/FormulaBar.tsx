// FILENAME: shell/FormulaBar/FormulaBar.tsx
// PURPOSE: Formula bar container with Name Box and formula input area
// CONTEXT: Positioned between Ribbon and Spreadsheet grid

import React from "react";
import { NameBox } from "./NameBox";

export function FormulaBar(): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: "28px",
        borderBottom: "1px solid #d0d0d0",
        backgroundColor: "#f3f3f3",
        padding: "0 4px",
        gap: "4px",
      }}
    >
      {/* Name Box */}
      <NameBox />

      {/* fx label */}
      <div
        style={{
          padding: "0 8px",
          fontSize: "12px",
          fontStyle: "italic",
          color: "#666666",
          borderLeft: "1px solid #c0c0c0",
          borderRight: "1px solid #c0c0c0",
          height: "100%",
          display: "flex",
          alignItems: "center",
        }}
      >
        fx
      </div>

      {/* Formula input area (placeholder for future implementation) */}
      <div
        style={{
          flex: 1,
          height: "22px",
          backgroundColor: "#ffffff",
          border: "1px solid #c0c0c0",
        }}
      />
    </div>
  );
}