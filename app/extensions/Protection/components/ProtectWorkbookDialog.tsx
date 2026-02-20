//! FILENAME: app/extensions/Protection/components/ProtectWorkbookDialog.tsx
// PURPOSE: Dialog for protecting the workbook structure.
// CONTEXT: Prevents adding, deleting, renaming, moving, hiding/unhiding sheets.

import React, { useState } from "react";
import type { DialogProps } from "../../../src/api";
import { protectWorkbook } from "../../../src/api";
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

const fieldStyle: React.CSSProperties = {
  marginBottom: 12,
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

const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 0",
  fontSize: 12,
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
  marginTop: 4,
};

// ============================================================================
// Component
// ============================================================================

export function ProtectWorkbookDialog(props: DialogProps) {
  const { isOpen, onClose } = props;

  const [protectStructure, setProtectStructure] = useState(true);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) {
    return null;
  }

  const handleSubmit = async () => {
    setError(null);

    if (!protectStructure) {
      setError("Select at least one protection option.");
      return;
    }

    if (password && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await protectWorkbook(password || undefined);

      if (result.success) {
        await refreshProtectionState();
        setPassword("");
        setConfirmPassword("");
        setProtectStructure(true);
        setError(null);
        onClose();
      } else {
        setError(result.error || "Failed to protect workbook.");
      }
    } catch (err) {
      setError("An error occurred while protecting the workbook.");
      console.error("[Protection] Protect workbook error:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setPassword("");
    setConfirmPassword("");
    setProtectStructure(true);
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
      <div style={dialogStyle} role="dialog" aria-labelledby="protect-wb-title">
        <div style={titleBarStyle} id="protect-wb-title">
          Protect Workbook
        </div>
        <div style={bodyStyle}>
          <div style={fieldStyle}>
            <label style={labelStyle}>Protect workbook for:</label>
            <label style={checkboxRowStyle}>
              <input
                type="checkbox"
                checked={protectStructure}
                onChange={(e) => setProtectStructure(e.target.checked)}
              />
              Structure
            </label>
            <div style={{ fontSize: 11, color: "#666", marginLeft: 20, marginTop: 2 }}>
              Prevents users from adding, deleting, renaming, moving, or hiding/unhiding sheets.
            </div>
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>Password (optional):</label>
            <input
              type="password"
              style={inputStyle}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank for no password"
              autoFocus
            />
          </div>

          {password && (
            <div style={fieldStyle}>
              <label style={labelStyle}>Confirm password:</label>
              <input
                type="password"
                style={inputStyle}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
              />
            </div>
          )}

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
