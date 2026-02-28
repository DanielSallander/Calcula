//! FILENAME: app/extensions/ConditionalFormatting/components/QuickCFDialog.tsx
// PURPOSE: Quick configuration dialog for adding a conditional formatting rule.
// CONTEXT: Opened from the Format > Conditional Formatting menu for threshold-based rules.

import React, { useState, useCallback } from "react";
import type { DialogProps } from "../../../src/api";
import {
  addConditionalFormat,
  restoreFocusToGrid,
} from "../../../src/api";
import type {
  ConditionalFormatRule,
  ConditionalFormat,
  ConditionalFormatRange,
} from "../../../src/api";
import { invalidateAndRefresh } from "../lib/cfStore";
import { PRESET_STYLES } from "../types";

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
  color: "#333",
  border: "1px solid #888",
  borderRadius: 4,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
  width: 380,
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  margin: 0,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "4px 8px",
  border: "1px solid #aaa",
  borderRadius: 3,
  fontSize: 13,
  color: "#333",
  backgroundColor: "#fff",
};

const selectStyle: React.CSSProperties = {
  flex: 1,
  padding: "4px 8px",
  border: "1px solid #aaa",
  borderRadius: 3,
  fontSize: 13,
  color: "#333",
  backgroundColor: "#fff",
};

const buttonRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 4,
};

const buttonStyle: React.CSSProperties = {
  padding: "5px 16px",
  border: "1px solid #aaa",
  borderRadius: 3,
  fontSize: 13,
  cursor: "pointer",
  backgroundColor: "#fff",
  color: "#333",
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#0078d4",
  color: "#fff",
  borderColor: "#0060b0",
};

// ============================================================================
// Rule Type Definitions
// ============================================================================

/** Rule types that use a text input */
const INPUT_RULE_TYPES = [
  "greaterThan", "lessThan", "between", "equalTo", "textContains",
  "top10Items", "top10Percent", "bottom10Items", "bottom10Percent",
  "newRule",
];

/** Rule types that use a dropdown instead of text input */
const DROPDOWN_RULE_TYPES = [
  "duplicateValues", "uniqueValues", "aboveAverage", "belowAverage",
];

interface QuickRuleDef {
  title: string;
  label1: string;
  label2?: string;
  placeholder1?: string;
  placeholder2?: string;
}

const RULE_DEFS: Record<string, QuickRuleDef> = {
  greaterThan: { title: "Greater Than", label1: "Format cells that are GREATER THAN:" },
  lessThan: { title: "Less Than", label1: "Format cells that are LESS THAN:" },
  between: { title: "Between", label1: "Format cells that are BETWEEN:", label2: "and:", placeholder1: "Min value", placeholder2: "Max value" },
  equalTo: { title: "Equal To", label1: "Format cells that are EQUAL TO:" },
  textContains: { title: "Text That Contains", label1: "Format cells that contain the text:" },
  top10Items: { title: "Top 10 Items", label1: "Format cells that rank in the TOP:" },
  top10Percent: { title: "Top 10%", label1: "Format cells that rank in the TOP:" },
  bottom10Items: { title: "Bottom 10 Items", label1: "Format cells that rank in the BOTTOM:" },
  bottom10Percent: { title: "Bottom 10%", label1: "Format cells that rank in the BOTTOM:" },
  newRule: { title: "New Rule", label1: "Enter a formula:" },
  duplicateValues: { title: "Duplicate Values", label1: "Format cells that contain:" },
  uniqueValues: { title: "Unique Values", label1: "Format cells that contain:" },
  aboveAverage: { title: "Above Average", label1: "Format cells that are:" },
  belowAverage: { title: "Below Average", label1: "Format cells that are:" },
};

// ============================================================================
// Component
// ============================================================================

