//! FILENAME: app/extensions/ConditionalFormatting/components/QuickCFDialog.tsx
// PURPOSE: Quick configuration dialog for adding a conditional formatting rule.
// CONTEXT: Opened from the Home > Conditional Formatting menu for threshold-based rules.

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
};

const selectStyle: React.CSSProperties = {
  flex: 1,
  padding: "4px 8px",
  border: "1px solid #aaa",
  borderRadius: 3,
  fontSize: 13,
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
  }, [ruleType, value1, value2, formatIndex, selection, onClose]);

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
