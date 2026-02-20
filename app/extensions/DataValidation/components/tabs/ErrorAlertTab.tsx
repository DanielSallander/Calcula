//! FILENAME: app/extensions/DataValidation/components/tabs/ErrorAlertTab.tsx
// PURPOSE: Error Alert tab for the Data Validation dialog.
// CONTEXT: Configures the error alert shown when invalid data is entered.

import React from "react";
import type { DataValidationAlertStyle } from "../../../../src/api";

// ============================================================================
// Styles
// ============================================================================

const fieldGroupStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "8px 0",
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: "#333",
};

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 6px",
  fontSize: 13,
  border: "1px solid #ccc",
  borderRadius: 2,
  backgroundColor: "#fff",
  fontFamily: "inherit",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 6px",
  fontSize: 13,
  border: "1px solid #ccc",
  borderRadius: 2,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: "vertical",
  minHeight: 60,
};

const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  padding: "4px 0",
};

// ============================================================================
// Constants
// ============================================================================

const ALERT_STYLES: { value: DataValidationAlertStyle; label: string; description: string }[] = [
  {
    value: "stop",
    label: "Stop",
    description: "Prevents entry of invalid data",
  },
  {
    value: "warning",
    label: "Warning",
    description: "Warns but allows entry",
  },
  {
    value: "information",
    label: "Information",
    description: "Informational only, allows entry",
  },
];

// ============================================================================
// Types
// ============================================================================

interface ErrorAlertTabProps {
  showAlert: boolean;
  alertStyle: DataValidationAlertStyle;
  errorTitle: string;
  errorMessage: string;
  onChangeShowAlert: (val: boolean) => void;
  onChangeStyle: (val: DataValidationAlertStyle) => void;
  onChangeTitle: (val: string) => void;
  onChangeMessage: (val: string) => void;
}

// ============================================================================
// Component
// ============================================================================

export function ErrorAlertTab(props: ErrorAlertTabProps) {
  const {
    showAlert,
    alertStyle,
    errorTitle,
    errorMessage,
    onChangeShowAlert,
    onChangeStyle,
    onChangeTitle,
    onChangeMessage,
  } = props;

  return (
    <div style={fieldGroupStyle}>
      <div style={checkboxRowStyle}>
        <input
          type="checkbox"
          id="dv-show-alert"
          checked={showAlert}
          onChange={(e) => onChangeShowAlert(e.target.checked)}
        />
        <label htmlFor="dv-show-alert" style={labelStyle}>
          Show error alert after invalid data is entered
        </label>
      </div>

      <div>
        <label style={labelStyle}>Style:</label>
        <select
          style={selectStyle}
          value={alertStyle}
          onChange={(e) => onChangeStyle(e.target.value as DataValidationAlertStyle)}
          disabled={!showAlert}
        >
          {ALERT_STYLES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label style={labelStyle}>Title:</label>
        <input
          style={inputStyle}
          type="text"
          value={errorTitle}
          onChange={(e) => onChangeTitle(e.target.value)}
          disabled={!showAlert}
        />
      </div>

      <div>
        <label style={labelStyle}>Error message:</label>
        <textarea
          style={textareaStyle}
          value={errorMessage}
          onChange={(e) => onChangeMessage(e.target.value)}
          disabled={!showAlert}
          rows={4}
        />
      </div>
    </div>
  );
}
