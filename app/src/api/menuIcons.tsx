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

// ============================================================================
// File Menu Icons
// ============================================================================

/** Blank page (New) */
export const IconNew = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M4 1h6l4 4v10H4V1z" />
    <path d="M10 1v4h4" />
  </svg>
);

/** Open folder (Open) */
export const IconOpen = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M2 3h4l2 2h6v9H2V3z" />
    <path d="M2 7h12l-1.5 7H3.5L2 7z" />
  </svg>
);

/** Floppy disk (Save) */
export const IconSave = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M2 1h10l2 2v11H2V1z" />
    <rect x="4" y="1" width="6" height="5" rx="0.5" />
    <rect x="4" y="9" width="8" height="5" rx="0.5" />
    <line x1="8.5" y1="1" x2="8.5" y2="5.5" />
  </svg>
);

/** Floppy disk with pencil (Save As) */
export const IconSaveAs = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M2 1h10l2 2v11H2V1z" opacity="0.6" />
    <rect x="4" y="1" width="6" height="5" rx="0.5" opacity="0.6" />
    <rect x="4" y="9" width="8" height="5" rx="0.5" opacity="0.6" />
    <path d="M10 8l4-4 1.5 1.5-4 4H10V8z" fill={stroke} stroke="none" />
  </svg>
);

// ============================================================================
// Insert Menu Icons
// ============================================================================

/** Grid table (Insert Table) */
export const IconInsertTable = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="1" width="14" height="14" rx="1.5" />
    <line x1="1" y1="5" x2="15" y2="5" />
    <line x1="1" y1="9" x2="15" y2="9" />
    <line x1="5.5" y1="1" x2="5.5" y2="15" />
    <line x1="10.5" y1="1" x2="10.5" y2="15" />
  </svg>
);

/** Pivot arrows (Insert PivotTable) */
export const IconInsertPivot = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="1" width="14" height="14" rx="1" />
    <line x1="1" y1="5" x2="15" y2="5" />
    <line x1="5" y1="1" x2="5" y2="15" />
    <polyline points="8,8 11,8" strokeWidth="1.5" />
    <polyline points="8,8 8,11" strokeWidth="1.5" />
    <polyline points="10,7 11,8 10,9" strokeWidth="1" />
    <polyline points="7,10 8,11 9,10" strokeWidth="1" />
  </svg>
);

/** Filter card (Insert Slicer) */
export const IconInsertSlicer = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="1" width="12" height="14" rx="1.5" />
    <line x1="2" y1="4.5" x2="14" y2="4.5" />
    <rect x="4" y="6.5" width="8" height="2" rx="0.5" fill={stroke} stroke="none" opacity="0.3" />
    <rect x="4" y="9.5" width="8" height="2" rx="0.5" />
    <rect x="4" y="12.5" width="8" height="1" rx="0.5" fill={stroke} stroke="none" opacity="0.3" />
  </svg>
);

/** Bar chart (Insert Chart) */
export const IconInsertChart = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="8" width="3" height="6" rx="0.5" fill={stroke} stroke="none" opacity="0.6" />
    <rect x="6.5" y="4" width="3" height="10" rx="0.5" fill={stroke} stroke="none" opacity="0.8" />
    <rect x="11" y="6" width="3" height="8" rx="0.5" fill={stroke} stroke="none" />
    <line x1="1" y1="14.5" x2="15" y2="14.5" />
  </svg>
);

/** Bookmark flag (Bookmarks submenu) */
export const IconBookmarks = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M4 1h8v14l-4-3-4 3V1z" />
  </svg>
);

/** Bookmark + (Add Bookmark) */
export const IconBookmarkAdd = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M3 1h7v14l-3.5-2.5L3 15V1z" opacity="0.6" />
    <line x1="12" y1="3" x2="12" y2="9" strokeWidth="1.5" />
    <line x1="9" y1="6" x2="15" y2="6" strokeWidth="1.5" />
  </svg>
);

/** Bookmark - (Remove Bookmark) */
export const IconBookmarkRemove = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M3 1h7v14l-3.5-2.5L3 15V1z" opacity="0.6" />
    <line x1="9" y1="6" x2="15" y2="6" strokeWidth="1.8" />
  </svg>
);

/** Arrow right (Next) */
export const IconNext = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <line x1="2" y1="8" x2="13" y2="8" strokeLinecap="round" />
    <polyline points="9,4 13,8 9,12" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Arrow left (Previous) */
export const IconPrev = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <line x1="14" y1="8" x2="3" y2="8" strokeLinecap="round" />
    <polyline points="7,4 3,8 7,12" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ============================================================================
// Format Menu Icons
// ============================================================================

/** Cell with format lines (Format Cells) */
export const IconFormatCells = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1.5" />
    <line x1="4" y1="5.5" x2="12" y2="5.5" strokeWidth="1" />
    <line x1="4" y1="8" x2="12" y2="8" strokeWidth="1" />
    <line x1="4" y1="10.5" x2="9" y2="10.5" strokeWidth="1" />
  </svg>
);

/** Paint palette (Cell Styles) */
export const IconCellStyles = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M8 1a7 7 0 0 0-1 13.9c1 .2 1-.4 1-1v-.5c-4 .8-5-2-5-2-.7-1.7-1.6-2.2-1.6-2.2-1.3-.9.1-.9.1-.9 1.4.1 2.2 1.5 2.2 1.5 1.3 2.2 3.3 1.5 4.1 1.2.1-.9.5-1.5.9-1.9-3.2-.4-6.6-1.6-6.6-7.2 0-1.6.6-2.9 1.5-3.9-.1-.4-.7-1.8.2-3.8 0 0 1.2-.4 4 1.5a13.5 13.5 0 0 1 7.2 0c2.8-1.9 4-1.5 4-1.5.8 2 .3 3.4.2 3.8.9 1 1.5 2.3 1.5 3.9 0 5.6-3.4 6.8-6.6 7.2" />
  </svg>
);

/** Conditional rules (Conditional Formatting) */
export const IconConditionalFormatting = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="4" rx="0.5" fill={stroke} stroke="none" opacity="0.3" />
    <rect x="1" y="7" width="14" height="4" rx="0.5" fill={stroke} stroke="none" opacity="0.6" />
    <rect x="1" y="12" width="8" height="3" rx="0.5" fill={stroke} stroke="none" opacity="0.9" />
  </svg>
);

// ============================================================================
// External Data Menu Icons
// ============================================================================

/** Database with arrow (Get Data) */
export const IconGetData = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <ellipse cx="8" cy="3.5" rx="6" ry="2.5" />
    <path d="M2 3.5v9c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-9" />
    <ellipse cx="8" cy="8" rx="6" ry="2.5" opacity="0.3" />
  </svg>
);

/** CSV file (From CSV) */
export const IconFromCsv = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.1" style={iconStyle}>
    <path d="M3 1h7l4 4v10H3V1z" />
    <path d="M10 1v4h4" />
    <text x="5" y="12.5" fontSize="5" fontWeight="700" fill={stroke} stroke="none" fontFamily="sans-serif">CSV</text>
  </svg>
);

/** Arrow up from box (Export) */
export const IconExport = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M3 8v6h10V8" />
    <line x1="8" y1="10" x2="8" y2="2" strokeLinecap="round" />
    <polyline points="5,4.5 8,2 11,4.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Arrow down into box (Import) */
export const IconImport = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M3 8v6h10V8" />
    <line x1="8" y1="2" x2="8" y2="10" strokeLinecap="round" />
    <polyline points="5,7.5 8,10 11,7.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Plug (Connections) */
export const IconConnections = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <line x1="4" y1="2" x2="4" y2="6" strokeLinecap="round" />
    <line x1="8" y1="2" x2="8" y2="6" strokeLinecap="round" />
    <rect x="2" y="6" width="8" height="3" rx="1" />
    <line x1="6" y1="9" x2="6" y2="14" strokeLinecap="round" />
  </svg>
);

// ============================================================================
// Edit Menu Icons
// ============================================================================

/** Curved arrow back (Undo) */
export const IconUndo = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <path d="M4 6h7a3.5 3.5 0 0 1 0 7H8" strokeLinecap="round" />
    <polyline points="6.5,3.5 4,6 6.5,8.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Curved arrow forward (Redo) */
export const IconRedo = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <path d="M12 6H5a3.5 3.5 0 0 0 0 7h3" strokeLinecap="round" />
    <polyline points="9.5,3.5 12,6 9.5,8.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Scissors (Cut) */
