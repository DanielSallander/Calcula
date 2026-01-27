//! FILENAME: z_archive/addins/_disabled/formatting/shared/icons.tsx
// PURPOSE: SVG icon components used in the Home tab.
// CONTEXT: Contains alignment icons (left, center, right), wrap text, and rotation icons.

import React from "react";

/**
 * Left alignment icon - shows text lines aligned to the left edge.
 */
export function AlignLeftIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <rect x="1" y="2" width="12" height="2" fill="currentColor" />
      <rect x="1" y="6" width="8" height="2" fill="currentColor" />
      <rect x="1" y="10" width="10" height="2" fill="currentColor" />
    </svg>
  );
}

/**
 * Center alignment icon - shows text lines centered horizontally.
 */
export function AlignCenterIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <rect x="1" y="2" width="12" height="2" fill="currentColor" />
      <rect x="3" y="6" width="8" height="2" fill="currentColor" />
      <rect x="2" y="10" width="10" height="2" fill="currentColor" />
    </svg>
  );
}

/**
 * Right alignment icon - shows text lines aligned to the right edge.
 */
export function AlignRightIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <rect x="1" y="2" width="12" height="2" fill="currentColor" />
      <rect x="5" y="6" width="8" height="2" fill="currentColor" />
      <rect x="3" y="10" width="10" height="2" fill="currentColor" />
    </svg>
  );
}

/**
 * Wrap text icon - shows text wrapping within cell boundaries.
 */
export function WrapTextIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <path
        d="M1 2h12M1 5h12M1 8h8a2 2 0 0 1 0 4H7m0 0l1.5-1.5M7 12l1.5 1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Rotate text up icon (90 degrees counter-clockwise).
 */
export function RotateUpIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <path
        d="M7 11V3m0 0L4 6m3-3l3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x="1" y="12" fontSize="8" fill="currentColor" fontFamily="system-ui">
        A
      </text>
    </svg>
  );
}

/**
 * Rotate text down icon (270 degrees / 90 clockwise).
 */
export function RotateDownIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <path
        d="M7 3v8m0 0l-3-3m3 3l3-3"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x="1" y="7" fontSize="8" fill="currentColor" fontFamily="system-ui">
        A
      </text>
    </svg>
  );
}

/**
 * Undo icon - curved arrow pointing left
 */
export function UndoIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 7h7a3 3 0 1 1 0 6H8"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 4L3 7l3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Redo icon - curved arrow pointing right
 */
export function RedoIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M13 7H6a3 3 0 1 0 0 6h2"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 4l3 3-3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}