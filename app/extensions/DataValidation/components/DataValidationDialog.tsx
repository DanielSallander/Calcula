//! FILENAME: app/extensions/DataValidation/components/DataValidationDialog.tsx
// PURPOSE: Main Data Validation configuration dialog with 3 tabs.
// CONTEXT: Opened from the Data menu. Configures validation criteria, input messages, and error alerts.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "../../../src/api";
import type {
  DataValidationType,
  DataValidationOperator,
  DataValidationAlertStyle,
  DataValidation,
  DataValidationRule,
} from "../../../src/api";
import {
  getDataValidation,
  setDataValidation,
  clearDataValidation,
  DEFAULT_ERROR_ALERT,
  DEFAULT_PROMPT,
  DEFAULT_VALIDATION,
  createWholeNumberRule,
  createDecimalRule,
  createListRule,
  createListRuleFromRange,
  createTextLengthRule,
  createCustomRule,
  createDateRule,
  createTimeRule,
} from "../../../src/api";
import { refreshValidationState, getCurrentSelection } from "../lib/validationStore";
import type { ValidationDialogData } from "../types";
import { SettingsTab } from "./tabs/SettingsTab";
import { InputMessageTab } from "./tabs/InputMessageTab";
import { ErrorAlertTab } from "./tabs/ErrorAlertTab";

// ============================================================================
// Styles
// ============================================================================

const overlayStyle: React.CSSProperties = {
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

const dialogStyle: React.CSSProperties = {
  backgroundColor: "#f0f0f0",
  border: "1px solid #888",
  borderRadius: 4,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
  width: 420,
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
  fontSize: 13,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 16px",
  borderBottom: "1px solid #ddd",
  fontWeight: 600,
  fontSize: 13,
};

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 16,
  color: "#666",
  padding: "2px 6px",
  lineHeight: 1,
};

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  borderBottom: "1px solid #ccc",
  backgroundColor: "#e8e8e8",
};

const tabStyle: React.CSSProperties = {
  padding: "8px 16px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
  border: "none",
  borderBottom: "2px solid transparent",
  backgroundColor: "transparent",
  color: "#555",
  fontFamily: "inherit",
};

const activeTabStyle: React.CSSProperties = {
  ...tabStyle,
  borderBottom: "2px solid #0078d4",
  color: "#0078d4",
  fontWeight: 600,
};

const bodyStyle: React.CSSProperties = {
  padding: "8px 16px",
  overflowY: "auto",
  flex: 1,
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "12px 16px",
  borderTop: "1px solid #ddd",
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

const clearButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  marginRight: "auto",
};

// ============================================================================
// Tab IDs
// ============================================================================

type TabId = "settings" | "inputMessage" | "errorAlert";

const TABS: { id: TabId; label: string }[] = [
  { id: "settings", label: "Settings" },
  { id: "inputMessage", label: "Input Message" },
  { id: "errorAlert", label: "Error Alert" },
];

// ============================================================================
// Component
// ============================================================================