export const IconCut = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <circle cx="4.5" cy="4" r="2.5" />
    <circle cx="4.5" cy="12" r="2.5" />
    <line x1="6.5" y1="5.5" x2="14" y2="12" strokeLinecap="round" />
    <line x1="6.5" y1="10.5" x2="14" y2="4" strokeLinecap="round" />
  </svg>
);

/** Two overlapping pages (Copy) */
export const IconCopy = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="5" y="4" width="9" height="11" rx="1" />
    <path d="M11 4V2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h2" />
  </svg>
);

/** Clipboard (Paste) */
export const IconPaste = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="3" y="3" width="10" height="12" rx="1" />
    <rect x="5.5" y="1" width="5" height="3" rx="1" />
    <line x1="5.5" y1="8" x2="10.5" y2="8" strokeWidth="1" />
    <line x1="5.5" y1="10.5" x2="10.5" y2="10.5" strokeWidth="1" />
    <line x1="5.5" y1="13" x2="8.5" y2="13" strokeWidth="1" />
  </svg>
);

/** Eraser (Clear) */
export const IconClear = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M8.5 2.5l5 5-6 6H3l-1-1 4.5-4.5" />
    <line x1="6" y1="8" x2="11" y2="3" />
    <line x1="2" y1="13.5" x2="14" y2="13.5" strokeWidth="1" />
  </svg>
);

/** Down-right arrow (Fill) */
export const IconFill = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M3 3v5h5" />
    <line x1="3" y1="8" x2="13" y2="8" />
    <polyline points="10.5,5.5 13,8 10.5,10.5" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="8" y1="3" x2="8" y2="13" />
    <polyline points="5.5,10.5 8,13 10.5,10.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Magnifying glass (Find) */
export const IconFind = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <circle cx="6.5" cy="6.5" r="4.5" />
    <line x1="10" y1="10" x2="14.5" y2="14.5" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

/** Magnifying glass with pencil (Replace) */
export const IconReplace = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <circle cx="6" cy="6" r="4" />
    <line x1="9" y1="9" x2="11" y2="11" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M11 11l3.5-3.5 1 1-3.5 3.5H11V11z" fill={stroke} stroke="none" opacity="0.8" />
  </svg>
);

/** Two cells merging (Merge Cells) */
export const IconMergeCells = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="4" width="14" height="8" rx="1" />
    <polyline points="5,6.5 8,8 5,9.5" fill={stroke} stroke="none" />
    <polyline points="11,6.5 8,8 11,9.5" fill={stroke} stroke="none" />
  </svg>
);

/** Two cells splitting (Unmerge Cells) */
export const IconUnmergeCells = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="4" width="6" height="8" rx="1" />
    <rect x="9" y="4" width="6" height="8" rx="1" />
    <polyline points="5.5,6.5 3,8 5.5,9.5" fill={stroke} stroke="none" />
    <polyline points="10.5,6.5 13,8 10.5,9.5" fill={stroke} stroke="none" />
  </svg>
);

/** Paint roller (Format Painter) */
export const IconFormatPainter = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="1.5" width="11" height="5" rx="1" />
    <rect x="4" y="6.5" width="3" height="2" fill={stroke} stroke="none" />
    <line x1="5.5" y1="8.5" x2="5.5" y2="11" />
    <rect x="4" y="11" width="3" height="3.5" rx="0.5" />
  </svg>
);

/** List with bullet (Custom Lists) */
export const IconCustomLists = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <circle cx="3" cy="3.5" r="1.2" fill={stroke} stroke="none" />
    <circle cx="3" cy="8" r="1.2" fill={stroke} stroke="none" />
    <circle cx="3" cy="12.5" r="1.2" fill={stroke} stroke="none" />
    <line x1="6" y1="3.5" x2="14" y2="3.5" />
    <line x1="6" y1="8" x2="14" y2="8" />
    <line x1="6" y1="12.5" x2="14" y2="12.5" />
  </svg>
);

// ============================================================================
// View Menu Icons
// ============================================================================

/** Monitor / screen (Normal View) */
export const IconNormalView = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="1" y="2" width="14" height="10" rx="1.5" />
    <line x1="5" y1="14" x2="11" y2="14" />
    <line x1="8" y1="12" x2="8" y2="14" />
  </svg>
);

/** Page with layout lines (Page Layout View) */
export const IconPageLayoutView = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="1" width="12" height="14" rx="1" />
    <line x1="4" y1="4" x2="12" y2="4" />
    <line x1="4" y1="7" x2="12" y2="7" />
    <line x1="4" y1="10" x2="9" y2="10" />
  </svg>
);

/** Dashed page grid (Page Break Preview) */
export const IconPageBreakPreview = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="1" width="14" height="14" rx="1" />
    <line x1="1" y1="8" x2="15" y2="8" strokeDasharray="2 2" />
    <line x1="8" y1="1" x2="8" y2="15" strokeDasharray="2 2" />
  </svg>
);

/** Sidebar panel (Sidebar submenu) */
export const IconSidebar = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1.5" />
    <line x1="5.5" y1="2" x2="5.5" y2="14" />
    <line x1="2.5" y1="5.5" x2="4.5" y2="5.5" strokeWidth="1" />
    <line x1="2.5" y1="8" x2="4.5" y2="8" strokeWidth="1" />
    <line x1="2.5" y1="10.5" x2="4.5" y2="10.5" strokeWidth="1" />
  </svg>
);

/** Right panel (Panels submenu) */
export const IconPanels = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1.5" />
    <line x1="10.5" y1="2" x2="10.5" y2="14" />
  </svg>
);

/** Snowflake / pin (Freeze Panes submenu) */
export const IconFreezePanes = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <line x1="8" y1="1" x2="8" y2="15" />
    <line x1="1" y1="8" x2="15" y2="8" />
    <line x1="3" y1="3" x2="13" y2="13" strokeWidth="0.8" />
    <line x1="13" y1="3" x2="3" y2="13" strokeWidth="0.8" />
    <line x1="6" y1="2.5" x2="8" y2="4.5" strokeWidth="0.8" />
    <line x1="10" y1="2.5" x2="8" y2="4.5" strokeWidth="0.8" />
    <line x1="6" y1="13.5" x2="8" y2="11.5" strokeWidth="0.8" />
    <line x1="10" y1="13.5" x2="8" y2="11.5" strokeWidth="0.8" />
  </svg>
);

/** Horizontal split (Freeze Top Row) */
export const IconFreezeRow = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1" />
    <line x1="1" y1="6" x2="15" y2="6" strokeWidth="2" />
  </svg>
);

/** Vertical split (Freeze First Column) */
export const IconFreezeCol = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1" />
    <line x1="5" y1="2" x2="5" y2="14" strokeWidth="2" />
  </svg>
);

/** Cross split (Freeze Both) */
export const IconFreezeBoth = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1" />
    <line x1="1" y1="6" x2="15" y2="6" strokeWidth="2" />
    <line x1="5" y1="2" x2="5" y2="14" strokeWidth="2" />
  </svg>
);

/** Broken ice (Unfreeze Panes) */
export const IconUnfreeze = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1" />
    <line x1="1" y1="6" x2="15" y2="6" strokeDasharray="2 2" opacity="0.5" />
    <line x1="5" y1="2" x2="5" y2="14" strokeDasharray="2 2" opacity="0.5" />
  </svg>
);

/** Two-pane split (Split Window) */
export const IconSplitWindow = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1.5" />
    <line x1="1" y1="8" x2="15" y2="8" />
    <line x1="8" y1="2" x2="8" y2="14" />
  </svg>
);

/** Magnifying glass with arrow (Go To Special) */
export const IconGoToSpecial = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <circle cx="6.5" cy="6.5" r="4.5" />
    <line x1="10" y1="10" x2="14" y2="14" strokeWidth="2" strokeLinecap="round" />
    <polyline points="5,6.5 7,8.5 9,4.5" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** fx= (Show Formulas) */
export const IconShowFormulas = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1" />
    <text x="4" y="11" fontSize="7" fontWeight="600" fontStyle="italic" fill={stroke} stroke="none" fontFamily="serif">fx</text>
  </svg>
);

/** 0 with slash (Display Zeros toggle) */
export const IconDisplayZeros = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1" />
    <text x="8" y="11.5" fontSize="9" fontWeight="600" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">0</text>
  </svg>
);

/** Dashed line between pages (Page Breaks submenu) */
export const IconPageBreaks = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="1" width="12" height="5.5" rx="0.5" />
    <rect x="2" y="9.5" width="12" height="5.5" rx="0.5" />
    <line x1="1" y1="8" x2="15" y2="8" strokeDasharray="2.5 2" strokeWidth="1.5" />
  </svg>
);

