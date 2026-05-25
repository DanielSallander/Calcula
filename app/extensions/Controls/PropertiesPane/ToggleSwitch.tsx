//! FILENAME: app/extensions/Controls/PropertiesPane/ToggleSwitch.tsx
// PURPOSE: CSS-only toggle switch component for boolean properties.
// CONTEXT: Replaces native checkboxes in the Properties Pane.

import React, { useState } from "react";

// ============================================================================
// Styles
// ============================================================================

const containerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  cursor: "pointer",
  userSelect: "none",
};

const trackBaseStyle: React.CSSProperties = {
  position: "relative",
  width: 32,
  height: 18,
  borderRadius: 9,
  transition: "background-color 0.2s ease",
  flexShrink: 0,
};

const knobBaseStyle: React.CSSProperties = {
  position: "absolute",
  top: 2,
  width: 14,
  height: 14,
  borderRadius: "50%",
  backgroundColor: "#ffffff",
  boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
  transition: "transform 0.2s ease",
};

const labelTextStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#555",
};

// ============================================================================
// Props
// ============================================================================

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}

// ============================================================================
// Component
// ============================================================================

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  checked,
  onChange,
  label,
}) => {
  const [hovered, setHovered] = useState(false);

  const trackStyle: React.CSSProperties = {
    ...trackBaseStyle,
    backgroundColor: checked ? "#0078d4" : (hovered ? "#b0b0b0" : "#c0c0c0"),
  };

  const knobStyle: React.CSSProperties = {
    ...knobBaseStyle,
    transform: checked ? "translateX(14px)" : "translateX(2px)",
  };

  return (
    <div
      style={containerStyle}
      onClick={() => onChange(!checked)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={trackStyle}>
        <div style={knobStyle} />
      </div>
      {label !== undefined && <span style={labelTextStyle}>{label}</span>}
    </div>
  );
};
