//! FILENAME: app/extensions/Controls/PropertiesPane/SliderInput.tsx
// PURPOSE: Combined slider + number input component for bounded numeric properties.
// CONTEXT: Used for opacity, rotation, font size, etc. in the Properties Pane.

import React, { useState, useCallback, useEffect } from "react";

// ============================================================================
// Styles
// ============================================================================

const containerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const rangeStyle: React.CSSProperties = {
  flex: 1,
  height: 4,
  appearance: "none",
  WebkitAppearance: "none",
  background: "linear-gradient(to right, #0078d4 var(--fill-pct, 0%), #ddd var(--fill-pct, 0%))",
  borderRadius: 2,
  outline: "none",
  cursor: "pointer",
  accentColor: "#0078d4",
};

const numberInputStyle: React.CSSProperties = {
  width: 52,
  padding: "3px 6px",
  border: "1px solid #d0d0d0",
  borderRadius: 3,
  fontSize: 12,
  fontFamily: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
  outline: "none",
  textAlign: "right",
  backgroundColor: "#ffffff",
  transition: "border-color 0.15s",
  boxSizing: "border-box",
};

const numberInputFocusStyle: React.CSSProperties = {
  borderColor: "#0078d4",
  boxShadow: "0 0 0 1px #0078d4",
};

// ============================================================================
// Props
// ============================================================================

interface SliderInputProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}

// ============================================================================
// Component
// ============================================================================

export const SliderInput: React.FC<SliderInputProps> = ({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
}) => {
  const [localNum, setLocalNum] = useState(String(value));
  const [focused, setFocused] = useState(false);

  // Sync when external value changes
  useEffect(() => {
    setLocalNum(String(value));
  }, [value]);

  const clamp = useCallback(
    (v: number) => Math.min(max, Math.max(min, v)),
    [min, max],
  );

  const fillPct = ((clamp(value) - min) / (max - min)) * 100;

  const handleRangeInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v)) {
        onChange(v);
        setLocalNum(String(v));
      }
    },
    [onChange],
  );

  const handleRangeCommit = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v)) {
        onCommit(clamp(v));
      }
    },
    [onCommit, clamp],
  );

  const handleNumberChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setLocalNum(e.target.value);
    },
    [],
  );

  const commitNumber = useCallback(() => {
    const v = parseFloat(localNum);
    if (!isNaN(v)) {
      const clamped = clamp(v);
      setLocalNum(String(clamped));
      onCommit(clamped);
    } else {
      setLocalNum(String(value));
    }
  }, [localNum, value, clamp, onCommit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        commitNumber();
      }
    },
    [commitNumber],
  );

  return (
    <div style={containerStyle}>
      <input
        type="range"
        style={{
          ...rangeStyle,
          "--fill-pct": `${fillPct}%`,
        } as React.CSSProperties}
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        onInput={handleRangeInput}
        onChange={handleRangeCommit}
      />
      <input
        type="text"
        style={{
          ...numberInputStyle,
          ...(focused ? numberInputFocusStyle : {}),
        }}
        value={localNum}
        onChange={handleNumberChange}
        onBlur={() => { setFocused(false); commitNumber(); }}
        onFocus={() => setFocused(true)}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
};