/** Page break + (Insert Page Break) */
export const IconInsertPageBreak = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="1" width="12" height="5" rx="0.5" />
    <rect x="2" y="10" width="12" height="5" rx="0.5" />
    <line x1="1" y1="8" x2="15" y2="8" strokeDasharray="2 2" />
    <line x1="11" y1="5.5" x2="11" y2="10.5" strokeWidth="1.5" />
    <line x1="8.5" y1="8" x2="13.5" y2="8" strokeWidth="1.5" />
  </svg>
);

/** Page break - (Remove Page Break) */
export const IconRemovePageBreak = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="1" width="12" height="5" rx="0.5" />
    <rect x="2" y="10" width="12" height="5" rx="0.5" />
    <line x1="1" y1="8" x2="15" y2="8" strokeDasharray="2 2" opacity="0.5" />
    <line x1="9" y1="8" x2="14" y2="8" strokeWidth="1.8" />
  </svg>
);

/** Page break X (Reset All Page Breaks) */
export const IconResetPageBreaks = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="1" width="12" height="5" rx="0.5" />
    <rect x="2" y="10" width="12" height="5" rx="0.5" />
    <line x1="1" y1="8" x2="15" y2="8" strokeDasharray="2 2" opacity="0.5" />
    <line x1="9.5" y1="6" x2="13.5" y2="10" strokeWidth="1.6" />
    <line x1="13.5" y1="6" x2="9.5" y2="10" strokeWidth="1.6" />
  </svg>
);

/** Dotted rectangle (Print Area submenu) */
export const IconPrintArea = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="2" y="2" width="12" height="12" rx="1" strokeDasharray="3 2" />
    <line x1="5" y1="6" x2="11" y2="6" strokeWidth="1" />
    <line x1="5" y1="8.5" x2="11" y2="8.5" strokeWidth="1" />
    <line x1="5" y1="11" x2="8" y2="11" strokeWidth="1" />
  </svg>
);

/** Gear (Other Options) */
export const IconOtherOptions = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <circle cx="8" cy="8" r="2.5" />
    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4" strokeLinecap="round" />
  </svg>
);

// ============================================================================
// Data Menu Icons
// ============================================================================

/** Funnel (Filter) */
export const IconFilter = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M1.5 2.5h13l-4.5 5v4.5l-4 2V7.5L1.5 2.5z" />
  </svg>
);

/** Funnel with X (Clear Filter) */
export const IconClearFilter = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M1.5 2.5h13l-4.5 5v4.5l-4 2V7.5L1.5 2.5z" opacity="0.5" />
    <line x1="10" y1="9" x2="15" y2="14" strokeWidth="1.8" />
    <line x1="15" y1="9" x2="10" y2="14" strokeWidth="1.8" />
  </svg>
);

/** Funnel with circular arrow (Reapply) */
export const IconReapply = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M1.5 2.5h13l-4.5 5v4.5l-4 2V7.5L1.5 2.5z" opacity="0.5" />
    <path d="M11 10a3 3 0 1 1-.5-1.7" strokeWidth="1.4" />
    <polyline points="13,8.3 10.5,8.3 10.5,10.8" strokeWidth="1.2" />
  </svg>
);

/** A-Z with down arrow (Sort Ascending) */
export const IconSortAZ = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1" style={iconStyle}>
    <text x="0.5" y="7" fontSize="6" fontWeight="600" fill={stroke} stroke="none" fontFamily="sans-serif">A</text>
    <text x="0.5" y="14" fontSize="6" fontWeight="600" fill={stroke} stroke="none" fontFamily="sans-serif">Z</text>
    <line x1="12" y1="2" x2="12" y2="13" strokeWidth="1.5" />
    <polyline points="9.5,10.5 12,13 14.5,10.5" strokeWidth="1.5" fill="none" />
  </svg>
);

/** Z-A with down arrow (Sort Descending) */
export const IconSortZA = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1" style={iconStyle}>
    <text x="0.5" y="7" fontSize="6" fontWeight="600" fill={stroke} stroke="none" fontFamily="sans-serif">Z</text>
    <text x="0.5" y="14" fontSize="6" fontWeight="600" fill={stroke} stroke="none" fontFamily="sans-serif">A</text>
    <line x1="12" y1="2" x2="12" y2="13" strokeWidth="1.5" />
    <polyline points="9.5,10.5 12,13 14.5,10.5" strokeWidth="1.5" fill="none" />
  </svg>
);

/** Sort lines with gear (Custom Sort) */
export const IconCustomSort = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <line x1="2" y1="3" x2="10" y2="3" />
    <line x1="2" y1="6.5" x2="8" y2="6.5" />
    <line x1="2" y1="10" x2="6" y2="10" />
    <circle cx="12" cy="11" r="2.5" strokeWidth="1.2" />
    <line x1="12" y1="8" x2="12" y2="8.5" strokeWidth="1.2" />
    <line x1="12" y1="13.5" x2="12" y2="14" strokeWidth="1.2" />
    <line x1="9" y1="11" x2="9.5" y2="11" strokeWidth="1.2" />
    <line x1="14.5" y1="11" x2="15" y2="11" strokeWidth="1.2" />
  </svg>
);

/** Overlapping squares with X (Remove Duplicates) */
export const IconRemoveDuplicates = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="3" width="8" height="8" rx="1" />
    <rect x="5" y="1" width="8" height="8" rx="1" opacity="0.5" />
    <line x1="10" y1="10" x2="14.5" y2="14.5" strokeWidth="1.6" />
    <line x1="14.5" y1="10" x2="10" y2="14.5" strokeWidth="1.6" />
  </svg>
);

/** Column split (Text to Columns) */
export const IconTextToColumns = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="3" rx="0.5" />
    <rect x="1" y="7" width="6" height="3" rx="0.5" />
    <rect x="9" y="7" width="6" height="3" rx="0.5" />
    <rect x="1" y="12" width="6" height="3" rx="0.5" />
    <rect x="9" y="12" width="6" height="3" rx="0.5" />
  </svg>
);

/** Lightning bolt (Flash Fill) */
export const IconFlashFill = (
  <svg viewBox="0 0 16 16" fill={stroke} stroke="none" style={iconStyle}>
    <path d="M9 1L4 9h3.5L6 15l6-8H8.5L9 1z" />
  </svg>
);

/** Funnel with star (Advanced Filter) */
export const IconAdvancedFilter = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M1.5 2.5h13l-4.5 5v4.5l-4 2V7.5L1.5 2.5z" opacity="0.5" />
    <path d="M12.5 1l.8 1.8 1.9.3-1.4 1.3.3 1.9-1.6-.9-1.6.9.3-1.9-1.4-1.3 1.9-.3z" fill={stroke} stroke="none" />
  </svg>
);

/** Checkmark in shield (Validation submenu) */
export const IconValidation = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M8 1L2 4v4c0 3.5 2.5 6.5 6 7.5 3.5-1 6-4 6-7.5V4L8 1z" />
    <polyline points="5,8 7.5,10.5 11,5.5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Checkmark in cell (Data Validation dialog) */
export const IconDataValidation = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1.5" />
    <polyline points="4.5,8 7,10.5 11.5,5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Circle with exclamation (Circle Invalid Data) */
export const IconCircleInvalid = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <circle cx="8" cy="8" r="6.5" />
    <line x1="8" y1="4.5" x2="8" y2="9" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="8" cy="11.5" r="0.8" fill={stroke} stroke="none" />
  </svg>
);

/** Circle with X (Clear Validation Circles) */
export const IconClearCircles = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <circle cx="8" cy="8" r="6.5" opacity="0.5" />
    <line x1="5.5" y1="5.5" x2="10.5" y2="10.5" strokeWidth="1.8" />
    <line x1="10.5" y1="5.5" x2="5.5" y2="10.5" strokeWidth="1.8" />
  </svg>
);

/** Branch with question mark (What-If Analysis submenu) */
export const IconWhatIfAnalysis = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M3 12V4h4" />
    <path d="M3 8h3" />
    <circle cx="10" cy="4" r="2" />
    <circle cx="10" cy="8" r="2" />
    <circle cx="10" cy="12" r="2" />
  </svg>
);

/** Target / crosshair (Goal Seek) */
export const IconGoalSeek = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <circle cx="8" cy="8" r="6" />
    <circle cx="8" cy="8" r="3" />
    <circle cx="8" cy="8" r="0.8" fill={stroke} stroke="none" />
    <line x1="8" y1="1" x2="8" y2="3.5" />
    <line x1="8" y1="12.5" x2="8" y2="15" />
    <line x1="1" y1="8" x2="3.5" y2="8" />
    <line x1="12.5" y1="8" x2="15" y2="8" />
  </svg>
);

