// FILENAME: app/extensions/ModelEditor/components/treeKit.tsx
// PURPOSE: Shared visual kit for folder-style trees across Model Editor
//          sections (Measures today; any section that grows a folder-like
//          structure should use these same pieces so every tree reads the
//          same): a minimalistic outline folder icon, a chevron, and the
//          compact row styles.

import React from "react";

/** Minimalistic outline folder (stroke-only, rounded, tab top-left). Inherits
 *  the text color via currentColor. */
export function FolderIcon({ size = 14 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ flexShrink: 0, display: "block" }}
      aria-hidden
    >
      <path
        d="M1.75 5.5 V4.75 C1.75 3.92 2.42 3.25 3.25 3.25 H5.69 C6.09 3.25 6.47 3.41 6.75 3.69 L7.66 4.6 C7.85 4.79 8.1 4.89 8.37 4.89 H12.75 C13.58 4.89 14.25 5.56 14.25 6.39 V11.25 C14.25 12.08 13.58 12.75 12.75 12.75 H3.25 C2.42 12.75 1.75 12.08 1.75 11.25 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Fixed-width expand/collapse chevron, so rows with and without one align. */
export function Chevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <span style={{ width: 12, flexShrink: 0, color: "#888", fontSize: 11, lineHeight: 1 }}>
      {open ? "▾" : "▸"}
    </span>
  );
}

/** Pixels of indentation per tree nesting level. */
export const TREE_INDENT = 16;

export const treeStyles = {
  /** A folder header row: chevron + FolderIcon + name (+ count on the right). */
  folderRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 6px",
    cursor: "pointer",
    fontWeight: 600,
    color: "#444",
    borderRadius: 3,
    userSelect: "none",
  },
  /** A leaf row: kind glyph + name (+ muted detail), single compact line. */
  leafRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "2px 6px",
    borderRadius: 3,
    cursor: "pointer",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  /** A selectable single-line list row (sections without folders). */
  itemRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "3px 8px",
    borderRadius: 3,
    cursor: "pointer",
    overflow: "hidden",
  },
  /** A row's primary name: keeps a readable minimum but truncates instead of
   *  crushing its siblings to zero width. */
  itemName: {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flexShrink: 1,
    minWidth: 60,
  },
} satisfies Record<string, React.CSSProperties>;
