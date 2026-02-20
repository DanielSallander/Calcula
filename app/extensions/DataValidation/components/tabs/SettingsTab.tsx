//! FILENAME: app/extensions/DataValidation/components/tabs/SettingsTab.tsx
// PURPOSE: Settings tab for the Data Validation dialog.
// CONTEXT: Configures validation criteria (type, operator, values).

import React from "react";
import type {
  DataValidationType,
  DataValidationOperator,
} from "../../../../src/api";

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

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
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

interface SettingsTabProps {
  validationType: DataValidationType;
  operator: DataValidationOperator;
  formula1: string;
  formula2: string;
  listSource: string;
  customFormula: string;
  ignoreBlanks: boolean;
  inCellDropdown: boolean;
  onChangeType: (type: DataValidationType) => void;
  onChangeOperator: (op: DataValidationOperator) => void;
  onChangeFormula1: (val: string) => void;
  onChangeFormula2: (val: string) => void;
  onChangeListSource: (val: string) => void;
  onChangeCustomFormula: (val: string) => void;
  onChangeIgnoreBlanks: (val: boolean) => void;
  onChangeInCellDropdown: (val: boolean) => void;
}

// ============================================================================
// Constants
// ============================================================================

const VALIDATION_TYPES: { value: DataValidationType; label: string }[] = [
  { value: "none", label: "Any value" },
  { value: "wholeNumber", label: "Whole number" },
  { value: "decimal", label: "Decimal" },
  { value: "list", label: "List" },
  { value: "date", label: "Date" },
  { value: "time", label: "Time" },
  { value: "textLength", label: "Text length" },
  { value: "custom", label: "Custom" },
];

const OPERATORS: { value: DataValidationOperator; label: string }[] = [
  { value: "between", label: "between" },
  { value: "notBetween", label: "not between" },
  { value: "equal", label: "equal to" },
  { value: "notEqual", label: "not equal to" },
  { value: "greaterThan", label: "greater than" },
  { value: "lessThan", label: "less than" },
  { value: "greaterThanOrEqual", label: "greater than or equal to" },
  { value: "lessThanOrEqual", label: "less than or equal to" },
];

// Types that use the operator + value fields
const NUMERIC_TYPES: DataValidationType[] = ["wholeNumber", "decimal", "date", "time", "textLength"];

// Types that need two value fields
const RANGE_OPERATORS: DataValidationOperator[] = ["between", "notBetween"];

// ============================================================================
// Component
// ============================================================================

export function SettingsTab(props: SettingsTabProps) {
  const {
    validationType,
    operator,
    formula1,
    formula2,
    listSource,
    customFormula,
    ignoreBlanks,
    inCellDropdown,
    onChangeType,
    onChangeOperator,
    onChangeFormula1,
    onChangeFormula2,
    onChangeListSource,
    onChangeCustomFormula,
    onChangeIgnoreBlanks,
    onChangeInCellDropdown,
  } = props;

  const showOperator = NUMERIC_TYPES.includes(validationType);
  const showTwoValues = showOperator && RANGE_OPERATORS.includes(operator);
  const showListSource = validationType === "list";
  const showCustomFormula = validationType === "custom";
  const showValueFields = showOperator && !showListSource && !showCustomFormula;

  // Labels for value fields based on type
  const getValueLabels = (): { label1: string; label2: string } => {
    if (showTwoValues) {
      return { label1: "Minimum:", label2: "Maximum:" };
    }
    return { label1: "Value:", label2: "" };
  };

  const { label1, label2 } = getValueLabels();

  return (
    <div style={fieldGroupStyle}>
      {/* Validation type */}
      <div>
        <label style={labelStyle}>Allow:</label>
        <select
          style={selectStyle}
          value={validationType}
          onChange={(e) => onChangeType(e.target.value as DataValidationType)}
        >
          {VALIDATION_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {/* Operator (for numeric types) */}
      {showOperator && (
        <div>
          <label style={labelStyle}>Data:</label>
          <select
            style={selectStyle}
            value={operator}
            onChange={(e) => onChangeOperator(e.target.value as DataValidationOperator)}
          >
            {OPERATORS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Value fields (for numeric types) */}
      {showValueFields && (
        <>
          <div>
            <label style={labelStyle}>{label1}</label>
            <input
              style={inputStyle}
              type="text"
              value={formula1}
              onChange={(e) => onChangeFormula1(e.target.value)}
              placeholder={validationType === "date" ? "e.g., 2024-01-01" : ""}
            />
          </div>
          {showTwoValues && (
            <div>
              <label style={labelStyle}>{label2}</label>
              <input
                style={inputStyle}
                type="text"
                value={formula2}
                onChange={(e) => onChangeFormula2(e.target.value)}
                placeholder={validationType === "date" ? "e.g., 2024-12-31" : ""}
              />
            </div>
          )}
        </>
      )}

      {/* List source */}
      {showListSource && (
        <div>
          <label style={labelStyle}>Source:</label>
          <input
            style={inputStyle}
            type="text"
            value={listSource}
            onChange={(e) => onChangeListSource(e.target.value)}
            placeholder="e.g., Yes,No,Maybe or =$A$1:$A$10"
          />
        </div>
      )}

      {/* Custom formula */}
      {showCustomFormula && (
        <div>
          <label style={labelStyle}>Formula:</label>
          <input
            style={inputStyle}
            type="text"
            value={customFormula}
            onChange={(e) => onChangeCustomFormula(e.target.value)}
            placeholder='e.g., =AND(LEN(A1)>0, LEN(A1)<=10)'
          />
        </div>
      )}

      {/* Checkboxes */}
      {validationType !== "none" && (
        <>
          <div style={checkboxRowStyle}>
            <input
              type="checkbox"
              id="dv-ignore-blanks"
              checked={ignoreBlanks}
              onChange={(e) => onChangeIgnoreBlanks(e.target.checked)}
            />
            <label htmlFor="dv-ignore-blanks" style={labelStyle}>
              Ignore blank
            </label>
          </div>

          {showListSource && (
            <div style={checkboxRowStyle}>
              <input
                type="checkbox"
                id="dv-in-cell-dropdown"
                checked={inCellDropdown}
                onChange={(e) => onChangeInCellDropdown(e.target.checked)}
              />
              <label htmlFor="dv-in-cell-dropdown" style={labelStyle}>
                In-cell dropdown
              </label>
            </div>
          )}
        </>
      )}
    </div>
  );
}
