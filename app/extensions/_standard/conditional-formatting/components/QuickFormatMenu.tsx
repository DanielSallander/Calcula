//! FILENAME: app/extensions/_standard/conditional-formatting/components/QuickFormatMenu.tsx
// PURPOSE: Quick Format context menu for applying preset conditional formats
// CONTEXT: Shown when right-clicking on a selection

import React, { useState, useCallback } from "react";
import { addRule, generateRuleId } from "../index";
import { QUICK_FORMAT_PRESETS, type QuickFormatPreset, type ConditionalRule } from "../types";
import { StylePreview } from "./StylePreview";

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: {
    padding: "4px 0",
    minWidth: "220px",
  },
  menuItem: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 16px",
    cursor: "pointer",
    fontSize: "13px",
    color: "#333",
    backgroundColor: "transparent",
    border: "none",
    width: "100%",
    textAlign: "left" as const,
    transition: "background-color 0.1s ease",
  },
  menuItemHover: {
    backgroundColor: "#f0f0f0",
  },
  separator: {
    height: "1px",
    backgroundColor: "#e0e0e0",
    margin: "4px 0",
  },
  header: {
    padding: "8px 16px",
    fontSize: "11px",
    fontWeight: 600,
    color: "#666",
    textTransform: "uppercase" as const,
  },
  inputDialog: {
    position: "fixed" as const,
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    backgroundColor: "#fff",
    padding: "20px",
    borderRadius: "8px",
    boxShadow: "0 4px 20px rgba(0,0,0,0.2)",
    zIndex: 10000,
    minWidth: "300px",
  },
  overlay: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.3)",
    zIndex: 9999,
  },
  dialogTitle: {
    margin: "0 0 16px 0",
    fontSize: "16px",
    fontWeight: 600,
  },
  input: {
    width: "100%",
    padding: "8px 12px",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    fontSize: "14px",
    marginBottom: "16px",
  },
  buttonRow: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
  },
  button: {
    padding: "8px 16px",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "13px",
  },
  buttonPrimary: {
    backgroundColor: "#0078d4",
    borderColor: "#0078d4",
    color: "#fff",
  },
};

// ============================================================================
// Props
// ============================================================================

