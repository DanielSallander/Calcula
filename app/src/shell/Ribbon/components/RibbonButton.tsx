//! FILENAME: app/src/shell/Ribbon/components/RibbonButton.tsx
// PURPOSE: Reusable button component for ribbon groups.
// CONTEXT: Used by add-ins to create consistent ribbon buttons.

import React from "react";

export interface RibbonButtonProps {
  /** Button label */
  label: string;
  /** Icon to display (React element) */
  icon?: React.ReactNode;
  /** Click handler */
  onClick?: () => void;
  /** Whether button is disabled */
  disabled?: boolean;
  /** Whether button is in "active" state */
  active?: boolean;
  /** Tooltip text */
  title?: string;
  /** Button size */
  size?: "small" | "medium" | "large";
}

export function RibbonButton({
  label,
  icon,
  onClick,
  disabled = false,
  active = false,
  title,
  size = "medium",
}: RibbonButtonProps): React.ReactElement {
  const sizeStyles = {
    small: { padding: "2px 6px", fontSize: "11px" },
    medium: { padding: "4px 8px", fontSize: "12px" },
    large: { padding: "6px 12px", fontSize: "13px" },
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "2px",
        border: "1px solid transparent",
        borderRadius: "3px",
        backgroundColor: active ? "#e0e0e0" : "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        ...sizeStyles[size],
      }}
    >
      {icon && <span style={{ fontSize: "16px" }}>{icon}</span>}
      <span>{label}</span>
    </button>
  );
}
