//! FILENAME: app/extensions/_standard/conditional-formatting/components/RuleEditor.tsx
// PURPOSE: Editor component for creating/editing a single rule
// CONTEXT: Used within the RuleManagerDialog

import React, { useCallback } from "react";
import type { 
  ConditionalRule, 
  RuleCondition, 
  RuleType,
  ComparisonOperator,
  TextOperator,
  CellValueCondition,
  TextCondition,
  Top10Condition,
  AboveAverageCondition,
  DuplicatesCondition,
} from "../types";
import { 
  PRESET_STYLES, 
  COMPARISON_OPERATOR_LABELS, 
  TEXT_OPERATOR_LABELS 
} from "../types";
import type { IStyleOverride } from "../../../../src/api/styleInterceptors";
import { StylePreview } from "./StylePreview";
import { ColorPicker } from "./ColorPicker";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "16px",
  },
  section: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "8px",
  },
  sectionTitle: {
    fontWeight: 600,
    fontSize: "12px",
    textTransform: "uppercase" as const,
    color: "#666",
    marginBottom: "4px",
  },
  formGroup: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
  },
  label: {
    fontSize: "12px",
    fontWeight: 500,
    color: "#333",
  },
  input: {
    padding: "6px 10px",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    fontSize: "13px",
    outline: "none",
  },
  select: {
    padding: "6px 10px",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    fontSize: "13px",
    backgroundColor: "#fff",
    cursor: "pointer",
  },
  row: {
    display: "flex",
    gap: "12px",
    alignItems: "flex-end",
  },
  flex1: {
    flex: 1,
  },
  rangeGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "8px",
  },
  presetGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "8px",
  },
  presetButton: {
    padding: "8px",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    backgroundColor: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    fontSize: "11px",
    transition: "all 0.15s ease",
  },
  presetButtonSelected: {
    borderColor: "#0078d4",
    backgroundColor: "#f0f7ff",
  },
  checkbox: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  customStyleGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
  },
};

// ============================================================================
// Props
// ============================================================================

export interface RuleEditorProps {
  rule: ConditionalRule;
  onChange: (updates: Partial<ConditionalRule>) => void;
  isNew: boolean;
}

// ============================================================================
// Rule Type Options
// ============================================================================

const RULE_TYPE_OPTIONS: { value: RuleType; label: string }[] = [
  { value: "cellValue", label: "Cell Value" },
  { value: "text", label: "Text" },
  { value: "top10", label: "Top/Bottom Values" },
  { value: "aboveAverage", label: "Above/Below Average" },
  { value: "duplicates", label: "Duplicate/Unique Values" },
  { value: "formula", label: "Formula (Custom)" },
];

// ============================================================================
// Component
// ============================================================================

