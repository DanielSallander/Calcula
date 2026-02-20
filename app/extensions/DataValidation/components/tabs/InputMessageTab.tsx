//! FILENAME: app/extensions/DataValidation/components/tabs/InputMessageTab.tsx
// PURPOSE: Input Message tab for the Data Validation dialog.
// CONTEXT: Configures the input prompt shown when a validated cell is selected.

import React from "react";

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
// Types
// ============================================================================

interface InputMessageTabProps {
  showPrompt: boolean;
  promptTitle: string;
  promptMessage: string;
  onChangeShowPrompt: (val: boolean) => void;
  onChangeTitle: (val: string) => void;
  onChangeMessage: (val: string) => void;
}

// ============================================================================
// Component
// ============================================================================

export function InputMessageTab(props: InputMessageTabProps) {
  const {
    showPrompt,
    promptTitle,
    promptMessage,
    onChangeShowPrompt,
    onChangeTitle,
    onChangeMessage,
  } = props;

  return (
    <div style={fieldGroupStyle}>
      <div style={checkboxRowStyle}>
        <input
          type="checkbox"
          id="dv-show-prompt"
          checked={showPrompt}
          onChange={(e) => onChangeShowPrompt(e.target.checked)}
        />
        <label htmlFor="dv-show-prompt" style={labelStyle}>
          Show input message when cell is selected
        </label>
      </div>

      <div>
        <label style={labelStyle}>Title:</label>
        <input
          style={inputStyle}
          type="text"
          value={promptTitle}
          onChange={(e) => onChangeTitle(e.target.value)}
          maxLength={32}
          disabled={!showPrompt}
        />
      </div>

      <div>
        <label style={labelStyle}>Input message:</label>
        <textarea
          style={textareaStyle}
          value={promptMessage}
          onChange={(e) => onChangeMessage(e.target.value)}
          maxLength={255}
          disabled={!showPrompt}
          rows={4}
        />
      </div>
    </div>
  );
}
