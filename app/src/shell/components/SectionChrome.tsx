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
  /** Ref to the cell's root element — the ribbon renderer's real rendered-width
   *  probe attaches here (measures the actual cell, launcher or inline). */
  measureRef?: (el: HTMLDivElement | null) => void;
  children: React.ReactNode;
}

export function SectionChrome({
  label,
  isFirst,
  isLast,
  measureRef,
  children,
}: SectionChromeProps): React.ReactElement {
  return (
    <div
      ref={measureRef}
      data-section-cell=""
      style={{
        display: "flex",
        flexDirection: "column",
        // Inset divider (Excel-style): fades out toward top and bottom instead
        // of a full-height rule. Width stays 1px — CELL_CHROME_WIDTH depends on
        // this border contributing exactly 1px to the cell's chrome.
        borderRight: isLast ? "none" : "1px solid transparent",
        borderImage: isLast
          ? undefined
          : "linear-gradient(to bottom, transparent 8%, var(--border-default) 25%, var(--border-default) 75%, transparent 92%) 1",
        paddingLeft: isFirst ? "4px" : "10px",
        paddingRight: "10px",
        height: "100%",
        boxSizing: "border-box",
        minWidth: 0,
        flexShrink: 0,
      }}
    >
      {/* Center section content vertically in the band so single-row sections
          don't hug the top edge; full-height children still stretch. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        {children}
      </div>
      {label !== undefined && (
        <div
          style={{
            fontSize: "10.5px",
            color: "var(--text-tertiary)",
            textAlign: "center",
            marginTop: "2px",
            fontWeight: 400,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
