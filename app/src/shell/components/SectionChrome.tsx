//! FILENAME: app/src/shell/components/SectionChrome.tsx
// PURPOSE: The shared ribbon-group chrome: content above a 10px uppercase
//          label, with a 1px divider between groups.
// CONTEXT: One component instead of the chrome markup previously triplicated
//          across RibbonContainer's legacy group path, SectionRenderers and
//          the collapsed RibbonGroup. Launchers (demoted sections) render
//          inside the same chrome minus the bottom label (the launcher button
//          carries its own label), so inline and demoted cells align.

import React from "react";

export interface SectionChromeProps {
  /** Group label below the content; omit for launcher cells. */
  label?: string;
  isFirst: boolean;
  isLast: boolean;
  children: React.ReactNode;
}

export function SectionChrome({
  label,
  isFirst,
  isLast,
  children,
}: SectionChromeProps): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        borderRight: isLast ? "none" : "1px solid var(--border-default)",
        paddingLeft: isFirst ? "4px" : "10px",
        paddingRight: "10px",
        height: "100%",
        boxSizing: "border-box",
        minWidth: 0,
        flexShrink: 0,
      }}
    >
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
      {label !== undefined && (
        <div
          style={{
            fontSize: "10px",
            color: "var(--text-tertiary)",
            textAlign: "center",
            marginTop: "2px",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            fontWeight: 400,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
