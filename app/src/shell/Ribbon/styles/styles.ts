// FILENAME: app/src/components/Ribbon/styles.ts
// PURPOSE: Shared styles for ribbon components.
// CONTEXT: Centralizes ribbon styling for consistency.

import React from "react";

/**
 * Container style for the entire ribbon tab content.
 */
export const groupContainerStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "flex-start",
  height: "100%",
  padding: "4px 8px",
};

/**
 * Container style for ribbon groups.
 */
export const groupStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  padding: "4px 8px",
  gap: "4px",
};

/**
 * Title style for ribbon groups.
 */
export const groupTitleStyles: React.CSSProperties = {
  fontSize: "11px",
  color: "#666",
  textAlign: "center",
  marginTop: "2px",
};

/**
 * Separator between ribbon groups.
 */
export const groupSeparatorStyles: React.CSSProperties = {
  width: "1px",
  backgroundColor: "#d1d1d1",
  margin: "4px 8px",
  alignSelf: "stretch",
};

/**
 * Row container for buttons (horizontal layout).
 */
export const buttonRowStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: "2px",
};

/**
 * Placeholder styles for tabs that are not yet implemented.
 */
export const placeholderStyles: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  padding: "16px",
  color: "#888",
  fontSize: "13px",
  fontStyle: "italic",
};

/**
 * Standard format button styles - made more visible with borders and background.
 */
export const formatButtonStyles: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "28px",
  height: "28px",
  padding: "4px",
  border: "1px solid #a0a0a0",
  borderRadius: "3px",
  backgroundColor: "#f8f8f8",
  cursor: "pointer",
  fontSize: "14px",
  color: "#333",
  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
};

/**
 * Large button styles for primary actions (like Paste).
 */
export const largeButtonStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  width: "48px",
  height: "56px",
  padding: "4px",
  border: "1px solid #a0a0a0",
  borderRadius: "3px",
  backgroundColor: "#f8f8f8",
  cursor: "pointer",
  fontSize: "11px",
  color: "#333",
  gap: "2px",
  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
};

/**
 * Small button styles for secondary actions (like Cut, Copy).
 */
export const smallButtonStyles: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
  width: "64px",
  height: "22px",
  padding: "2px 6px",
  border: "1px solid #a0a0a0",
  borderRadius: "3px",
  backgroundColor: "#f8f8f8",
  cursor: "pointer",
  fontSize: "11px",
  color: "#333",
  gap: "4px",
  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
};

/**
 * Paste button styles (large clipboard button).
 */
export const pasteButtonStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  width: "52px",
  height: "66px",
  padding: "4px",
  border: "1px solid #a0a0a0",
  borderRadius: "3px",
  backgroundColor: "#f8f8f8",
  cursor: "pointer",
  fontSize: "11px",
  color: "#333",
  gap: "2px",
  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
};

/**
 * Clipboard small button styles (Cut, Copy, Format Painter).
 */
export const clipboardButtonStyles: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "24px",
  height: "20px",
  padding: "2px",
  border: "1px solid #a0a0a0",
  borderRadius: "3px",
  backgroundColor: "#f8f8f8",
  cursor: "pointer",
  fontSize: "11px",
  color: "#333",
};

/**
 * Color picker container (positioned relative for dropdown).
 */
export const colorPickerContainerStyles: React.CSSProperties = {
  position: "relative",
  display: "inline-block",
};

/**
 * Color button styles (for text color, fill color buttons).
 */
export const colorButtonStyles: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "2px",
  width: "32px",
  height: "28px",
  padding: "4px",
  border: "1px solid #a0a0a0",
  borderRadius: "3px",
  backgroundColor: "#f8f8f8",
  cursor: "pointer",
  fontSize: "14px",
  color: "#333",
};

/**
 * Number format container (positioned relative for dropdown).
 */
export const numberFormatContainerStyles: React.CSSProperties = {
  position: "relative",
  display: "inline-block",
};

/**
 * Number format button styles (the "General" dropdown button).
 */
export const numberFormatButtonStyles: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  width: "90px",
  height: "28px",
  padding: "4px 8px",
  border: "1px solid #a0a0a0",
  borderRadius: "3px",
  backgroundColor: "#fff",
  cursor: "pointer",
  fontSize: "12px",
  color: "#333",
};

/**
 * Dropdown arrow indicator styles.
 */
export const dropdownArrowStyles: React.CSSProperties = {
  fontSize: "8px",
  marginLeft: "2px",
  color: "#666",
};

/**
 * Number format dropdown container styles.
 */
export const numberFormatDropdownStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  backgroundColor: "#ffffff",
  border: "1px solid #c0c0c0",
  borderRadius: "4px",
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
  padding: "4px 0",
  minWidth: "180px",
  zIndex: 1000,
};

/**
 * Number format option button styles.
 */
export const numberFormatOptionStyles: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  width: "100%",
  padding: "6px 12px",
  border: "none",
  backgroundColor: "transparent",
  cursor: "pointer",
  fontSize: "12px",
  color: "#333",
  textAlign: "left",
};

/**
 * Format label styles (left side of option).
 */
export const formatLabelStyles: React.CSSProperties = {
  fontWeight: 500,
  color: "#333",
};

/**
 * Format example styles (right side of option).
 */
export const formatExampleStyles: React.CSSProperties = {
  color: "#888",
  fontSize: "11px",
  marginLeft: "12px",
};

/**
 * Color picker dropdown container styles.
 */
export const colorPickerDropdownStyles: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  backgroundColor: "#ffffff",
  border: "1px solid #c0c0c0",
  borderRadius: "4px",
  boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
  padding: "8px",
  zIndex: 1000,
};

/**
 * Color grid container styles.
 */
export const colorGridStyles: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(10, 1fr)",
  gap: "2px",
  marginBottom: "8px",
};

/**
 * Individual color swatch button styles.
 */
export const colorSwatchStyles: React.CSSProperties = {
  width: "18px",
  height: "18px",
  padding: 0,
  border: "1px solid transparent",
  borderRadius: "2px",
  cursor: "pointer",
};

/**
 * No color/fill button styles.
 */
export const noColorButtonStyles: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid #c0c0c0",
  borderRadius: "3px",
  backgroundColor: "#f8f8f8",
  cursor: "pointer",
  fontSize: "11px",
  color: "#333",
  textAlign: "center",
};

/**
 * Get dynamic style for format buttons based on active state.
 */
export function getFormatButtonStyle(
  isActive: boolean,
  additionalStyles?: React.CSSProperties
): React.CSSProperties {
  return {
    ...formatButtonStyles,
    backgroundColor: isActive ? "#d0e0f0" : "#f8f8f8",
    borderColor: isActive ? "#0078d4" : "#a0a0a0",
    ...additionalStyles,
  };
}

/**
 * Get dynamic style for color picker buttons.
 */
export function getColorButtonStyle(
  colorValue: string
): React.CSSProperties {
  return {
    ...formatButtonStyles,
    borderBottomWidth: "3px",
    borderBottomColor: colorValue || "#000000",
  };
}

/**
 * Get dynamic style for number format buttons.
 */
export function getNumberFormatButtonStyle(
  isActive: boolean
): React.CSSProperties {
  return {
    ...formatButtonStyles,
    backgroundColor: isActive ? "#d0e0f0" : "#f8f8f8",
    borderColor: isActive ? "#0078d4" : "#a0a0a0",
  };
}