//! FILENAME: app/extensions/JsonView/components/JsonToggleButton.tsx
// PURPOSE: Small toggle button (</>)  for switching between GUI and JSON mode.
// CONTEXT: Phase C — placed in config panel headers/toolbars.

import React from "react";

const baseStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid transparent",
  borderRadius: "3px",
  cursor: "pointer",
  fontSize: "12px",
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  padding: "2px 6px",
  lineHeight: 1,
  transition: "all 0.15s",
};

const inactiveStyle: React.CSSProperties = {
  ...baseStyle,
  color: "#888",
};

const activeStyle: React.CSSProperties = {
  ...baseStyle,
  color: "#569cd6",
  borderColor: "#569cd6",
  backgroundColor: "rgba(86, 156, 214, 0.1)",
};

interface JsonToggleButtonProps {
  isActive: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

export function JsonToggleButton({
  isActive,
  onClick,
  disabled = false,
  title = "Toggle JSON view",
}: JsonToggleButtonProps): React.ReactElement {
  return (
    <button
      style={{
        ...(isActive ? activeStyle : inactiveStyle),
        ...(disabled ? { opacity: 0.4, cursor: "default" } : {}),
      }}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {"</>"}
    </button>
  );
}
