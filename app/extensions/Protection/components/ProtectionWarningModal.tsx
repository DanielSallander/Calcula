//! FILENAME: app/extensions/Protection/components/ProtectionWarningModal.tsx
// PURPOSE: Warning dialog shown when user tries to edit a locked cell on a protected sheet.
// CONTEXT: Displayed by the protection edit guard handler.

import React from "react";
import type { DialogProps } from "../../../src/api";

// ============================================================================
// Styles
// ============================================================================

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 10000,
};

const dialogStyle: React.CSSProperties = {
  backgroundColor: "#f0f0f0",
  border: "1px solid #888",
  borderRadius: 4,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
  minWidth: 340,
  maxWidth: 480,
  padding: 0,
  fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  fontSize: 13,
};

const titleBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 16px",
  borderBottom: "1px solid #ddd",
  fontWeight: 600,
  fontSize: 13,
};

const bodyStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "16px",
};

const iconStyle: React.CSSProperties = {
  fontSize: 32,
  lineHeight: 1,
  flexShrink: 0,
};

const messageStyle: React.CSSProperties = {
  flex: 1,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const buttonBarStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "8px 16px 16px",
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "4px 16px",
  minWidth: 72,
  border: "1px solid #0078d4",
  borderRadius: 2,
  backgroundColor: "#0078d4",
  color: "#fff",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
};

// ============================================================================
// Component
// ============================================================================

interface WarningData {
  message: string;
}

export function ProtectionWarningModal(props: DialogProps) {
  const { isOpen, onClose } = props;
  const data = props.data as unknown as WarningData | undefined;

  if (!isOpen) {
    return null;
  }

  const message = data?.message ||
    "The cell or chart you are trying to change is on a protected sheet. " +
    "To make a change, unprotect the sheet. You might be requested to enter a password.";

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Enter") {
      onClose();
    }
  };

  return (
    <div style={overlayStyle} onKeyDown={handleKeyDown}>
      <div style={dialogStyle} role="alertdialog" aria-labelledby="prot-warn-title" aria-describedby="prot-warn-msg">
        <div style={titleBarStyle} id="prot-warn-title">
          Calcula
        </div>
        <div style={bodyStyle}>
          <svg width="32" height="32" viewBox="0 0 32 32" style={iconStyle}>
            <circle cx="16" cy="16" r="14" fill="#1976d2" />
            <text x="16" y="13" textAnchor="middle" fontSize="16" fontWeight="bold" fill="#fff">i</text>
            <rect x="14" y="16" width="4" height="10" rx="1" fill="#fff" />
          </svg>
          <div style={messageStyle} id="prot-warn-msg">
            {message}
          </div>
        </div>
        <div style={buttonBarStyle}>
          <button style={primaryButtonStyle} onClick={onClose} autoFocus>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
