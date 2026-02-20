//! FILENAME: app/extensions/Protection/components/UnprotectWorkbookDialog.tsx
// PURPOSE: Dialog for entering password to unprotect the workbook structure.
// CONTEXT: Shown when user clicks "Unprotect Workbook" and it has a password.

import React, { useState } from "react";
import type { DialogProps } from "../../../src/api";
import { unprotectWorkbook } from "../../../src/api";
import { refreshProtectionState } from "../lib/protectionStore";

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
  zIndex: 9500,
};

const dialogStyle: React.CSSProperties = {
  backgroundColor: "#f0f0f0",
  border: "1px solid #888",
  borderRadius: 4,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
  width: 320,
  padding: 0,
  fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  fontSize: 13,
};

const titleBarStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid #ddd",
  fontWeight: 600,
  fontSize: 13,
};

const bodyStyle: React.CSSProperties = {
  padding: "16px",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: 4,
  fontSize: 12,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 6px",
  border: "1px solid #ababab",
  borderRadius: 2,
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const buttonBarStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "8px 16px 16px",
};

const buttonStyle: React.CSSProperties = {
  padding: "4px 16px",
  minWidth: 72,
  border: "1px solid #ababab",
  borderRadius: 2,
  backgroundColor: "#e1e1e1",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: "inherit",
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#0078d4",
  color: "#fff",
  borderColor: "#0078d4",
};

const errorStyle: React.CSSProperties = {
  color: "#d32f2f",
  fontSize: 12,
  marginTop: 8,
};

// ============================================================================
// Component
// ============================================================================

export function UnprotectWorkbookDialog(props: DialogProps) {
  const { isOpen, onClose } = props;

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) {
    return null;
  }

  const handleSubmit = async () => {
    setError(null);
    setIsSubmitting(true);

    try {
      const result = await unprotectWorkbook(password || undefined);

      if (result.success) {
        await refreshProtectionState();
        setPassword("");
        setError(null);
        onClose();
      } else {
        setError(result.error || "Incorrect password.");
      }
    } catch (err) {
      setError("An error occurred while unprotecting the workbook.");
      console.error("[Protection] Unprotect workbook error:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setPassword("");
    setError(null);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleCancel();
    } else if (e.key === "Enter" && !isSubmitting) {
      handleSubmit();
    }
  };

  return (
    <div style={overlayStyle} onKeyDown={handleKeyDown}>
      <div style={dialogStyle} role="dialog" aria-labelledby="unprotect-wb-title">
        <div style={titleBarStyle} id="unprotect-wb-title">
          Unprotect Workbook
        </div>
        <div style={bodyStyle}>
          <label style={labelStyle}>Password:</label>
          <input
            type="password"
            style={inputStyle}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password to unprotect"
            autoFocus
          />
          {error && <div style={errorStyle}>{error}</div>}
        </div>
        <div style={buttonBarStyle}>
          <button
            style={primaryButtonStyle}
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            OK
          </button>
          <button style={buttonStyle} onClick={handleCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
