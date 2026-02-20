//! FILENAME: app/extensions/Protection/components/ProtectSheetDialog.tsx
// PURPOSE: Dialog for configuring and applying sheet protection.
// CONTEXT: Shows password field and permission checkboxes, calls protectSheet() on confirm.

import React, { useState } from "react";
import type { DialogProps, SheetProtectionOptions } from "../../../src/api";
import {
  protectSheet,
  DEFAULT_PROTECTION_OPTIONS,
} from "../../../src/api";
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
  width: 380,
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
  padding: "12px 16px",
  maxHeight: 400,
  overflowY: "auto",
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

const checkboxListStyle: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 2,
  padding: "8px",
  maxHeight: 200,
  overflowY: "auto",
  backgroundColor: "#fff",
};

const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 0",
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
// Permission Definitions
// ============================================================================

interface PermissionItem {
  key: keyof SheetProtectionOptions;
  label: string;
}

const PERMISSIONS: PermissionItem[] = [
  { key: "allowSelectLockedCells", label: "Select locked cells" },
  { key: "allowSelectUnlockedCells", label: "Select unlocked cells" },
  { key: "allowFormatCells", label: "Format cells" },
  { key: "allowFormatColumns", label: "Format columns" },
  { key: "allowFormatRows", label: "Format rows" },
  { key: "allowInsertColumns", label: "Insert columns" },
  { key: "allowInsertRows", label: "Insert rows" },
  { key: "allowInsertHyperlinks", label: "Insert hyperlinks" },
  { key: "allowDeleteColumns", label: "Delete columns" },
  { key: "allowDeleteRows", label: "Delete rows" },
  { key: "allowSort", label: "Sort" },
  { key: "allowAutoFilter", label: "Use AutoFilter" },
  { key: "allowPivotTables", label: "Use PivotTable reports" },
  { key: "allowEditObjects", label: "Edit objects" },
  { key: "allowEditScenarios", label: "Edit scenarios" },
];

// ============================================================================
// Component
// ============================================================================

export function ProtectSheetDialog(props: DialogProps) {
  const { isOpen, onClose } = props;

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [options, setOptions] = useState<SheetProtectionOptions>({
    ...DEFAULT_PROTECTION_OPTIONS,
  });
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) {
    return null;
  }

  const handleToggleOption = (key: keyof SheetProtectionOptions) => {
    setOptions((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleSubmit = async () => {
    setError(null);

    // Validate password confirmation
    if (password && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await protectSheet({
        password: password || undefined,
        options,
      });

      if (result.success) {
        await refreshProtectionState();
        // Reset form state
        setPassword("");
        setConfirmPassword("");
        setOptions({ ...DEFAULT_PROTECTION_OPTIONS });
        setError(null);
        onClose();
      } else {
        setError(result.error || "Failed to protect sheet.");
      }
    } catch (err) {
      setError("An error occurred while protecting the sheet.");
      console.error("[Protection] Protect sheet error:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setPassword("");
    setConfirmPassword("");
    setOptions({ ...DEFAULT_PROTECTION_OPTIONS });
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
      <div style={dialogStyle} role="dialog" aria-labelledby="protect-sheet-title">
        <div style={titleBarStyle} id="protect-sheet-title">
          Protect Sheet
        </div>
        <div style={bodyStyle}>
          <div style={fieldStyle}>
            <label style={labelStyle}>Password to unprotect sheet (optional):</label>
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

          <div style={fieldStyle}>
            <label style={labelStyle}>Allow all users of this worksheet to:</label>
            <div style={checkboxListStyle}>
              {PERMISSIONS.map((perm) => (
                <label key={perm.key} style={checkboxRowStyle}>
                  <input
                    type="checkbox"
                    checked={options[perm.key]}
                    onChange={() => handleToggleOption(perm.key)}
                  />
                  {perm.label}
                </label>
              ))}
            </div>
          </div>

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