export interface QuickFormatMenuProps {
  sheetIndex: number;
  selection: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  };
  onClose: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function QuickFormatMenu({ 
  sheetIndex, 
  selection, 
  onClose 
}: QuickFormatMenuProps): React.ReactElement {
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const [inputDialog, setInputDialog] = useState<{
    preset: QuickFormatPreset;
    label: string;
    placeholder: string;
  } | null>(null);
  const [inputValue, setInputValue] = useState("");
  
  // Handle preset selection
  const handlePresetClick = useCallback((preset: QuickFormatPreset) => {
    // Check if this preset needs user input
    const needsInput = [
      "greater-than",
      "less-than",
      "between",
      "equal-to",
      "text-contains",
    ].includes(preset.id);
    
    if (needsInput) {
      let placeholder = "";
      let label = "";
      
      switch (preset.id) {
        case "greater-than":
          label = "Greater than:";
          placeholder = "Enter a number";
          break;
        case "less-than":
          label = "Less than:";
          placeholder = "Enter a number";
          break;
        case "between":
          label = "Between values:";
          placeholder = "Enter two numbers separated by comma";
          break;
        case "equal-to":
          label = "Equal to:";
          placeholder = "Enter a value";
          break;
        case "text-contains":
          label = "Text contains:";
          placeholder = "Enter text to find";
          break;
      }
      
      setInputDialog({ preset, label, placeholder });
      setInputValue("");
    } else {
      // Apply directly without input
      applyPreset(preset);
    }
  }, []);
  
  // Apply a preset format
  const applyPreset = useCallback((preset: QuickFormatPreset, value?: string) => {
    const condition = preset.createCondition(value);
    
    // For "between" operator, parse the two values
    if (preset.id === "between" && value) {
      const [val1, val2] = value.split(",").map(v => parseFloat(v.trim()));
      if (!isNaN(val1) && !isNaN(val2)) {
        (condition as { type: "cellValue"; operator: "between"; value1: number; value2: number }).value1 = val1;
        (condition as { type: "cellValue"; operator: "between"; value1: number; value2: number }).value2 = val2;
      }
    }
    
    const rule: ConditionalRule = {
      id: generateRuleId(),
      name: preset.label,
      enabled: true,
      condition,
      style: preset.style,
      range: selection,
    };
    
    addRule(sheetIndex, rule);
    onClose();
  }, [sheetIndex, selection, onClose]);
  
  // Handle input dialog submission
  const handleInputSubmit = useCallback(() => {
    if (inputDialog && inputValue.trim()) {
      applyPreset(inputDialog.preset, inputValue);
    }
    setInputDialog(null);
  }, [inputDialog, inputValue, applyPreset]);
  
  // Group presets by category
  const highlightPresets = QUICK_FORMAT_PRESETS.filter(p => 
    ["greater-than", "less-than", "between", "equal-to", "text-contains"].includes(p.id)
  );
  const topBottomPresets = QUICK_FORMAT_PRESETS.filter(p =>
    ["top-10", "bottom-10", "above-average", "below-average"].includes(p.id)
  );
  const duplicatePresets = QUICK_FORMAT_PRESETS.filter(p =>
    ["duplicates", "unique"].includes(p.id)
  );
  
  return (
    <>
      <div style={styles.container}>
        <div style={styles.header}>Highlight Cell Rules</div>
        {highlightPresets.map((preset) => (
          <button
            key={preset.id}
            style={{
              ...styles.menuItem,
              ...(hoveredItem === preset.id ? styles.menuItemHover : {}),
            }}
            onMouseEnter={() => setHoveredItem(preset.id)}
            onMouseLeave={() => setHoveredItem(null)}
            onClick={() => handlePresetClick(preset)}
          >
            <StylePreview style={preset.style} size="small" />
            <span>{preset.label}</span>
          </button>
        ))}
        
        <div style={styles.separator} />
        <div style={styles.header}>Top/Bottom Rules</div>
        {topBottomPresets.map((preset) => (
          <button
            key={preset.id}
            style={{
              ...styles.menuItem,
              ...(hoveredItem === preset.id ? styles.menuItemHover : {}),
            }}
            onMouseEnter={() => setHoveredItem(preset.id)}
            onMouseLeave={() => setHoveredItem(null)}
            onClick={() => handlePresetClick(preset)}
          >
            <StylePreview style={preset.style} size="small" />
            <span>{preset.label}</span>
          </button>
        ))}
        
        <div style={styles.separator} />
        <div style={styles.header}>Duplicate Values</div>
        {duplicatePresets.map((preset) => (
          <button
            key={preset.id}
            style={{
              ...styles.menuItem,
              ...(hoveredItem === preset.id ? styles.menuItemHover : {}),
            }}
            onMouseEnter={() => setHoveredItem(preset.id)}
            onMouseLeave={() => setHoveredItem(null)}
            onClick={() => handlePresetClick(preset)}
          >
            <StylePreview style={preset.style} size="small" />
            <span>{preset.label}</span>
          </button>
        ))}
      </div>
      
      {/* Input Dialog */}
      {inputDialog && (
        <>
          <div style={styles.overlay} onClick={() => setInputDialog(null)} />
          <div style={styles.inputDialog}>
            <h3 style={styles.dialogTitle}>{inputDialog.preset.label}</h3>
            <label style={{ display: "block", marginBottom: "8px", fontSize: "13px" }}>
              {inputDialog.label}
            </label>
            <input
              type="text"
              style={styles.input}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={inputDialog.placeholder}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleInputSubmit();
                } else if (e.key === "Escape") {
                  setInputDialog(null);
                }
              }}
            />
            <div style={styles.buttonRow}>
              <button 
                style={styles.button} 
                onClick={() => setInputDialog(null)}
              >
                Cancel
              </button>
              <button 
                style={{ ...styles.button, ...styles.buttonPrimary }}
                onClick={handleInputSubmit}
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}