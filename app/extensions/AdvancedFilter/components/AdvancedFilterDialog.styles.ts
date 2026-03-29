//! FILENAME: app/extensions/AdvancedFilter/components/AdvancedFilterDialog.styles.ts
// PURPOSE: Inline styles for the Advanced Filter dialog.
// CONTEXT: Follows the same visual patterns as DataValidation and other dialogs.

import type React from "react";

export const overlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0, 0, 0, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9500,
};

export const dialogStyle: React.CSSProperties = {
  backgroundColor: "#f0f0f0",
  border: "1px solid #888",
  borderRadius: 4,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
  width: 400,
  display: "flex",
  flexDirection: "column",
  fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  fontSize: 13,
};

export const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 16px",
  borderBottom: "1px solid #ddd",
  fontWeight: 600,
  fontSize: 13,
};

export const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 16,
  color: "#666",
  padding: "2px 6px",
  lineHeight: 1,
};

export const bodyStyle: React.CSSProperties = {
  padding: "12px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

export const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

export const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: "#333",
};

export const inputStyle: React.CSSProperties = {
  padding: "4px 8px",
  border: "1px solid #ababab",
  borderRadius: 2,
  fontSize: 13,
  fontFamily: "inherit",
  backgroundColor: "#fff",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

export const inputErrorStyle: React.CSSProperties = {
  ...inputStyle,
  borderColor: "#d32f2f",
};

export const radioGroupStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "4px 0",
};

export const radioLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  cursor: "pointer",
};

export const checkboxLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  cursor: "pointer",
  padding: "2px 0",
};

export const footerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "12px 16px",
  borderTop: "1px solid #ddd",
};

export const buttonStyle: React.CSSProperties = {
  padding: "4px 16px",
  minWidth: 72,
  border: "1px solid #ababab",
  borderRadius: 2,
  backgroundColor: "#e1e1e1",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
};

export const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#0078d4",
  color: "#fff",
  borderColor: "#0078d4",
};

export const errorTextStyle: React.CSSProperties = {
  color: "#d32f2f",
  fontSize: 11,
  marginTop: 2,
};