export function DataValidationDialog(props: DialogProps) {
  const { isOpen, onClose, data } = props;
  const dialogData = data as unknown as ValidationDialogData | undefined;

  // Active tab
  const [activeTab, setActiveTab] = useState<TabId>("settings");

  // Settings tab state
  const [validationType, setValidationType] = useState<DataValidationType>("none");
  const [operator, setOperator] = useState<DataValidationOperator>("between");
  const [formula1, setFormula1] = useState("");
  const [formula2, setFormula2] = useState("");
  const [listSource, setListSource] = useState("");
  const [customFormula, setCustomFormula] = useState("");
  const [ignoreBlanks, setIgnoreBlanks] = useState(true);
  const [inCellDropdown, setInCellDropdown] = useState(true);

  // Input message tab state
  const [showPrompt, setShowPrompt] = useState(true);
  const [promptTitle, setPromptTitle] = useState("");
  const [promptMessage, setPromptMessage] = useState("");

  // Error alert tab state
  const [showAlert, setShowAlert] = useState(true);
  const [alertStyle, setAlertStyle] = useState<DataValidationAlertStyle>("stop");
  const [errorTitle, setErrorTitle] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  // Cell range
  const [startRow, setStartRow] = useState(0);
  const [startCol, setStartCol] = useState(0);
  const [endRow, setEndRow] = useState(0);
  const [endCol, setEndCol] = useState(0);

  // Loading state
  const [loaded, setLoaded] = useState(false);

  // Load existing validation when dialog opens
  useEffect(() => {
    if (!isOpen) {
      setLoaded(false);
      return;
    }

    // Determine cell range from dialog data or current selection
    let sr = dialogData?.startRow ?? 0;
    let sc = dialogData?.startCol ?? 0;
    let er = dialogData?.endRow ?? 0;
    let ec = dialogData?.endCol ?? 0;

    if (!dialogData) {
      const sel = getCurrentSelection();
      if (sel) {
        sr = sel.startRow;
        sc = sel.startCol;
        er = sel.endRow;
        ec = sel.endCol;
      }
    }

    setStartRow(sr);
    setStartCol(sc);
    setEndRow(er);
    setEndCol(ec);

    // Load existing validation for this range
    async function loadExisting() {
      try {
        const existing = dialogData?.existingValidation ?? (await getDataValidation(sr, sc));
        if (existing) {
          populateFromValidation(existing);
        } else {
          resetToDefaults();
        }
      } catch (error) {
        console.error("[DataValidation] Failed to load existing validation:", error);
        resetToDefaults();
      } finally {
        setLoaded(true);
      }
    }

    loadExisting();
  }, [isOpen]);

  function populateFromValidation(dv: DataValidation) {
    const rule = dv.rule;

    // Determine type and populate fields
    if ("none" in rule) {
      setValidationType("none");
    } else if ("wholeNumber" in rule) {
      setValidationType("wholeNumber");
      setOperator(rule.wholeNumber.operator);
      setFormula1(rule.wholeNumber.value1);
      setFormula2(rule.wholeNumber.value2 ?? "");
    } else if ("decimal" in rule) {
      setValidationType("decimal");
      setOperator(rule.decimal.operator);
      setFormula1(rule.decimal.value1);
      setFormula2(rule.decimal.value2 ?? "");
    } else if ("list" in rule) {
      setValidationType("list");
      const src = rule.list.source;
      if ("inline" in src) {
        setListSource(src.inline.join(","));
      } else if ("range" in src) {
        setListSource(src.range);
      }
      setInCellDropdown(rule.list.inCellDropdown);
    } else if ("date" in rule) {
      setValidationType("date");
      setOperator(rule.date.operator);
      setFormula1(rule.date.value1);
      setFormula2(rule.date.value2 ?? "");
    } else if ("time" in rule) {
      setValidationType("time");
      setOperator(rule.time.operator);
      setFormula1(rule.time.value1);
      setFormula2(rule.time.value2 ?? "");
    } else if ("textLength" in rule) {
      setValidationType("textLength");
      setOperator(rule.textLength.operator);
      setFormula1(rule.textLength.value1);
      setFormula2(rule.textLength.value2 ?? "");
    } else if ("custom" in rule) {
      setValidationType("custom");
      setCustomFormula(rule.custom.formula);
    }

    // Populate ignore blanks
    setIgnoreBlanks(dv.ignoreBlanks);

    // Populate prompt
    setShowPrompt(dv.prompt.show);
    setPromptTitle(dv.prompt.title);
    setPromptMessage(dv.prompt.message);

    // Populate error alert
    setShowAlert(dv.errorAlert.show);
    setAlertStyle(dv.errorAlert.style);
    setErrorTitle(dv.errorAlert.title);
    setErrorMessage(dv.errorAlert.message);
  }

  function resetToDefaults() {
    setValidationType("none");
    setOperator("between");
    setFormula1("");
    setFormula2("");
    setListSource("");
    setCustomFormula("");
    setIgnoreBlanks(true);
    setInCellDropdown(true);
    setShowPrompt(true);
    setPromptTitle("");
    setPromptMessage("");
    setShowAlert(true);
    setAlertStyle("stop");
    setErrorTitle("");
    setErrorMessage("");
    setActiveTab("settings");
  }

  // Build the rule object from current state
  function buildRule(): DataValidationRule {
    switch (validationType) {
      case "none":
        return { none: {} };
      case "wholeNumber":
        return createWholeNumberRule(operator, formula1, formula2 || undefined);
      case "decimal":
        return createDecimalRule(operator, formula1, formula2 || undefined);
      case "list": {
        // If source starts with = it's a range reference
        if (listSource.startsWith("=")) {
          return createListRuleFromRange(listSource, inCellDropdown);
        }
        // Otherwise it's inline comma-separated
        const values = listSource.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
        return createListRule(values, inCellDropdown);
      }
      case "date":
        return createDateRule(operator, formula1, formula2 || undefined);
      case "time":
        return createTimeRule(operator, formula1, formula2 || undefined);
      case "textLength":
        return createTextLengthRule(operator, formula1, formula2 || undefined);
      case "custom":
        return createCustomRule(customFormula);
      default:
        return { none: {} };
    }
  }

  // Apply validation
  const handleOk = useCallback(async () => {
    try {
      const rule = buildRule();
      const validation: DataValidation = {
        rule,
        ignoreBlanks,
        prompt: {
          show: showPrompt,
          title: promptTitle,
          message: promptMessage,
        },
        errorAlert: {
          show: showAlert,
          style: alertStyle,
          title: errorTitle,
          message: errorMessage,
        },
      };

      await setDataValidation(startRow, startCol, endRow, endCol, validation);
      await refreshValidationState();
      onClose();
    } catch (error) {
      console.error("[DataValidation] Failed to set validation:", error);
    }
  }, [
    validationType, operator, formula1, formula2, listSource, customFormula,
    ignoreBlanks, inCellDropdown, showPrompt, promptTitle, promptMessage,
    showAlert, alertStyle, errorTitle, errorMessage,
    startRow, startCol, endRow, endCol, onClose,
  ]);

  // Clear all validation for the range
  const handleClearAll = useCallback(async () => {
    try {
      await clearDataValidation(startRow, startCol, endRow, endCol);
      await refreshValidationState();
      onClose();
    } catch (error) {
      console.error("[DataValidation] Failed to clear validation:", error);
    }
  }, [startRow, startCol, endRow, endCol, onClose]);

  // Handle keyboard
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleOk();
      }
    },
    [onClose, handleOk]
  );

  // Click outside to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) {
    return null;
  }

  if (!loaded) {
    return null;
  }

  return (
    <div style={overlayStyle} onKeyDown={handleKeyDown} onClick={handleBackdropClick}>
      <div style={dialogStyle} role="dialog" aria-label="Data Validation">
        {/* Header */}
        <div style={headerStyle}>
          <span>Data Validation</span>
          <button style={closeButtonStyle} onClick={onClose} title="Close">
            X
          </button>
        </div>

        {/* Tab Bar */}
        <div style={tabBarStyle}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              style={activeTab === tab.id ? activeTabStyle : tabStyle}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div style={bodyStyle}>
          {activeTab === "settings" && (
            <SettingsTab
              validationType={validationType}
              operator={operator}
              formula1={formula1}
              formula2={formula2}
              listSource={listSource}
              customFormula={customFormula}
              ignoreBlanks={ignoreBlanks}
              inCellDropdown={inCellDropdown}
              onChangeType={setValidationType}
              onChangeOperator={setOperator}
              onChangeFormula1={setFormula1}
              onChangeFormula2={setFormula2}
              onChangeListSource={setListSource}
              onChangeCustomFormula={setCustomFormula}
              onChangeIgnoreBlanks={setIgnoreBlanks}
              onChangeInCellDropdown={setInCellDropdown}
            />
          )}
          {activeTab === "inputMessage" && (
            <InputMessageTab
              showPrompt={showPrompt}
              promptTitle={promptTitle}
              promptMessage={promptMessage}
              onChangeShowPrompt={setShowPrompt}
              onChangeTitle={setPromptTitle}
              onChangeMessage={setPromptMessage}
            />
          )}
          {activeTab === "errorAlert" && (
            <ErrorAlertTab
              showAlert={showAlert}
              alertStyle={alertStyle}
              errorTitle={errorTitle}
              errorMessage={errorMessage}
              onChangeShowAlert={setShowAlert}
              onChangeStyle={setAlertStyle}
              onChangeTitle={setErrorTitle}
              onChangeMessage={setErrorMessage}
            />
          )}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <button style={clearButtonStyle} onClick={handleClearAll}>
            Clear All
          </button>
          <button style={primaryButtonStyle} onClick={handleOk}>
            OK
          </button>
          <button style={buttonStyle} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