export function RuleEditor({ rule, onChange, isNew }: RuleEditorProps): React.ReactElement {
  // Handle condition type change
  const handleConditionTypeChange = useCallback((type: RuleType) => {
    let newCondition: RuleCondition;
    
    switch (type) {
      case "cellValue":
        newCondition = { type: "cellValue", operator: "greaterThan", value1: 0 };
        break;
      case "text":
        newCondition = { type: "text", operator: "contains", value: "" };
        break;
      case "top10":
        newCondition = { type: "top10", direction: "top", count: 10 };
        break;
      case "aboveAverage":
        newCondition = { type: "aboveAverage", direction: "above" };
        break;
      case "duplicates":
        newCondition = { type: "duplicates", unique: false };
        break;
      case "formula":
        newCondition = { type: "formula", formula: "=A1>0" };
        break;
      default:
        return;
    }
    
    onChange({ condition: newCondition });
  }, [onChange]);
  
  // Handle condition property change
  const handleConditionChange = useCallback(<K extends keyof RuleCondition>(
    key: K,
    value: RuleCondition[K]
  ) => {
    onChange({ condition: { ...rule.condition, [key]: value } as RuleCondition });
  }, [rule.condition, onChange]);
  
  // Handle style change
  const handleStyleChange = useCallback((style: IStyleOverride) => {
    onChange({ style });
  }, [onChange]);
  
  // Handle range change
  const handleRangeChange = useCallback((
    key: "startRow" | "startCol" | "endRow" | "endCol",
    value: number
  ) => {
    onChange({ range: { ...rule.range, [key]: value } });
  }, [rule.range, onChange]);
  
  // Render condition-specific editor
  const renderConditionEditor = () => {
    const condition = rule.condition;
    
    switch (condition.type) {
      case "cellValue":
        return renderCellValueEditor(condition);
      case "text":
        return renderTextEditor(condition);
      case "top10":
        return renderTop10Editor(condition);
      case "aboveAverage":
        return renderAboveAverageEditor(condition);
      case "duplicates":
        return renderDuplicatesEditor(condition);
      case "formula":
        return renderFormulaEditor(condition);
      default:
        return null;
    }
  };
  
  // Cell Value condition editor
  const renderCellValueEditor = (condition: CellValueCondition) => (
    <div style={styles.section}>
      <div style={styles.row}>
        <div style={{ ...styles.formGroup, ...styles.flex1 }}>
          <label style={styles.label}>Operator</label>
          <select
            style={styles.select}
            value={condition.operator}
            onChange={(e) => handleConditionChange("operator", e.target.value as ComparisonOperator)}
          >
            {Object.entries(COMPARISON_OPERATOR_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div style={{ ...styles.formGroup, ...styles.flex1 }}>
          <label style={styles.label}>Value 1</label>
          <input
            type="text"
            style={styles.input}
            value={condition.value1}
            onChange={(e) => handleConditionChange("value1", e.target.value)}
          />
        </div>
        {(condition.operator === "between" || condition.operator === "notBetween") && (
          <div style={{ ...styles.formGroup, ...styles.flex1 }}>
            <label style={styles.label}>Value 2</label>
            <input
              type="text"
              style={styles.input}
              value={condition.value2 ?? ""}
              onChange={(e) => handleConditionChange("value2", e.target.value)}
            />
          </div>
        )}
      </div>
    </div>
  );
  
  // Text condition editor
  const renderTextEditor = (condition: TextCondition) => (
    <div style={styles.section}>
      <div style={styles.row}>
        <div style={{ ...styles.formGroup, ...styles.flex1 }}>
          <label style={styles.label}>Operator</label>
          <select
            style={styles.select}
            value={condition.operator}
            onChange={(e) => handleConditionChange("operator", e.target.value as TextOperator)}
          >
            {Object.entries(TEXT_OPERATOR_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div style={{ ...styles.formGroup, ...styles.flex1 }}>
          <label style={styles.label}>Text</label>
          <input
            type="text"
            style={styles.input}
            value={condition.value}
            onChange={(e) => handleConditionChange("value", e.target.value)}
          />
        </div>
      </div>
      <div style={styles.checkbox}>
        <input
          type="checkbox"
          checked={condition.caseSensitive ?? false}
          onChange={(e) => handleConditionChange("caseSensitive", e.target.checked)}
        />
        <label style={styles.label}>Case sensitive</label>
      </div>
    </div>
  );
  
  // Top 10 condition editor
  const renderTop10Editor = (condition: Top10Condition) => (
    <div style={styles.section}>
      <div style={styles.row}>
        <div style={{ ...styles.formGroup, ...styles.flex1 }}>
          <label style={styles.label}>Direction</label>
          <select
            style={styles.select}
            value={condition.direction}
            onChange={(e) => handleConditionChange("direction", e.target.value as "top" | "bottom")}
          >
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
          </select>
        </div>
        <div style={{ ...styles.formGroup, ...styles.flex1 }}>
          <label style={styles.label}>Count</label>
          <input
            type="number"
            style={styles.input}
            value={condition.count}
            min={1}
            max={100}
            onChange={(e) => handleConditionChange("count", parseInt(e.target.value) || 10)}
          />
        </div>
      </div>
      <div style={styles.checkbox}>
        <input
          type="checkbox"
          checked={condition.percent ?? false}
          onChange={(e) => handleConditionChange("percent", e.target.checked)}
        />
        <label style={styles.label}>Percentage (instead of count)</label>
      </div>
    </div>
  );
  
  // Above Average condition editor
  const renderAboveAverageEditor = (condition: AboveAverageCondition) => (
    <div style={styles.section}>
      <div style={styles.formGroup}>
        <label style={styles.label}>Direction</label>
        <select
          style={styles.select}
          value={condition.direction}
          onChange={(e) => handleConditionChange(
            "direction", 
            e.target.value as "above" | "below" | "equalOrAbove" | "equalOrBelow"
          )}
        >
          <option value="above">Above average</option>
          <option value="below">Below average</option>
          <option value="equalOrAbove">Equal to or above average</option>
          <option value="equalOrBelow">Equal to or below average</option>
        </select>
      </div>
    </div>
  );
  
  // Duplicates condition editor
  const renderDuplicatesEditor = (condition: DuplicatesCondition) => (
    <div style={styles.section}>
      <div style={styles.formGroup}>
        <label style={styles.label}>Highlight</label>
        <select
          style={styles.select}
          value={condition.unique ? "unique" : "duplicate"}
          onChange={(e) => handleConditionChange("unique", e.target.value === "unique")}
        >
          <option value="duplicate">Duplicate values</option>
          <option value="unique">Unique values</option>
        </select>
      </div>
    </div>
  );
  
  // Formula condition editor
  const renderFormulaEditor = (condition: { type: "formula"; formula: string }) => (
    <div style={styles.section}>
      <div style={styles.formGroup}>
        <label style={styles.label}>Formula</label>
        <input
          type="text"
          style={styles.input}
          value={condition.formula}
          placeholder="=A1>B1"
          onChange={(e) => handleConditionChange("formula", e.target.value)}
        />
      </div>
      <p style={{ fontSize: "11px", color: "#666", margin: 0 }}>
        Enter a formula that returns TRUE or FALSE. Use relative references.
      </p>
    </div>
  );
  
  // Style presets
  const stylePresets = Object.entries(PRESET_STYLES).map(([key, style]) => ({
    id: key,
    label: key.replace(/([A-Z])/g, " $1").trim(),
    style,
  }));
  
  return (
    <div style={styles.container}>
      {/* Rule Name */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Rule Name</div>
        <input
          type="text"
          style={styles.input}
          value={rule.name ?? ""}
          placeholder="Enter a name for this rule"
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </div>
      
      {/* Condition Type */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Condition Type</div>
        <select
          style={styles.select}
          value={rule.condition.type}
          onChange={(e) => handleConditionTypeChange(e.target.value as RuleType)}
        >
          {RULE_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      
      {/* Condition Settings */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Condition Settings</div>
        {renderConditionEditor()}
      </div>
      
      {/* Apply Range */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Apply to Range</div>
        <div style={styles.rangeGrid}>
          <div style={styles.formGroup}>
            <label style={styles.label}>Start Row</label>
            <input
              type="number"
              style={styles.input}
              value={rule.range.startRow}
              min={0}
              onChange={(e) => handleRangeChange("startRow", parseInt(e.target.value) || 0)}
            />
          </div>
          <div style={styles.formGroup}>
            <label style={styles.label}>Start Column</label>
            <input
              type="number"
              style={styles.input}
              value={rule.range.startCol}
              min={0}
              onChange={(e) => handleRangeChange("startCol", parseInt(e.target.value) || 0)}
            />
          </div>
          <div style={styles.formGroup}>
            <label style={styles.label}>End Row</label>
            <input
              type="number"
              style={styles.input}
              value={rule.range.endRow}
              min={rule.range.startRow}
              onChange={(e) => handleRangeChange("endRow", parseInt(e.target.value) || 0)}
            />
          </div>
          <div style={styles.formGroup}>
            <label style={styles.label}>End Column</label>
            <input
              type="number"
              style={styles.input}
              value={rule.range.endCol}
              min={rule.range.startCol}
              onChange={(e) => handleRangeChange("endCol", parseInt(e.target.value) || 0)}
            />
          </div>
        </div>
      </div>
      
      {/* Style */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Formatting Style</div>
        
        {/* Presets */}
        <div style={styles.presetGrid}>
          {stylePresets.map((preset) => (
            <button
              key={preset.id}
              style={{
                ...styles.presetButton,
                ...(JSON.stringify(rule.style) === JSON.stringify(preset.style) 
                  ? styles.presetButtonSelected 
                  : {}),
              }}
              onClick={() => handleStyleChange(preset.style)}
            >
              <StylePreview style={preset.style} size="small" />
              <span>{preset.label}</span>
            </button>
          ))}
        </div>
        
        {/* Custom Style */}
        <div style={{ marginTop: "12px" }}>
          <div style={styles.sectionTitle}>Custom Style</div>
          <div style={styles.customStyleGrid}>
            <div style={styles.formGroup}>
              <label style={styles.label}>Background Color</label>
              <ColorPicker
                value={rule.style.backgroundColor}
                onChange={(color) => handleStyleChange({ 
                  ...rule.style, 
                  backgroundColor: color 
                })}
              />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Text Color</label>
              <ColorPicker
                value={rule.style.textColor}
                onChange={(color) => handleStyleChange({ 
                  ...rule.style, 
                  textColor: color 
                })}
              />
            </div>
          </div>
          <div style={{ ...styles.row, marginTop: "8px" }}>
            <div style={styles.checkbox}>
              <input
                type="checkbox"
                checked={rule.style.bold ?? false}
                onChange={(e) => handleStyleChange({ ...rule.style, bold: e.target.checked })}
              />
              <label style={styles.label}>Bold</label>
            </div>
            <div style={styles.checkbox}>
              <input
                type="checkbox"
                checked={rule.style.italic ?? false}
                onChange={(e) => handleStyleChange({ ...rule.style, italic: e.target.checked })}
              />
              <label style={styles.label}>Italic</label>
            </div>
            <div style={styles.checkbox}>
              <input
                type="checkbox"
                checked={rule.style.underline ?? false}
                onChange={(e) => handleStyleChange({ ...rule.style, underline: e.target.checked })}
              />
              <label style={styles.label}>Underline</label>
            </div>
          </div>
        </div>
        
        {/* Preview */}
        <div style={{ marginTop: "12px" }}>
          <div style={styles.sectionTitle}>Preview</div>
          <StylePreview style={rule.style} size="large" showLabel />
        </div>
      </div>
      
      {/* Options */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Options</div>
        <div style={styles.checkbox}>
          <input
            type="checkbox"
            checked={rule.stopIfTrue ?? false}
            onChange={(e) => onChange({ stopIfTrue: e.target.checked })}
          />
          <label style={styles.label}>Stop if True (don't evaluate subsequent rules)</label>
        </div>
      </div>
    </div>
  );
}