/** Branching paths (Scenario Manager) */
export const IconScenarioManager = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <circle cx="3" cy="8" r="2" />
    <circle cx="13" cy="3" r="2" />
    <circle cx="13" cy="8" r="2" />
    <circle cx="13" cy="13" r="2" />
    <line x1="5" y1="8" x2="11" y2="3" />
    <line x1="5" y1="8" x2="11" y2="8" />
    <line x1="5" y1="8" x2="11" y2="13" />
  </svg>
);

/** Grid with question mark (What-If Data Table) */
export const IconDataTable = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="1" width="14" height="14" rx="1.5" />
    <line x1="1" y1="5" x2="15" y2="5" />
    <line x1="5" y1="1" x2="5" y2="15" />
    <text x="7.5" y="12.5" fontSize="7" fontWeight="700" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">?</text>
  </svg>
);

/** Puzzle piece (Solver) */
export const IconSolver = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M2 4h3.5a1.5 1.5 0 0 1 3 0H12v3.5a1.5 1.5 0 0 0 0 3V14H8.5a1.5 1.5 0 0 1-3 0H2V10.5a1.5 1.5 0 0 0 0-3V4z" />
  </svg>
);

/** Bracket / tree (Outline submenu) */
export const IconOutline = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M3 2v12" />
    <line x1="3" y1="4" x2="7" y2="4" />
    <line x1="3" y1="8" x2="7" y2="8" />
    <line x1="3" y1="12" x2="7" y2="12" />
    <rect x="8" y="2.5" width="6" height="3" rx="0.5" />
    <rect x="8" y="6.5" width="6" height="3" rx="0.5" />
    <rect x="8" y="10.5" width="6" height="3" rx="0.5" />
  </svg>
);

/** Right indent bracket (Group) */
export const IconGroup = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <path d="M4 2l4 6-4 6" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="10" y1="4" x2="14" y2="4" />
    <line x1="10" y1="8" x2="14" y2="8" />
    <line x1="10" y1="12" x2="14" y2="12" />
  </svg>
);

/** Left indent bracket (Ungroup) */
export const IconUngroup = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <path d="M8 2l-4 6 4 6" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="10" y1="4" x2="14" y2="4" />
    <line x1="10" y1="8" x2="14" y2="8" />
    <line x1="10" y1="12" x2="14" y2="12" />
  </svg>
);

/** Stacked levels (Show Level) */
export const IconShowLevel = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="2" width="12" height="3" rx="0.5" />
    <rect x="4" y="6.5" width="10" height="3" rx="0.5" />
    <rect x="6" y="11" width="8" height="3" rx="0.5" />
  </svg>
);

/** Sigma (Subtotals) */
export const IconSubtotals = (
  <svg viewBox="0 0 16 16" fill={stroke} stroke="none" style={iconStyle}>
    <path d="M3 2h10v2.5L8.5 8 13 11.5V14H3v-2.5l2-1.5H3V8h2L3 4.5V2z" />
  </svg>
);

/** Bracket with X (Clear Outline) */
export const IconClearOutline = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M3 2v12" opacity="0.5" />
    <line x1="3" y1="4" x2="7" y2="4" opacity="0.5" />
    <line x1="3" y1="8" x2="7" y2="8" opacity="0.5" />
    <line x1="3" y1="12" x2="7" y2="12" opacity="0.5" />
    <line x1="9" y1="9" x2="14" y2="14" strokeWidth="1.8" />
    <line x1="14" y1="9" x2="9" y2="14" strokeWidth="1.8" />
  </svg>
);

/** Merge arrows (Consolidate) */
export const IconConsolidate = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <line x1="2" y1="3" x2="8" y2="8" />
    <line x1="2" y1="13" x2="8" y2="8" />
    <line x1="2" y1="8" x2="8" y2="8" />
    <line x1="8" y1="8" x2="14" y2="8" />
    <polyline points="11.5,5.5 14,8 11.5,10.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Grid with hidden rows indicator (Select Visible Cells) */
export const IconSelectVisibleCells = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1" style={iconStyle}>
    {/* Top visible row */}
    <rect x="1" y="1" width="5" height="3" fill={stroke} stroke="none" opacity="0.85" />
    <rect x="7.5" y="1" width="5" height="3" fill={stroke} stroke="none" opacity="0.85" />
    {/* Hidden row indicator (dashed) */}
    <line x1="1" y1="6.5" x2="12.5" y2="6.5" strokeDasharray="1.5 1.5" opacity="0.5" />
    {/* Middle visible row */}
    <rect x="1" y="8.5" width="5" height="3" fill={stroke} stroke="none" opacity="0.85" />
    <rect x="7.5" y="8.5" width="5" height="3" fill={stroke} stroke="none" opacity="0.85" />
    {/* Bottom border */}
    <line x1="1" y1="14" x2="12.5" y2="14" strokeDasharray="1.5 1.5" opacity="0.5" />
  </svg>
);

// ============================================================================
// Edit Menu Icons (Paste Special / Clear / Movement)
// ============================================================================

/** Clipboard with 123 (Paste Values) */
export const IconPasteValues = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="3" y="3" width="10" height="12" rx="1" />
    <rect x="5.5" y="1" width="5" height="3" rx="1" />
    <text x="8" y="12.5" fontSize="5.5" fontWeight="700" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">123</text>
  </svg>
);

/** Clipboard with fx (Paste Formulas) */
export const IconPasteFormulas = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="3" y="3" width="10" height="12" rx="1" />
    <rect x="5.5" y="1" width="5" height="3" rx="1" />
    <text x="8" y="13" fontSize="6.5" fontWeight="600" fontStyle="italic" fill={stroke} stroke="none" textAnchor="middle" fontFamily="serif">fx</text>
  </svg>
);

/** Clipboard with brush (Paste Formatting) */
export const IconPasteFormatting = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="3" y="3" width="10" height="12" rx="1" />
    <rect x="5.5" y="1" width="5" height="3" rx="1" />
    <line x1="10.5" y1="7" x2="7.5" y2="10" strokeWidth="1.3" />
    <path d="M7.5 10c-.8.2-1 1-1 1.8-.5.4-1 .5-1.5.5.8.8 2.3 1 3-.1.4-.6.4-1.5-.5-2.2z" fill={stroke} stroke="none" />
  </svg>
);

/** Clipboard with chain link (Paste Link) */
export const IconPasteLink = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="3" y="3" width="10" height="12" rx="1" />
    <rect x="5.5" y="1" width="5" height="3" rx="1" />
    <path d="M6.5 10.5l-.8.8a1.6 1.6 0 0 0 2.3 2.3l.8-.8" strokeWidth="1.1" />
    <path d="M9.5 11.5l.8-.8a1.6 1.6 0 0 0-2.3-2.3l-.8.8" strokeWidth="1.1" />
  </svg>
);

/** Clipboard with gear (Paste Special) */
export const IconPasteSpecial = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="3" y="3" width="10" height="12" rx="1" />
    <rect x="5.5" y="1" width="5" height="3" rx="1" />
    <circle cx="8" cy="10.5" r="1.8" strokeWidth="1.1" />
    <path d="M8 7.5v1M8 12.5v1M5 10.5h1M10 10.5h1M6 8.5l.7.7M9.3 11.8l.7.7M6 12.5l.7-.7M9.3 9.2l.7-.7" strokeWidth="1" />
  </svg>
);

/** Brush with X (Clear Formatting) */
export const IconClearFormatting = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <line x1="13" y1="3" x2="8" y2="8" strokeWidth="1.4" />
    <path d="M8 8l-1.5 1.5c-.5.5-.5 2-2.5 2.5 1.5 1 3.5.5 4-1l1.5-1.5L8 8z" fill={stroke} stroke="none" />
    <line x1="10.5" y1="11" x2="14.5" y2="15" strokeWidth="1.5" />
    <line x1="14.5" y1="11" x2="10.5" y2="15" strokeWidth="1.5" />
  </svg>
);

/** Cell with X inside (Clear Contents) */
export const IconClearContents = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <line x1="5.5" y1="5.5" x2="10.5" y2="10.5" strokeWidth="1.5" />
    <line x1="10.5" y1="5.5" x2="5.5" y2="10.5" strokeWidth="1.5" />
  </svg>
);

