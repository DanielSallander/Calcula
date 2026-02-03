//! FILENAME: app/extensions/_standard/conditional-formatting/components/ColorPicker.tsx
// PURPOSE: Simple color picker component
// CONTEXT: Used for selecting background and text colors

import React, { useState, useCallback, useRef, useEffect } from "react";

// ============================================================================
// Preset Colors
// ============================================================================

const PRESET_COLORS = [
  // Row 1 - Reds
  "#ff0000", "#ff6b6b", "#ffc7ce", "#9c0006",
  // Row 2 - Oranges/Yellows  
  "#ff9800", "#ffc000", "#ffeb9c", "#9c5700",
  // Row 3 - Greens
  "#00aa00", "#4caf50", "#c6efce", "#006100",
  // Row 4 - Blues
  "#0078d4", "#5b9bd5", "#bdd7ee", "#003366",
  // Row 5 - Purples/Grays
  "#9c27b0", "#ce93d8", "#d9d9d9", "#333333",
  // Row 6 - Special
  "#ffffff", "#f5f5f5", "#e0e0e0", "#000000",
];

// ============================================================================
// Props
// ============================================================================

export interface ColorPickerProps {
  value?: string;
  onChange: (color: string | undefined) => void;
}

// ============================================================================
// Styles
// ============================================================================

const styles = {
  container: {
    position: "relative" as const,
  },
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 8px",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    backgroundColor: "#fff",
    cursor: "pointer",
    minWidth: "100px",
  },
  swatch: {
    width: "20px",
    height: "20px",
    border: "1px solid #d0d0d0",
    borderRadius: "2px",
  },
  label: {
    fontSize: "12px",
    color: "#333",
    flex: 1,
  },
  dropdown: {
    position: "absolute" as const,
    top: "100%",
    left: 0,
    marginTop: "4px",
    padding: "8px",
    backgroundColor: "#fff",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    zIndex: 1000,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: "4px",
    marginBottom: "8px",
  },
  colorButton: {
    width: "24px",
    height: "24px",
    border: "1px solid #d0d0d0",
    borderRadius: "2px",
    cursor: "pointer",
    padding: 0,
  },
  colorButtonSelected: {
    outline: "2px solid #0078d4",
    outlineOffset: "1px",
  },
  inputRow: {
    display: "flex",
    gap: "4px",
    alignItems: "center",
  },
  input: {
    flex: 1,
    padding: "4px 8px",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    fontSize: "12px",
  },
  clearButton: {
    padding: "4px 8px",
    border: "1px solid #d0d0d0",
    borderRadius: "4px",
    backgroundColor: "#fff",
    cursor: "pointer",
    fontSize: "11px",
  },
};

// ============================================================================
// Component
// ============================================================================

export function ColorPicker({ value, onChange }: ColorPickerProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value ?? "");
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Update input when value prop changes
  useEffect(() => {
    setInputValue(value ?? "");
  }, [value]);
  
  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);
  
  const handleColorSelect = useCallback((color: string) => {
    onChange(color);
    setInputValue(color);
  }, [onChange]);
  
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    
    // Validate hex color
    if (/^#[0-9a-fA-F]{6}$/.test(newValue) || newValue === "") {
      onChange(newValue || undefined);
    }
  }, [onChange]);
  
  const handleClear = useCallback(() => {
    onChange(undefined);
    setInputValue("");
  }, [onChange]);
  
  const displayColor = value || "#ffffff";
  const displayLabel = value || "None";
  
  return (
    <div style={styles.container} ref={containerRef}>
      <div style={styles.trigger} onClick={() => setIsOpen(!isOpen)}>
        <div 
          style={{
            ...styles.swatch,
            backgroundColor: displayColor,
          }}
        />
        <span style={styles.label}>{displayLabel}</span>
        <span style={{ fontSize: "10px" }}>{isOpen ? "^" : "v"}</span>
      </div>
      
      {isOpen && (
        <div style={styles.dropdown}>
          <div style={styles.grid}>
            {PRESET_COLORS.map((color) => (
              <button
                key={color}
                style={{
                  ...styles.colorButton,
                  backgroundColor: color,
                  ...(color === value ? styles.colorButtonSelected : {}),
                }}
                onClick={() => handleColorSelect(color)}
                title={color}
              />
            ))}
          </div>
          <div style={styles.inputRow}>
            <input
              type="text"
              style={styles.input}
              value={inputValue}
              onChange={handleInputChange}
              placeholder="#000000"
            />
            <button style={styles.clearButton} onClick={handleClear}>
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}