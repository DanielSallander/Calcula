//! FILENAME: app/extensions/Controls/PropertiesPane/PropertyRow.tsx
// PURPOSE: A single property editor row in the Properties Pane.
// CONTEXT: Auto-detects formula mode when value starts with "=".
//          Supports "'" escape: typing "'=" stores a literal "=" as static text.

import React, { useState, useEffect, useCallback } from "react";
import type { ControlPropertyValue, PropertyDefinition } from "../lib/types";
import { FormulaPropertyInput } from "./FormulaPropertyInput";
import { CodePropertyInput } from "./CodePropertyInput";

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
// Helpers
// ============================================================================

/**
 * Build the display value from stored property data.
 * If the stored value is static but starts with "=", prefix with "'" so
 * the user sees the escape character (mirroring Excel behaviour).
 */
function toDisplayValue(val: ControlPropertyValue | undefined, defaultValue: string): string {
  const v = val?.value ?? defaultValue;
  if (val?.valueType === "static" && v.startsWith("=")) {
    return "'" + v;
  }
  return v;
}

/**
 * Determine valueType and stored value from the user's display input.
 * - "'..." → static, value = rest after "'"
 * - "=..." → formula
 * - anything else → static
 */
function fromDisplayValue(
  displayValue: string,
  supportsFormula: boolean,
): { valueType: "static" | "formula"; value: string } {
  if (displayValue.startsWith("'")) {
    return { valueType: "static", value: displayValue.slice(1) };
  }
  if (supportsFormula && displayValue.startsWith("=")) {
    return { valueType: "formula", value: displayValue };
  }
  return { valueType: "static", value: displayValue };
}

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
  const displayValue = toDisplayValue(value, definition.defaultValue);
  const [localValue, setLocalValue] = useState(displayValue);

  // Sync local state when external value changes
  useEffect(() => {
    setLocalValue(toDisplayValue(value, definition.defaultValue));
  }, [value, definition.defaultValue]);

  // Commit: determine valueType from the display value
  const handleCommit = useCallback(
    (newValue: string) => {
      const { valueType, value: storedValue } = fromDisplayValue(
        newValue,
        definition.supportsFormula,
      );
      onChange(definition.key, valueType, storedValue);
    },
    [onChange, definition.key, definition.supportsFormula],
  );

  // Plain input handlers (for non-formula inputs like boolean, script, plain text/number)
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setLocalValue(e.target.value);
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

  // ---------------------------------------------------------------
  // Render the appropriate input widget
  // ---------------------------------------------------------------
  const renderInput = () => {
    // For properties that support formulas: use the smart FormulaPropertyInput
    // that auto-activates autocomplete and Point mode when value starts with "=".
    if (definition.supportsFormula) {
      const isFormulaLike = localValue.startsWith("=") || localValue.startsWith("'");

      // Color properties: show the color swatch alongside when not in formula mode
      if (definition.inputType === "color" && !isFormulaLike) {
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
            <FormulaPropertyInput
              value={localValue}
              onChange={(newVal) => setLocalValue(newVal)}
              onCommit={(newVal) => {
                setLocalValue(newVal);
                handleCommit(newVal);
              }}
              inputType={definition.inputType}
              placeholder={definition.defaultValue}
            />
          </div>
        );
      }

      return (
        <FormulaPropertyInput
          value={localValue}
          onChange={(newVal) => setLocalValue(newVal)}
          onCommit={(newVal) => {
            setLocalValue(newVal);
            handleCommit(newVal);
          }}
          inputType={definition.inputType}
          placeholder={definition.defaultValue}
        />
      );
    }

    // Non-formula inputs
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

      case "code":
        return (
          <CodePropertyInput
            value={localValue}
            onChange={(newVal) => setLocalValue(newVal)}
            onCommit={(newVal) => {
              setLocalValue(newVal);
              handleCommit(newVal);
            }}
            scripts={scripts}
          />
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
      </div>
      {renderInput()}
    </div>
  );
};