/** Speech bubble with X (Clear Comments) */
export const IconClearComments = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M2 2.5h12v8.5H6l-3 2.5V11H2V2.5z" opacity="0.6" />
    <line x1="6" y1="4.5" x2="10" y2="8.5" strokeWidth="1.5" />
    <line x1="10" y1="4.5" x2="6" y2="8.5" strokeWidth="1.5" />
  </svg>
);

/** Chain link with X (Clear Hyperlinks) */
export const IconClearHyperlinks = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M6.5 4.5l1-1a2.3 2.3 0 0 1 3.3 3.3l-1 1" opacity="0.6" />
    <path d="M7.5 9.5l-1 1a2.3 2.3 0 0 1-3.3-3.3l1-1" opacity="0.6" />
    <line x1="5.5" y1="8.5" x2="8.5" y2="5.5" opacity="0.6" />
    <line x1="10" y1="10" x2="14.5" y2="14.5" strokeWidth="1.6" />
    <line x1="14.5" y1="10" x2="10" y2="14.5" strokeWidth="1.6" />
  </svg>
);

/** Up arrow (Move Up) */
export const IconArrowUp = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <line x1="8" y1="14" x2="8" y2="3" strokeLinecap="round" />
    <polyline points="4,7 8,3 12,7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Down arrow (Move Down) */
export const IconArrowDown = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.5" style={iconStyle}>
    <line x1="8" y1="2" x2="8" y2="13" strokeLinecap="round" />
    <polyline points="4,9 8,13 12,9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Enter / return key arrow (Move Selection) */
export const IconMoveSelection = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <path d="M12.5 3v6H5" strokeLinecap="round" />
    <polyline points="8,6 5,9 8,12" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** 4-way directional arrows (Move Direction) */
export const IconMoveDirection = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <line x1="8" y1="2" x2="8" y2="14" strokeLinecap="round" />
    <line x1="2" y1="8" x2="14" y2="8" strokeLinecap="round" />
    <polyline points="6,4 8,2 10,4" strokeLinecap="round" strokeLinejoin="round" />
    <polyline points="6,12 8,14 10,12" strokeLinecap="round" strokeLinejoin="round" />
    <polyline points="4,6 2,8 4,10" strokeLinecap="round" strokeLinejoin="round" />
    <polyline points="12,6 14,8 12,10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Padlock (Lock) */
export const IconLock = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="3.5" y="7" width="9" height="7" rx="1" />
    <path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7" />
    <circle cx="8" cy="10.5" r="1" fill={stroke} stroke="none" />
  </svg>
);

// ============================================================================
// View Menu Icons (Display Toggles)
// ============================================================================

/** 3x3 grid of light lines (Gridlines) */
export const IconGridlines = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1.5" y="2" width="13" height="12" rx="0.5" />
    <line x1="1.5" y1="6" x2="14.5" y2="6" strokeWidth="0.8" />
    <line x1="1.5" y1="10" x2="14.5" y2="10" strokeWidth="0.8" />
    <line x1="5.8" y1="2" x2="5.8" y2="14" strokeWidth="0.8" />
    <line x1="10.2" y1="2" x2="10.2" y2="14" strokeWidth="0.8" />
  </svg>
);

/** Grid with header bands (Headings) */
export const IconHeadings = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1.5" y="2" width="13" height="12" rx="0.5" />
    <rect x="1.5" y="2" width="13" height="3" fill={stroke} stroke="none" opacity="0.4" />
    <rect x="1.5" y="2" width="3.5" height="12" fill={stroke} stroke="none" opacity="0.4" />
  </svg>
);

/** Wide input bar with fx (Formula Bar) */
export const IconFormulaBar = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="5" width="14" height="6" rx="1" />
    <text x="3" y="10" fontSize="5.5" fontWeight="600" fontStyle="italic" fill={stroke} stroke="none" fontFamily="serif">fx</text>
    <line x1="8.5" y1="6.5" x2="8.5" y2="9.5" strokeWidth="1" />
  </svg>
);

/** R1C1 text (R1C1 Reference Style) */
export const IconR1C1 = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <text x="8" y="11" fontSize="6" fontWeight="700" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">R1C1</text>
  </svg>
);

/** Eye (Show / Visibility) */
export const IconEye = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </svg>
);

/** Curly braces (JSON) */
export const IconJson = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M6 2.5c-1.5 0-2 .8-2 2V6c0 1-.5 1.5-1.5 2 1 .5 1.5 1 1.5 2v1.5c0 1.2.5 2 2 2" />
    <path d="M10 2.5c1.5 0 2 .8 2 2V6c0 1 .5 1.5 1.5 2-1 .5-1.5 1-1.5 2v1.5c0 1.2-.5 2-2 2" />
  </svg>
);

/** Pushpin (Pin) */
export const IconPin = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M6 2h4l-.5 4 2 2v1.5H4.5V8l2-2L6 2z" />
    <line x1="8" y1="9.5" x2="8" y2="14" strokeLinecap="round" />
  </svg>
);

/** Horizontal ellipsis (More) */
export const IconMore = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <circle cx="3" cy="8" r="1.3" fill={stroke} stroke="none" />
    <circle cx="8" cy="8" r="1.3" fill={stroke} stroke="none" />
    <circle cx="13" cy="8" r="1.3" fill={stroke} stroke="none" />
  </svg>
);

// ============================================================================
// File Menu Icons (Security / Recovery / Print)
// ============================================================================

/** Padlock with asterisks (Encrypt with Password) */
export const IconEncrypt = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="2.5" y="6.5" width="11" height="7.5" rx="1" />
    <path d="M5 6.5V4.5a3 3 0 0 1 6 0v2" />
    <text x="8" y="12.8" fontSize="7" fontWeight="700" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">***</text>
  </svg>
);

/** Clock with counterclockwise arrow (AutoRecover) */
export const IconAutoRecover = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M3 8a5 5 0 1 1 1.5 3.5" />
    <polyline points="3,5.5 3,8 5.5,8" strokeLinejoin="round" />
    <polyline points="8,5.5 8,8.5 10.5,10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Simple clock face (Clock) */
export const IconClock = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <circle cx="8" cy="8" r="6" />
    <polyline points="8,4.5 8,8 11,9.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Printer (Print) */
export const IconPrint = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M4.5 6V1.5h7V6" />
    <rect x="2" y="6" width="12" height="6" rx="1" />
    <rect x="4.5" y="10" width="7" height="4.5" />
    <circle cx="12" cy="8" r="0.7" fill={stroke} stroke="none" />
  </svg>
);

/** Page with PDF text (Export as PDF) */
export const IconPdf = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.1" style={iconStyle}>
    <path d="M3 1h7l3 3v11H3V1z" />
    <path d="M10 1v3h3" />
    <text x="4" y="12.5" fontSize="4.5" fontWeight="700" fill={stroke} stroke="none" fontFamily="sans-serif">PDF</text>
  </svg>
);

/** Page with gear in corner (Page Setup) */
export const IconPageSetup = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M3 1h7l3 3v11H3V1z" />
    <path d="M10 1v3h3" />
    <circle cx="9.5" cy="11" r="2" strokeWidth="1.1" />
    <path d="M9.5 8.2v1M9.5 12.8v1M6.7 11h1M11.3 11h1" strokeWidth="1.1" />
  </svg>
);

// ============================================================================
// Print Area Icons
// ============================================================================

/** Dashed rect with X (Clear Print Area) */
export const IconClearPrintArea = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="2" y="2" width="12" height="12" rx="1" strokeDasharray="3 2" opacity="0.6" />
    <line x1="5.5" y1="5.5" x2="10.5" y2="10.5" strokeWidth="1.6" />
    <line x1="10.5" y1="5.5" x2="5.5" y2="10.5" strokeWidth="1.6" />
  </svg>
);

/** Page with solid top band (Repeat Title Rows) */
export const IconTitleRows = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="1.5" width="12" height="13" rx="1" />
    <rect x="2" y="1.5" width="12" height="3.5" fill={stroke} stroke="none" opacity="0.5" />
    <line x1="4" y1="8" x2="12" y2="8" strokeWidth="1" />
    <line x1="4" y1="11" x2="12" y2="11" strokeWidth="1" />
  </svg>
);

/** Page with solid left band (Repeat Title Columns) */
export const IconTitleCols = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="1.5" width="12" height="13" rx="1" />
    <rect x="2" y="1.5" width="3.5" height="13" fill={stroke} stroke="none" opacity="0.5" />
    <line x1="8" y1="4" x2="8" y2="12" strokeWidth="1" />
    <line x1="11" y1="4" x2="11" y2="12" strokeWidth="1" />
  </svg>
);

// ============================================================================
// Insert Menu Icons (Links / Sparklines / Controls / Shapes)
// ============================================================================