export const QuickCFDialog: React.FC<DialogProps> = ({ isOpen, onClose, data }) => {
  const ruleType = (data?.ruleType as string) || "greaterThan";
  const selection = data?.selection as ConditionalFormatRange | null;
  const def = RULE_DEFS[ruleType] || RULE_DEFS.greaterThan;

  const [value1, setValue1] = useState(ruleType.includes("10") ? "10" : "");
  const [value2, setValue2] = useState("");
  const [formatIndex, setFormatIndex] = useState(0);

  // Dropdown state for duplicate/unique and above/below average
  const [dropdownValue, setDropdownValue] = useState(() => {
    if (ruleType === "duplicateValues") return "duplicate";
    if (ruleType === "uniqueValues") return "unique";
    if (ruleType === "aboveAverage") return "aboveAverage";
    if (ruleType === "belowAverage") return "belowAverage";
    return "";
  });

  const isDropdownType = DROPDOWN_RULE_TYPES.includes(ruleType);
  const isInputType = INPUT_RULE_TYPES.includes(ruleType);

  const handleOk = useCallback(async () => {
    if (!selection) {
      onClose();
      return;
    }

    let rule: ConditionalFormatRule;
    const preset = PRESET_STYLES[formatIndex];
    const format: ConditionalFormat = {
      backgroundColor: preset.backgroundColor || undefined,
      textColor: preset.textColor || undefined,
    };

    switch (ruleType) {
      case "greaterThan":
        rule = { type: "cellValue", operator: "greaterThan", value1 };
        break;
      case "lessThan":
        rule = { type: "cellValue", operator: "lessThan", value1 };
        break;
      case "between":
        rule = { type: "cellValue", operator: "between", value1, value2 };
        break;
      case "equalTo":
        rule = { type: "cellValue", operator: "equal", value1 };
        break;
      case "textContains":
        rule = { type: "containsText", ruleType: "contains", text: value1 };
        break;
      case "top10Items":
        rule = { type: "topBottom", ruleType: "topItems", rank: parseInt(value1) || 10 };
        break;
      case "top10Percent":
        rule = { type: "topBottom", ruleType: "topPercent", rank: parseInt(value1) || 10 };
        break;
      case "bottom10Items":
        rule = { type: "topBottom", ruleType: "bottomItems", rank: parseInt(value1) || 10 };
        break;
      case "bottom10Percent":
        rule = { type: "topBottom", ruleType: "bottomPercent", rank: parseInt(value1) || 10 };
        break;
      case "newRule":
        rule = { type: "expression", formula: value1 };
        break;
      case "duplicateValues":
      case "uniqueValues":
        rule = dropdownValue === "unique"
          ? { type: "uniqueValues" }
          : { type: "duplicateValues" };
        break;
      case "aboveAverage":
      case "belowAverage":
        rule = {
          type: "aboveAverage",
          ruleType: dropdownValue as "aboveAverage" | "belowAverage" | "equalOrAboveAverage" | "equalOrBelowAverage" | "oneStdDevAbove" | "oneStdDevBelow" | "twoStdDevAbove" | "twoStdDevBelow" | "threeStdDevAbove" | "threeStdDevBelow",
        };
        break;
      default:
        onClose();
        return;
    }

    await addConditionalFormat({
      rule,
      format,
      ranges: [selection],
      stopIfTrue: false,
    });

    await invalidateAndRefresh();
    onClose();
    restoreFocusToGrid();
  }, [ruleType, value1, value2, formatIndex, dropdownValue, selection, onClose]);

  const handleCancel = useCallback(() => {
    onClose();
    restoreFocusToGrid();
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <div style={overlayStyle} onMouseDown={(e) => { if (e.target === e.currentTarget) handleCancel(); }}>
      <div style={dialogStyle} onMouseDown={(e) => e.stopPropagation()}>
        <h3 style={titleStyle}>{def.title}</h3>

        <div style={rowStyle}>
          <span style={{ fontSize: 13, minWidth: 0, flex: 1 }}>{def.label1}</span>
        </div>

        {/* Dropdown for duplicate/unique values */}
        {(ruleType === "duplicateValues" || ruleType === "uniqueValues") && (
          <div style={rowStyle}>
            <select
              style={selectStyle}
              value={dropdownValue}
              onChange={(e) => setDropdownValue(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleOk(); if (e.key === "Escape") handleCancel(); }}
            >
              <option value="duplicate">Duplicate</option>
              <option value="unique">Unique</option>
            </select>
            <span style={{ fontSize: 13 }}>values in the selected range</span>
          </div>
        )}

        {/* Dropdown for above/below average */}
        {(ruleType === "aboveAverage" || ruleType === "belowAverage") && (
          <div style={rowStyle}>
            <select
              style={selectStyle}
              value={dropdownValue}
              onChange={(e) => setDropdownValue(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleOk(); if (e.key === "Escape") handleCancel(); }}
            >
              <option value="aboveAverage">Above Average</option>
              <option value="belowAverage">Below Average</option>
              <option value="equalOrAboveAverage">Equal or Above Average</option>
              <option value="equalOrBelowAverage">Equal or Below Average</option>
              <option value="oneStdDevAbove">1 Std Dev Above</option>
              <option value="oneStdDevBelow">1 Std Dev Below</option>
              <option value="twoStdDevAbove">2 Std Dev Above</option>
              <option value="twoStdDevBelow">2 Std Dev Below</option>
              <option value="threeStdDevAbove">3 Std Dev Above</option>
              <option value="threeStdDevBelow">3 Std Dev Below</option>
            </select>
          </div>
        )}

        {/* Text input for value-based rules */}
        {isInputType && (
          <div style={rowStyle}>
            <input
              type="text"
              style={inputStyle}
              value={value1}
              onChange={(e) => setValue1(e.target.value)}
              placeholder={def.placeholder1 || "Enter value"}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleOk(); if (e.key === "Escape") handleCancel(); }}
            />
          </div>
        )}

        {def.label2 && (
          <>
            <div style={rowStyle}>
              <span style={{ fontSize: 13 }}>{def.label2}</span>
            </div>
            <div style={rowStyle}>
              <input
                type="text"
                style={inputStyle}
                value={value2}
                onChange={(e) => setValue2(e.target.value)}
                placeholder={def.placeholder2 || "Enter value"}
                onKeyDown={(e) => { if (e.key === "Enter") handleOk(); if (e.key === "Escape") handleCancel(); }}
              />
            </div>
          </>
        )}

        <div style={rowStyle}>
          <span style={{ fontSize: 13 }}>with:</span>
          <select
            style={selectStyle}
            value={formatIndex}
            onChange={(e) => setFormatIndex(Number(e.target.value))}
          >
            {PRESET_STYLES.map((preset, idx) => (
              <option key={idx} value={idx}>{preset.label}</option>
            ))}
          </select>
        </div>

        {/* Format preview */}
        <div
          style={{
            padding: "6px 12px",
            borderRadius: 3,
            border: "1px solid #ccc",
            fontSize: 13,
            backgroundColor: PRESET_STYLES[formatIndex].backgroundColor || "#fff",
            color: PRESET_STYLES[formatIndex].textColor || "#000",
          }}
        >
          AaBbCcYyZz
        </div>

        <div style={buttonRowStyle}>
          <button style={buttonStyle} onClick={handleCancel}>Cancel</button>
          <button style={primaryButtonStyle} onClick={handleOk}>OK</button>
        </div>
      </div>
    </div>
  );
};
