//! FILENAME: app/extensions/Controls/PropertiesPane/PropertyRow.tsx
// PURPOSE: A single property editor row in the Properties Pane.
// CONTEXT: Supports static values, formula mode, color pickers, and script selection.

import React, { useState, useEffect, useCallback } from "react";
import type { ControlPropertyValue, PropertyDefinition } from "../lib/types";

// ============================================================================
// Styles
// ============================================================================

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: "4px 10px",
  borderBottom: "1px solid #F0F0F0",
  gap: 2,
};

const labelRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 11,
  color: "#555",
};

const labelStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 11,
};

const modeToggleStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#0078d4",
  cursor: "pointer",
  border: "none",
  background: "none",
  padding: "0 2px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "3px 6px",
  border: "1px solid #D0D0D0",
  borderRadius: 2,
  fontSize: 12,
  fontFamily: "Segoe UI, Tahoma, sans-serif",
  outline: "none",
  boxSizing: "border-box",
};

const formulaInputStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: "Consolas, 'Courier New', monospace",
  backgroundColor: "#FFFBE6",
  borderColor: "#D4A017",
};

const colorInputContainerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};

const colorSwatchStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  border: "1px solid #CCC",
  borderRadius: 2,
  cursor: "pointer",
  flexShrink: 0,
};

const scriptSelectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
  backgroundColor: "#FFF",
};

const checkboxContainerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  cursor: "pointer",
};

// ============================================================================
// Props
// ============================================================================

interface PropertyRowProps {
  definition: PropertyDefinition;
  value: ControlPropertyValue | undefined;
  scripts: Array<{ id: string; name: string }>;
  onChange: (key: string, valueType: "static" | "formula", value: string) => void;
}

// ============================================================================
// Component
// ============================================================================

export const PropertyRow: React.FC<PropertyRowProps> = ({
  definition,
  value,
  scripts,
  onChange,
}) => {
  const currentValue = value?.value ?? definition.defaultValue;
  const isFormula = value?.valueType === "formula";
  const [localValue, setLocalValue] = useState(currentValue);
  const [formulaMode, setFormulaMode] = useState(isFormula);

  // Sync local state when external value changes
  useEffect(() => {
    setLocalValue(value?.value ?? definition.defaultValue);
    setFormulaMode(value?.valueType === "formula");
  }, [value, definition.defaultValue]);

  const handleCommit = useCallback(
    (newValue: string) => {
      const vType = formulaMode ? "formula" : "static";
      onChange(definition.key, vType, newValue);
    },
    [formulaMode, onChange, definition.key],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const newVal = e.target.value;
      setLocalValue(newVal);
    },
    [],
  );

  const handleInputBlur = useCallback(() => {
    handleCommit(localValue);
  }, [localValue, handleCommit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleCommit(localValue);
      }
    },
    [localValue, handleCommit],
  );

  const toggleFormulaMode = useCallback(() => {
    if (!definition.supportsFormula) return;
    const newMode = !formulaMode;
    setFormulaMode(newMode);
    // If switching to formula mode, prefix with = if not already
    if (newMode && !localValue.startsWith("=")) {
      const newVal = "=" + localValue;
      setLocalValue(newVal);
      onChange(definition.key, "formula", newVal);
    } else if (!newMode && localValue.startsWith("=")) {
      const newVal = localValue.slice(1);
      setLocalValue(newVal);
      onChange(definition.key, "static", newVal);
    }
  }, [formulaMode, localValue, definition, onChange]);

  // Render different input types
  const renderInput = () => {
    // Formula mode overrides all input types
    if (formulaMode) {
      return (
        <input
          type="text"
          style={formulaInputStyle}
          value={localValue}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onKeyDown={handleKeyDown}
          placeholder="=formula"
        />
      );
    }

    switch (definition.inputType) {
      case "color":
        return (
          <div style={colorInputContainerStyle}>
            <input
              type="color"
              style={colorSwatchStyle}
              value={localValue || "#000000"}
              onChange={(e) => {
                setLocalValue(e.target.value);
                handleCommit(e.target.value);
              }}
            />
            <input
              type="text"
              style={{ ...inputStyle, flex: 1 }}
              value={localValue}
              onChange={handleInputChange}
              onBlur={handleInputBlur}
              onKeyDown={handleKeyDown}
              placeholder="#000000"
            />
          </div>
        );

      case "number":
        return (
          <input
            type="number"
            style={inputStyle}
            value={localValue}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            onKeyDown={handleKeyDown}
            min={1}
            max={72}
          />
        );

      case "boolean":
        return (
          <label style={checkboxContainerStyle}>
            <input
              type="checkbox"
              checked={localValue === "true"}
              onChange={(e) => {
                const newVal = e.target.checked ? "true" : "false";
                setLocalValue(newVal);
                onChange(definition.key, "static", newVal);
              }}
            />
            {localValue === "true" ? "Yes" : "No"}
          </label>
        );

      case "script":
        return (
          <select
            style={scriptSelectStyle}
            value={localValue}
            onChange={(e) => {
              const newVal = e.target.value;
              setLocalValue(newVal);
              onChange(definition.key, "static", newVal);
            }}
          >
            <option value="">(None)</option>
            {scripts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        );

      default:
        return (
          <input
            type="text"
            style={inputStyle}
            value={localValue}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            onKeyDown={handleKeyDown}
          />
        );
    }
  };

  return (
    <div style={rowStyle}>
      <div style={labelRowStyle}>
        <span style={labelStyle}>{definition.label}</span>
        {definition.supportsFormula && (
          <button
            style={{
              ...modeToggleStyle,
              fontWeight: formulaMode ? 700 : 400,
            }}
            onClick={toggleFormulaMode}
            title={formulaMode ? "Switch to static value" : "Switch to formula"}
          >
            {formulaMode ? "fx" : "fx"}
          </button>
        )}
      </div>
      {renderInput()}
    </div>
  );
};