/** Two chain links (Hyperlink) */
export const IconHyperlink = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2" strokeLinecap="round" />
    <path d="M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2" strokeLinecap="round" />
    <line x1="6" y1="10" x2="10" y2="6" strokeLinecap="round" />
  </svg>
);

/** Chain link with outward arrow (Follow Link) */
export const IconFollowLink = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M4.5 8.5l-1 1a2.2 2.2 0 0 0 3.1 3.1l1-1" strokeLinecap="round" />
    <line x1="5" y1="11" x2="7.5" y2="8.5" strokeLinecap="round" />
    <line x1="9" y1="7" x2="13.5" y2="2.5" strokeLinecap="round" />
    <polyline points="10,2.5 13.5,2.5 13.5,6" strokeLinejoin="round" />
  </svg>
);

/** Tiny polyline (Sparkline submenu) */
export const IconSparkline = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <polyline points="1.5,11 5,6 8,9 11,4 14.5,7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Polyline in a rect (Line Sparkline) */
export const IconSparklineLine = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1" strokeWidth="1.1" />
    <polyline points="3,11 6,6.5 9,9 13,4.5" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Mini bars in a rect (Column Sparkline) */
export const IconSparklineColumn = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1" strokeWidth="1.1" />
    <rect x="3" y="8" width="2" height="4" fill={stroke} stroke="none" />
    <rect x="6" y="5.5" width="2" height="6.5" fill={stroke} stroke="none" />
    <rect x="9" y="9.5" width="2" height="2.5" fill={stroke} stroke="none" />
    <rect x="12" y="4" width="2" height="8" fill={stroke} stroke="none" />
  </svg>
);

/** Bars above and below axis (Win/Loss Sparkline) */
export const IconSparklineWinLoss = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <line x1="1.5" y1="8" x2="14.5" y2="8" strokeWidth="1" />
    <rect x="2.5" y="4" width="2" height="4" fill={stroke} stroke="none" />
    <rect x="5.5" y="8" width="2" height="4" fill={stroke} stroke="none" />
    <rect x="8.5" y="5" width="2" height="3" fill={stroke} stroke="none" />
    <rect x="11.5" y="8" width="2" height="3" fill={stroke} stroke="none" />
  </svg>
);

/** Cursor over a button (Controls submenu) */
export const IconControls = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1.5" y="3" width="11" height="6" rx="1.5" />
    <path d="M9 6.5l1.8 7.5 1.2-2.7 2.9-.6L9 6.5z" fill={stroke} stroke="none" />
  </svg>
);

/** Rounded rect with center line (Button) */
export const IconButton = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="2" y="5" width="12" height="6" rx="2" />
    <line x1="5" y1="8" x2="11" y2="8" strokeWidth="1.2" />
  </svg>
);

/** Square with checkmark (Checkbox) */
export const IconCheckbox = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <polyline points="5,8 7.5,10.5 11.5,5.5" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Overlapping circle and square (Shapes) */
export const IconShapes = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <circle cx="6" cy="6" r="4.5" />
    <rect x="7" y="7" width="7.5" height="7.5" rx="0.5" />
  </svg>
);

/** Picture frame with mountain and sun (Image) */
export const IconImage = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
    <circle cx="5.5" cy="6" r="1.3" />
    <path d="M1.5 11.5l4-4 3 3 2.5-2.5 3.5 3.5" />
  </svg>
);

/** Line chart with highlighted point (Chart Marks) */
export const IconChartMarks = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <line x1="2" y1="14" x2="14" y2="14" strokeWidth="1" />
    <line x1="2" y1="14" x2="2" y2="2" strokeWidth="1" />
    <polyline points="3.5,11 7,7.5 10,9 13.5,4" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="7" cy="7.5" r="1.6" fill={stroke} stroke="none" />
  </svg>
);

/** Bar chart with transform arrow (Chart Transforms) */
export const IconChartTransforms = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1.5" y="9" width="2.5" height="5.5" fill={stroke} stroke="none" opacity="0.7" />
    <rect x="5" y="6.5" width="2.5" height="8" fill={stroke} stroke="none" opacity="0.85" />
    <rect x="8.5" y="8" width="2.5" height="6.5" fill={stroke} stroke="none" />
    <path d="M14.5 4.5a3 3 0 1 1-.5-1.7" strokeWidth="1.2" />
    <polyline points="15.5,1.2 14,2.8 15.5,4.3" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>
);

/** Highlighter pen over a line (Highlight) */
export const IconHighlight = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M12.5 2l2 2-6.5 6.5-2.5.5.5-2.5L12.5 2z" />
    <line x1="2" y1="13.5" x2="14" y2="13.5" strokeWidth="2.5" opacity="0.5" />
  </svg>
);

// ============================================================================
// Formulas Menu Icons (Calculation / Names / Cubes)
// ============================================================================

/** Two arrows forming a loop (Iterative Calculation) */
export const IconIteration = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M4 6a4.5 4.5 0 0 1 8-1" strokeLinecap="round" />
    <polyline points="12.5,2 12,5 9,4.5" strokeLinejoin="round" />
    <path d="M12 10a4.5 4.5 0 0 1-8 1" strokeLinecap="round" />
    <polyline points="3.5,14 4,11 7,11.5" strokeLinejoin="round" />
  </svg>
);

/** 0.0 text (Precision as Displayed) */
export const IconPrecision = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <text x="8" y="11.5" fontSize="8" fontWeight="700" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">0.0</text>
  </svg>
);

/** Floppy disk with sigma (Calculate Before Save) */
export const IconCalcBeforeSave = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M2 1h10l2 2v11H2V1z" />
    <rect x="4.5" y="1" width="5" height="3.5" rx="0.5" />
    <polyline points="10,7.5 6,7.5 8.5,10 6,12.5 10,12.5" strokeWidth="1.2" />
  </svg>
);

/** Name tag with clipboard corner (Paste Names) */
export const IconPasteNames = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M2 3h6l4.5 4.5L8 12H2V3z" />
    <circle cx="4.5" cy="6.5" r="0.9" fill={stroke} stroke="none" />
    <rect x="9.5" y="9.5" width="5" height="5.5" rx="0.8" strokeWidth="1.1" />
    <rect x="10.8" y="8.5" width="2.4" height="1.8" rx="0.6" strokeWidth="1.1" />
  </svg>
);

/** Name tag with checkmark (Apply Names) */
export const IconApplyNames = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M2 3h7l5 5-5 5H2V3z" />
    <circle cx="5" cy="8" r="1" fill={stroke} stroke="none" />
    <polyline points="9.5,11.5 11.5,13.5 15,9.5" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Isometric 3D cube (Cube Functions) */
export const IconCube = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M8 1.5L14 5v6l-6 3.5L2 11V5L8 1.5z" strokeLinejoin="round" />
    <path d="M2 5l6 3.5L14 5" strokeLinejoin="round" />
    <line x1="8" y1="8.5" x2="8" y2="14.5" />
  </svg>
);

/** Cube with fx (Calculated Measure) */
export const IconCalculatedMeasure = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M7 1.5l5.5 3v5L7 12.5 1.5 9.5v-5L7 1.5z" strokeLinejoin="round" />
    <path d="M1.5 4.5L7 7.5l5.5-3" strokeLinejoin="round" />
    <line x1="7" y1="7.5" x2="7" y2="12.5" />
    <text x="10.5" y="15" fontSize="6" fontWeight="600" fontStyle="italic" fill={stroke} stroke="none" fontFamily="serif">fx</text>
  </svg>
);

/** {fx} text (Custom Functions) */
export const IconCustomFunctions = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <text x="8" y="11.5" fontSize="7" fontWeight="600" fontStyle="italic" fill={stroke} stroke="none" textAnchor="middle" fontFamily="serif">{"{fx}"}</text>
  </svg>
);

// ============================================================================
// Data Menu Icons (Forms)
// ============================================================================

/** Page with labeled field rows (Data Form) */
export const IconDataForm = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="1.5" width="12" height="13" rx="1" />
    <line x1="4" y1="5" x2="6" y2="5" strokeWidth="1" />
    <rect x="7.5" y="3.8" width="5" height="2.4" rx="0.4" strokeWidth="1" />
    <line x1="4" y1="8.5" x2="6" y2="8.5" strokeWidth="1" />
    <rect x="7.5" y="7.3" width="5" height="2.4" rx="0.4" strokeWidth="1" />
    <line x1="4" y1="12" x2="6" y2="12" strokeWidth="1" />
    <rect x="7.5" y="10.8" width="5" height="2.4" rx="0.4" strokeWidth="1" />
  </svg>
);

