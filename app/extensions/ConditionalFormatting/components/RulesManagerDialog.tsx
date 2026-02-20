//! FILENAME: app/extensions/ConditionalFormatting/components/RulesManagerDialog.tsx
// PURPOSE: Conditional Formatting Rules Manager dialog.
// CONTEXT: Lists all CF rules for the current sheet, allows reorder, delete, edit, toggle.

import React, { useState, useEffect, useCallback } from "react";
import type { DialogProps } from "../../../src/api";
import {
  deleteConditionalFormat,
  reorderConditionalFormats,
  updateConditionalFormat,
  restoreFocusToGrid,
} from "../../../src/api";
import type { ConditionalFormatDefinition } from "../../../src/api";
import { getRules, invalidateAndRefresh } from "../lib/cfStore";

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
  width: 540,
  maxHeight: "80vh",
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

const listStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 200,
  maxHeight: 350,
  overflow: "auto",
  border: "1px solid #ccc",
  borderRadius: 3,
  backgroundColor: "#fff",
};

const ruleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderBottom: "1px solid #e0e0e0",
  fontSize: 13,
  cursor: "pointer",
};

const selectedRowStyle: React.CSSProperties = {
  ...ruleRowStyle,
  backgroundColor: "#d4e8fc",
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  justifyContent: "flex-start",
  flexWrap: "wrap",
};

const toolButtonStyle: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid #aaa",
  borderRadius: 3,
  fontSize: 12,
  cursor: "pointer",
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
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: "#0078d4",
  color: "#fff",
  borderColor: "#0060b0",
};

// ============================================================================
// Helpers
// ============================================================================

/** Format a rule's condition as a short human-readable summary */
function describeRule(rule: ConditionalFormatDefinition): string {
  const r = rule.rule;
  switch (r.type) {
    case "cellValue":
      return `Cell Value ${r.operator} ${r.value1}${r.value2 ? ` and ${r.value2}` : ""}`;
    case "containsText":
      return `Text ${r.ruleType}: "${r.text}"`;
    case "topBottom":
      return `${r.ruleType === "topItems" || r.ruleType === "topPercent" ? "Top" : "Bottom"} ${r.rank}${r.ruleType.includes("Percent") ? "%" : " items"}`;
    case "aboveAverage":
      return r.ruleType.replace(/([A-Z])/g, " $1").trim();
    case "duplicateValues":
      return "Duplicate Values";
    case "uniqueValues":
      return "Unique Values";
    case "blankCells":
      return "Blank Cells";
    case "noBlanks":
      return "No Blanks";
    case "errorCells":
      return "Error Cells";
    case "noErrors":
      return "No Errors";
    case "expression":
      return `Formula: ${r.formula}`;
    case "timePeriod":
      return `Date: ${r.period}`;
    case "colorScale":
      return "Color Scale";
    case "dataBar":
      return "Data Bar";
    case "iconSet":
      return `Icon Set: ${r.iconSet}`;
    default:
      return "Unknown Rule";
  }
}

/** Format range references as A1 notation */
function describeRanges(rule: ConditionalFormatDefinition): string {
  return rule.ranges
    .map((r) => {
      const startCol = String.fromCharCode(65 + Math.min(r.startCol, 25));
      const endCol = String.fromCharCode(65 + Math.min(r.endCol, 25));
      return `${startCol}${r.startRow + 1}:${endCol}${r.endRow + 1}`;
    })
    .join(", ");
}

// ============================================================================
// Component
// ============================================================================

