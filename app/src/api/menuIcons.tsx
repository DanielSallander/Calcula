//! FILENAME: app/src/api/menuIcons.tsx
// PURPOSE: Shared SVG icon components for menu items.
// CONTEXT: Extensions import these to add visual icons to menu items.

import React from "react";

const iconStyle: React.CSSProperties = { display: "block" };
const stroke = "currentColor";
const fill = "none";

/** Arrow pointing toward a cell (Trace Precedents) */
export const IconTracePrecedents = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <line x1="2" y1="8" x2="11" y2="8" />
    <polyline points="8,5 11,8 8,11" />
    <rect x="12" y="5" width="3" height="6" rx="0.5" fill={stroke} stroke="none" />
  </svg>
);

/** Arrow pointing away from a cell (Trace Dependents) */
export const IconTraceDependents = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <rect x="1" y="5" width="3" height="6" rx="0.5" fill={stroke} stroke="none" />
    <line x1="5" y1="8" x2="14" y2="8" />
    <polyline points="11,5 14,8 11,11" />
  </svg>
);

/** X mark (Remove Arrows) */
export const IconRemoveArrows = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <line x1="4" y1="4" x2="12" y2="12" />
    <line x1="12" y1="4" x2="4" y2="12" />
  </svg>
);

/** Tag / label (Name Manager) */
export const IconNameManager = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <path d="M2 3h7l5 5-5 5H2V3z" />
    <circle cx="5.5" cy="8" r="1" fill={stroke} stroke="none" />
  </svg>
);

/** fx symbol (Evaluate Formula) */
export const IconEvaluateFormula = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <text x="1" y="12.5" fontSize="11" fontWeight="600" fontStyle="italic" fill={stroke} stroke="none" fontFamily="serif">fx</text>
  </svg>
);

/** Tree diagram (Visualize Formula) */
export const IconVisualizeFormula = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <circle cx="8" cy="3" r="2" />
    <circle cx="4" cy="13" r="2" />
    <circle cx="12" cy="13" r="2" />
    <line x1="8" y1="5" x2="4" y2="11" />
    <line x1="8" y1="5" x2="12" y2="11" />
  </svg>
);

/** Gear / cog (Calculation Options) */
export const IconCalcOptions = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <circle cx="8" cy="8" r="2.5" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </svg>
);

/** Calculator (Calculate) */
export const IconCalculate = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" />
    <rect x="4" y="3" width="8" height="3" rx="0.5" fill={stroke} stroke="none" opacity="0.3" />
    <circle cx="5.5" cy="9" r="0.8" fill={stroke} stroke="none" />
    <circle cx="8" cy="9" r="0.8" fill={stroke} stroke="none" />
    <circle cx="10.5" cy="9" r="0.8" fill={stroke} stroke="none" />
    <circle cx="5.5" cy="12" r="0.8" fill={stroke} stroke="none" />
    <circle cx="8" cy="12" r="0.8" fill={stroke} stroke="none" />
    <circle cx="10.5" cy="12" r="0.8" fill={stroke} stroke="none" />
  </svg>
);

/** Plus / new item (Define Name) */
export const IconDefineName = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <line x1="8" y1="3" x2="8" y2="13" />
    <line x1="3" y1="8" x2="13" y2="8" />
  </svg>
);

/** Lambda / function symbol (Define Function) */
export const IconDefineFunction = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <path d="M4 13L7 3" />
    <path d="M5 8h5" />
    <path d="M9 5l3 8" />
  </svg>
);

/** Lightning bolt (Automatic calculation) */
export const IconAutomatic = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <polygon points="9,1 4,9 8,9 7,15 12,7 8,7" fill={stroke} stroke="none" />
  </svg>
);

/** Hand / pause (Manual calculation) */
export const IconManual = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <rect x="4" y="3" width="3" height="10" rx="1" />
    <rect x="9" y="3" width="3" height="10" rx="1" />
  </svg>
);

/** Single sheet / page (Calculate Worksheet) */
export const IconCalcWorksheet = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M4 2h6l3 3v9H4V2z" />
    <polyline points="10,2 10,5 13,5" />
  </svg>
);

/** Multiple sheets / book (Calculate Workbook) */
export const IconCalcWorkbook = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M6 2h6l2 2v8H6V2z" />
    <polyline points="12,2 12,4 14,4" />
    <path d="M4 4H3v10h8v-1" />
  </svg>
);

// ============================================================================
// Review Menu Icons
// ============================================================================

/** Shield (Protect Sheet) */
export const IconProtectSheet = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <path d="M8 1.5L2.5 4v4c0 3.5 2.5 5.5 5.5 6.5 3-1 5.5-3 5.5-6.5V4L8 1.5z" />
  </svg>
);

/** Shield with lock (Protect Workbook) */
export const IconProtectWorkbook = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <path d="M8 1.5L2.5 4v4c0 3.5 2.5 5.5 5.5 6.5 3-1 5.5-3 5.5-6.5V4L8 1.5z" />
    <rect x="6" y="7.5" width="4" height="3" rx="0.5" />
    <path d="M7 7.5V6.5a1 1 0 0 1 2 0v1" />
  </svg>
);

/** Cell with shield (Cell Protection) */
export const IconCellProtection = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="1.5" y="2" width="13" height="12" rx="1" />
    <line x1="1.5" y1="6" x2="14.5" y2="6" />
    <line x1="6" y1="2" x2="6" y2="14" />
    <circle cx="10.5" cy="10" r="2.5" fill="var(--menu-dropdown-bg, #2b2b2b)" stroke={stroke} />
    <line x1="10.5" y1="9" x2="10.5" y2="11" />
    <line x1="10.5" y1="11" x2="10.5" y2="11" strokeLinecap="round" />
  </svg>
);

/** Speech bubble (New Comment) */
export const IconNewComment = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <path d="M2 2.5h12v8.5H6l-3 2.5V11H2V2.5z" />
    <line x1="5" y1="5.5" x2="11" y2="5.5" />
    <line x1="5" y1="8" x2="9" y2="8" />
  </svg>
);

/** Sticky note (New Note) */
export const IconNewNote = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <path d="M2.5 2h11v9l-3.5 3.5H2.5V2z" />
    <path d="M10 11v3.5L13.5 11H10z" />
  </svg>
);

/** Multiple speech bubbles (Show All Comments) */
export const IconShowAllComments = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M1.5 2h10v7H5.5l-2.5 2V9H1.5V2z" />
    <path d="M5 9.5h6.5v4.5H10l-1.5 1.5V14h-2" />
  </svg>
);

/** Multiple notes (Show All Notes) */
export const IconShowAllNotes = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M2 1.5h9v7.5l-2.5 2.5H2V1.5z" />
    <path d="M8.5 9v2.5L11 9H8.5z" />
    <path d="M5.5 12H13v-7" />
  </svg>
);

/** Trash / delete (Delete All Comments/Notes) */
export const IconDeleteAll = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M3 4.5h10l-.8 9H3.8L3 4.5z" />
    <line x1="2" y1="4.5" x2="14" y2="4.5" />
    <path d="M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" />
    <line x1="6.5" y1="7" x2="6.5" y2="11.5" />
    <line x1="9.5" y1="7" x2="9.5" y2="11.5" />
  </svg>
);