// ============================================================================
// Developer Menu Icons
// ============================================================================

/** Tree hierarchy (Workbook Explorer) */
export const IconWorkbookExplorer = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1.5" y="1.5" width="6" height="3.5" rx="0.5" />
    <path d="M3.5 5v8h5" />
    <line x1="3.5" y1="8.5" x2="8.5" y2="8.5" />
    <rect x="8.5" y="6.8" width="6" height="3.4" rx="0.5" />
    <rect x="8.5" y="11.3" width="6" height="3.4" rx="0.5" />
  </svg>
);

/** Play triangle with checkmark (Run Tests) */
export const IconRunTests = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M3 2.5v11l8-5.5-8-5.5z" />
    <polyline points="9.5,11.5 11.5,13.5 15,9" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Laboratory flask (Test Panel) */
export const IconTestPanel = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M6 1.5v4L2.5 12a1.5 1.5 0 0 0 1.3 2.2h8.4a1.5 1.5 0 0 0 1.3-2.2L10 5.5v-4" />
    <line x1="4.5" y1="1.5" x2="11.5" y2="1.5" />
    <line x1="4.5" y1="9.5" x2="11.5" y2="9.5" strokeWidth="1" />
  </svg>
);

/** Two stacked server boxes with LEDs (Server) */
export const IconServer = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
    <rect x="2" y="9" width="12" height="4.5" rx="1" />
    <circle cx="4.5" cy="4.75" r="0.8" fill={stroke} stroke="none" />
    <circle cx="4.5" cy="11.25" r="0.8" fill={stroke} stroke="none" />
    <line x1="8" y1="4.75" x2="12" y2="4.75" strokeWidth="1" />
    <line x1="8" y1="11.25" x2="12" y2="11.25" strokeWidth="1" />
  </svg>
);

/** Chat bubble with sparkle (AI Chat) */
export const IconAIChat = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M2 2.5h12v8.5H6.5L3 13.5V11H2V2.5z" />
    <path d="M8 4.2l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9.9-2z" fill={stroke} stroke="none" />
  </svg>
);

/** Spiral notebook (Notebook) */
export const IconNotebook = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="3.5" y="1.5" width="10" height="13" rx="1" />
    <line x1="2" y1="4" x2="5" y2="4" strokeWidth="1" />
    <line x1="2" y1="7" x2="5" y2="7" strokeWidth="1" />
    <line x1="2" y1="10" x2="5" y2="10" strokeWidth="1" />
    <line x1="2" y1="13" x2="5" y2="13" strokeWidth="1" />
    <line x1="7" y1="5" x2="11.5" y2="5" strokeWidth="1" />
    <line x1="7" y1="8" x2="11.5" y2="8" strokeWidth="1" />
    <line x1="7" y1="11" x2="11.5" y2="11" strokeWidth="1" />
  </svg>
);

/** Page with code marks (Script) */
export const IconScript = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M3 1h7l3 3v11H3V1z" />
    <path d="M10 1v3h3" />
    <polyline points="6.5,7 4.5,9.5 6.5,12" strokeLinecap="round" strokeLinejoin="round" />
    <polyline points="9.5,7 11.5,9.5 9.5,12" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Two stacked pages with plus (Template) */
export const IconTemplate = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="5" y="4" width="9" height="11" rx="1" />
    <path d="M11 4V2.5a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h2" />
    <line x1="9.5" y1="7" x2="9.5" y2="12" strokeWidth="1.4" />
    <line x1="7" y1="9.5" x2="12" y2="9.5" strokeWidth="1.4" />
  </svg>
);

/** Storefront with awning (Marketplace) */
export const IconMarketplace = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M1.5 6L3 2.5h10L14.5 6H1.5z" />
    <path d="M3 6v8.5h10V6" />
    <rect x="6.5" y="10" width="3" height="4.5" />
  </svg>
);

/** Ruler and pencil (Design Mode) */
export const IconDesignMode = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M1.5 5L5 1.5l9.5 9.5L11 14.5 1.5 5z" />
    <line x1="4.5" y1="5" x2="5.5" y2="4" strokeWidth="0.9" />
    <line x1="7" y1="7.5" x2="8" y2="6.5" strokeWidth="0.9" />
    <line x1="9.5" y1="10" x2="10.5" y2="9" strokeWidth="0.9" />
    <path d="M13.5 1.5l1 1-3 3-1.5.5.5-1.5 3-3z" strokeWidth="1" />
  </svg>
);

// ============================================================================
// External Data & Distribution Icons
// ============================================================================

/** Two tables connected by a line (Data Model) */
export const IconDataModel = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="1.5" width="6" height="5" rx="0.5" />
    <line x1="1" y1="3.5" x2="7" y2="3.5" strokeWidth="1" />
    <rect x="9" y="9.5" width="6" height="5" rx="0.5" />
    <line x1="9" y1="11.5" x2="15" y2="11.5" strokeWidth="1" />
    <line x1="4" y1="6.5" x2="12" y2="9.5" strokeWidth="1.1" />
  </svg>
);

/** Two circular arrows (Refresh Data) */
export const IconRefreshData = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <path d="M13.5 6.5a6 6 0 0 0-10-2" strokeLinecap="round" />
    <polyline points="3.5,1.5 3.5,4.75 6.5,4.75" strokeLinejoin="round" />
    <path d="M2.5 9.5a6 6 0 0 0 10 2" strokeLinecap="round" />
    <polyline points="12.5,14.5 12.5,11.25 9.5,11.25" strokeLinejoin="round" />
  </svg>
);

/** Closed box with tape (Package) */
export const IconPackage = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="3.5" width="12" height="10.5" rx="0.5" />
    <line x1="2" y1="7" x2="14" y2="7" strokeWidth="1" />
    <line x1="8" y1="3.5" x2="8" y2="14" strokeWidth="1" />
  </svg>
);

/** Box with up arrow (Publish Package) */
export const IconPublishPackage = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M2.5 8v6h11V8" />
    <line x1="8" y1="10" x2="8" y2="2" strokeWidth="1.4" strokeLinecap="round" />
    <polyline points="5.5,4.5 8,2 10.5,4.5" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Box with down arrow (Subscribe to Package) */
export const IconSubscribePackage = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M2.5 8v6h11V8" />
    <line x1="8" y1="2" x2="8" y2="10" strokeWidth="1.4" strokeLinecap="round" />
    <polyline points="5.5,7.5 8,10 10.5,7.5" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Box with circular refresh arrow (Refresh Subscriptions) */
export const IconRefreshSubscriptions = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1.5" y="6.5" width="8.5" height="8" rx="0.5" />
    <line x1="1.5" y1="9.5" x2="10" y2="9.5" strokeWidth="1" />
    <path d="M13.5 5a3 3 0 1 1-.5-1.7" strokeWidth="1.3" />
    <polyline points="15.5,3.3 13,3.3 13,5.8" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

/** List rows with gear (Manage Subscriptions) */
export const IconManageSubscriptions = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <line x1="2" y1="3" x2="10" y2="3" />
    <line x1="2" y1="6.5" x2="10" y2="6.5" />
    <line x1="2" y1="10" x2="7" y2="10" />
    <circle cx="11.5" cy="11" r="2.5" strokeWidth="1.2" />
    <path d="M11.5 7.5v1M11.5 13.5v1M8 11h1M14 11h1" strokeWidth="1.2" />
  </svg>
);

/** Inbox tray with down arrow (Collected Responses) */
export const IconCollectedResponses = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M2 9.5V14h12V9.5" />
    <path d="M2 9.5h3.5c.3 1 1.2 1.8 2.5 1.8s2.2-.8 2.5-1.8H14" strokeWidth="1.1" />
    <line x1="8" y1="1.5" x2="8" y2="7" strokeWidth="1.4" strokeLinecap="round" />
    <polyline points="5.5,4.8 8,7.3 10.5,4.8" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Document with clock overlay (Audit Log) */
export const IconAuditLog = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <path d="M3 1h7l3 3v11H3V1z" />
    <path d="M10 1v3h3" />
    <circle cx="9.5" cy="10.5" r="3.5" fill="var(--menu-dropdown-bg, #2b2b2b)" stroke={stroke} />
    <polyline points="9.5,8.5 9.5,10.5 11,11.5" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Three stacked layers (Overrides) */
export const IconOverrides = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <path d="M8 2l6.5 3.5L8 9 1.5 5.5 8 2z" strokeLinejoin="round" />
    <path d="M1.5 8.5L8 12l6.5-3.5" strokeLinejoin="round" />
    <path d="M1.5 11.5L8 15l6.5-3.5" strokeLinejoin="round" />
  </svg>
);