export const RulesManagerDialog: React.FC<DialogProps> = ({
  isOpen,
  onClose,
}) => {
  const [rules, setRules] = useState<ConditionalFormatDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Load rules when dialog opens
  useEffect(() => {
    if (isOpen) {
      setRules([...getRules()]);
      setSelectedId(null);
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    onClose();
    restoreFocusToGrid();
  }, [onClose]);

  const handleDelete = useCallback(async () => {
    if (selectedId == null) return;
    await deleteConditionalFormat(selectedId);
    await invalidateAndRefresh();
    setRules([...getRules()]);
    setSelectedId(null);
  }, [selectedId]);

  const handleMoveUp = useCallback(async () => {
    if (selectedId == null) return;
    const idx = rules.findIndex((r) => r.id === selectedId);
    if (idx <= 0) return;

    const newOrder = [...rules];
    [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];
    const ids = newOrder.map((r) => r.id);
    await reorderConditionalFormats(ids);
    await invalidateAndRefresh();
    setRules([...getRules()]);
  }, [selectedId, rules]);

  const handleMoveDown = useCallback(async () => {
    if (selectedId == null) return;
    const idx = rules.findIndex((r) => r.id === selectedId);
    if (idx < 0 || idx >= rules.length - 1) return;

    const newOrder = [...rules];
    [newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]];
    const ids = newOrder.map((r) => r.id);
    await reorderConditionalFormats(ids);
    await invalidateAndRefresh();
    setRules([...getRules()]);
  }, [selectedId, rules]);

  const handleToggleStopIfTrue = useCallback(
    async (ruleId: number) => {
      const rule = rules.find((r) => r.id === ruleId);
      if (!rule) return;

      await updateConditionalFormat({
        ruleId,
        stopIfTrue: !rule.stopIfTrue,
      });
      await invalidateAndRefresh();
      setRules([...getRules()]);
    },
    [rules]
  );

  const handleToggleEnabled = useCallback(
    async (ruleId: number) => {
      const rule = rules.find((r) => r.id === ruleId);
      if (!rule) return;

      await updateConditionalFormat({
        ruleId,
        enabled: !rule.enabled,
      });
      await invalidateAndRefresh();
      setRules([...getRules()]);
    },
    [rules]
  );

  if (!isOpen) return null;

  return (
    <div
      style={overlayStyle}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        style={dialogStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 style={titleStyle}>Conditional Formatting Rules Manager</h3>

        {/* Toolbar */}
        <div style={toolbarStyle}>
          <button
            style={toolButtonStyle}
            onClick={handleMoveUp}
            disabled={selectedId == null}
          >
            Move Up
          </button>
          <button
            style={toolButtonStyle}
            onClick={handleMoveDown}
            disabled={selectedId == null}
          >
            Move Down
          </button>
          <button
            style={{
              ...toolButtonStyle,
              color: selectedId != null ? "#c00" : undefined,
            }}
            onClick={handleDelete}
            disabled={selectedId == null}
          >
            Delete Rule
          </button>
        </div>

        {/* Rules list */}
        <div style={listStyle}>
          {rules.length === 0 && (
            <div
              style={{
                padding: 16,
                textAlign: "center",
                color: "#888",
                fontSize: 13,
              }}
            >
              No conditional formatting rules on this sheet.
            </div>
          )}
          {rules.map((rule) => (
            <div
              key={rule.id}
              style={selectedId === rule.id ? selectedRowStyle : ruleRowStyle}
              onClick={() => setSelectedId(rule.id)}
            >
              {/* Enabled checkbox */}
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={() => handleToggleEnabled(rule.id)}
                onClick={(e) => e.stopPropagation()}
                title="Enable/Disable"
              />

              {/* Format preview swatch */}
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 3,
                  border: "1px solid #ccc",
                  backgroundColor:
                    rule.format.backgroundColor || "#fff",
                  flexShrink: 0,
                }}
              />

              {/* Rule description */}
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  opacity: rule.enabled ? 1 : 0.5,
                }}
              >
                <div
                  style={{
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {describeRule(rule)}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "#666",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  Applies to: {describeRanges(rule)}
                </div>
              </div>

              {/* Stop if True checkbox */}
              <label
                style={{ fontSize: 11, color: "#666", whiteSpace: "nowrap" }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={rule.stopIfTrue}
                  onChange={() => handleToggleStopIfTrue(rule.id)}
                />
                Stop
              </label>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={buttonRowStyle}>
          <button style={primaryButtonStyle} onClick={handleClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