/** Cell grid with pencil (Writeback) */
export const IconWriteback = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1.5" y="2" width="13" height="11" rx="1" />
    <line x1="1.5" y1="6" x2="14.5" y2="6" strokeWidth="1" />
    <line x1="6" y1="2" x2="6" y2="13" strokeWidth="1" />
    <path d="M9 12l4.5-4.5 1.5 1.5-4.5 4.5H9V12z" fill={stroke} stroke="none" />
  </svg>
);

/** Side panel with pencil (Writeback Pane) */
export const IconWritebackPane = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1" y="2" width="14" height="12" rx="1.5" />
    <line x1="10" y1="2" x2="10" y2="14" />
    <path d="M11 10.5l2.5-2.5 1 1-2.5 2.5h-1v-1z" fill={stroke} stroke="none" />
  </svg>
);

// ============================================================================
// Conditional Formatting Icons
// ============================================================================

/** Cell grid with highlighted cell (Highlight Cells Rules) */
export const IconHighlightCells = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="1.5" y="2" width="13" height="12" rx="1" />
    <line x1="1.5" y1="8" x2="14.5" y2="8" strokeWidth="1" />
    <line x1="8" y1="2" x2="8" y2="14" strokeWidth="1" />
    <rect x="8" y="2" width="6.5" height="6" fill={stroke} stroke="none" opacity="0.6" />
  </svg>
);

/** Greater-than sign (Greater Than) */
export const IconGreaterThan = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <text x="8" y="12" fontSize="11" fontWeight="700" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">{">"}</text>
  </svg>
);

/** Less-than sign (Less Than) */
export const IconLessThan = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <text x="8" y="12" fontSize="11" fontWeight="700" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">{"<"}</text>
  </svg>
);

/** Two bounds with a point between (Between) */
export const IconBetween = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <line x1="3" y1="3" x2="3" y2="13" />
    <line x1="13" y1="3" x2="13" y2="13" />
    <circle cx="8" cy="8" r="1.8" fill={stroke} stroke="none" />
  </svg>
);

/** Equals sign (Equal To) */
export const IconEqualTo = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <text x="8" y="12" fontSize="11" fontWeight="700" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">=</text>
  </svg>
);

/** ab with underline highlight (Text Contains) */
export const IconTextContains = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <text x="8" y="10" fontSize="8" fontWeight="600" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">ab</text>
    <line x1="3.5" y1="12.5" x2="12.5" y2="12.5" strokeWidth="2" opacity="0.6" />
  </svg>
);

/** Two overlapping equal squares (Duplicate Values) */
export const IconDuplicateValues = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="2" width="8.5" height="8.5" rx="1" />
    <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1" />
  </svg>
);

/** Square with star (Unique Values) */
export const IconUniqueValues = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
    <path d="M8 5l.9 2 2.2.3-1.6 1.5.4 2.2-1.9-1-1.9 1 .4-2.2-1.6-1.5L7.1 7 8 5z" fill={stroke} stroke="none" />
  </svg>
);

/** Up and down arrows (Top/Bottom Rules) */
export const IconTopBottom = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.4" style={iconStyle}>
    <line x1="5" y1="13.5" x2="5" y2="2.5" strokeLinecap="round" />
    <polyline points="2.5,5 5,2.5 7.5,5" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="11" y1="2.5" x2="11" y2="13.5" strokeLinecap="round" />
    <polyline points="8.5,11 11,13.5 13.5,11" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** 10 with up arrow (Top 10 Items) */
export const IconTop10 = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <text x="5" y="12" fontSize="8" fontWeight="700" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">10</text>
    <line x1="12.5" y1="13" x2="12.5" y2="3.5" strokeWidth="1.4" strokeLinecap="round" />
    <polyline points="10.3,5.7 12.5,3.5 14.7,5.7" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** % with up arrow (Top 10 Percent) */
export const IconTopPercent = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <text x="5" y="12" fontSize="8" fontWeight="700" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">%</text>
    <line x1="12.5" y1="13" x2="12.5" y2="3.5" strokeWidth="1.4" strokeLinecap="round" />
    <polyline points="10.3,5.7 12.5,3.5 14.7,5.7" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** 10 with down arrow (Bottom 10 Items) */
export const IconBottom10 = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <text x="5" y="12" fontSize="8" fontWeight="700" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">10</text>
    <line x1="12.5" y1="3.5" x2="12.5" y2="13" strokeWidth="1.4" strokeLinecap="round" />
    <polyline points="10.3,10.8 12.5,13 14.7,10.8" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** % with down arrow (Bottom 10 Percent) */
export const IconBottomPercent = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <text x="5" y="12" fontSize="8" fontWeight="700" fill={stroke} stroke="none" textAnchor="middle" fontFamily="sans-serif">%</text>
    <line x1="12.5" y1="3.5" x2="12.5" y2="13" strokeWidth="1.4" strokeLinecap="round" />
    <polyline points="10.3,10.8 12.5,13 14.7,10.8" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Dashed line with bar above (Above Average) */
export const IconAboveAverage = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <line x1="2" y1="10" x2="14" y2="10" strokeDasharray="2.5 2" />
    <rect x="6" y="3" width="4" height="5.5" fill={stroke} stroke="none" opacity="0.85" />
  </svg>
);

/** Dashed line with bar below (Below Average) */
export const IconBelowAverage = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <line x1="2" y1="6" x2="14" y2="6" strokeDasharray="2.5 2" />
    <rect x="6" y="7.5" width="4" height="5.5" fill={stroke} stroke="none" opacity="0.85" />
  </svg>
);

/** Three gradient bars (Color Scales) */
export const IconColorScales = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <rect x="2" y="2.5" width="12" height="3" rx="0.5" fill={stroke} stroke="none" opacity="0.9" />
    <rect x="2" y="6.5" width="12" height="3" rx="0.5" fill={stroke} stroke="none" opacity="0.55" />
    <rect x="2" y="10.5" width="12" height="3" rx="0.5" fill={stroke} stroke="none" opacity="0.25" />
  </svg>
);

/** Cells with left-aligned bars (Data Bars) */
export const IconDataBars = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.1" style={iconStyle}>
    <rect x="1.5" y="2" width="13" height="12" rx="1" />
    <line x1="1.5" y1="6" x2="14.5" y2="6" strokeWidth="0.9" />
    <line x1="1.5" y1="10" x2="14.5" y2="10" strokeWidth="0.9" />
    <rect x="1.5" y="3" width="10" height="2" fill={stroke} stroke="none" opacity="0.7" />
    <rect x="1.5" y="7" width="5.5" height="2" fill={stroke} stroke="none" opacity="0.7" />
    <rect x="1.5" y="11" width="8" height="2" fill={stroke} stroke="none" opacity="0.7" />
  </svg>
);

/** Circle, triangle, diamond (Icon Sets) */
export const IconIconSets = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.2" style={iconStyle}>
    <circle cx="3" cy="8" r="1.8" fill={stroke} stroke="none" />
    <path d="M8 6l2 3.5H6L8 6z" fill={stroke} stroke="none" />
    <path d="M13 6l2 2-2 2-2-2 2-2z" fill={stroke} stroke="none" />
  </svg>
);

/** List rows with plus (New Rule) */
export const IconNewRule = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <line x1="2" y1="3.5" x2="10" y2="3.5" />
    <line x1="2" y1="7" x2="10" y2="7" />
    <line x1="2" y1="10.5" x2="7" y2="10.5" />
    <line x1="11.5" y1="8.5" x2="11.5" y2="14.5" strokeWidth="1.5" />
    <line x1="8.5" y1="11.5" x2="14.5" y2="11.5" strokeWidth="1.5" />
  </svg>
);

/** Checkbox rows (Manage Rules) */
export const IconManageRules = (
  <svg viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth="1.3" style={iconStyle}>
    <rect x="1.5" y="2" width="3" height="3" rx="0.5" strokeWidth="1.1" />
    <polyline points="2.2,3.5 2.9,4.2 4.2,2.7" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="6.5" y1="3.5" x2="14.5" y2="3.5" />
    <rect x="1.5" y="6.5" width="3" height="3" rx="0.5" strokeWidth="1.1" />
    <polyline points="2.2,8 2.9,8.7 4.2,7.2" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="6.5" y1="8" x2="14.5" y2="8" />
    <rect x="1.5" y="11" width="3" height="3" rx="0.5" strokeWidth="1.1" />
    <line x1="6.5" y1="12.5" x2="14.5" y2="12.5" />
  </svg>
);
