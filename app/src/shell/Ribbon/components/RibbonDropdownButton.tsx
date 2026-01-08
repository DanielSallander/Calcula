// FILENAME: app/src/components/Ribbon/components/RibbonDropdownButton.tsx
// PURPOSE: Button with dropdown functionality for ribbon toolbar.
// CONTEXT: Combines a button with a dropdown panel that can be toggled.

import React, { useState, useCallback, useRef, useEffect } from "react";
import { formatButtonStyles, dropdownArrowStyles } from "../styles/styles";

export interface RibbonDropdownButtonProps {
  /** Button content (icon or text) */
  children: React.ReactNode;
  /** Dropdown content */
  dropdown: React.ReactNode;
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Tooltip text */
  title?: string;
  /** Additional button styles */
  style?: React.CSSProperties;
  /** Additional dropdown container styles */
  dropdownStyle?: React.CSSProperties;
  /** CSS class name for the container */
  className?: string;
  /** Callback when dropdown opens/closes */
  onToggle?: (isOpen: boolean) => void;
}

const containerStyles: React.CSSProperties = {
  position: "relative",
};

const hoverStyles: React.CSSProperties = {
  backgroundColor: "#e5e5e5",
  borderColor: "#aaa",
};

const disabledStyles: React.CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
  backgroundColor: "#f5f5f5",
};

/**
 * Ribbon button with integrated dropdown.
 */
export function RibbonDropdownButton({
  children,
  dropdown,
  disabled = false,
  title,
  style,
  dropdownStyle,
  className,
  onToggle,
}: RibbonDropdownButtonProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!disabled) {
        const newState = !isOpen;
        setIsOpen(newState);
        onToggle?.(newState);
      }
    },
    [disabled, isOpen, onToggle]
  );

  const handleClose = useCallback(() => {
    setIsOpen(false);
    onToggle?.(false);
  }, [onToggle]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        handleClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, handleClose]);

  const buttonStyle: React.CSSProperties = {
    ...formatButtonStyles,
    ...style,
    ...(isHovered && !disabled ? hoverStyles : {}),
    ...(disabled ? disabledStyles : {}),
  };

  return (
    <div ref={containerRef} style={containerStyles} className={className}>
      <button
        type="button"
        style={buttonStyle}
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        disabled={disabled}
        title={title}
      >
        {children}
        <span style={dropdownArrowStyles}>v</span>
      </button>
      {isOpen && (
        <div style={dropdownStyle} onClick={(e) => e.stopPropagation()}>
          {React.isValidElement(dropdown)
            ? React.cloneElement(dropdown as React.ReactElement<{ onClose?: () => void }>, {
                onClose: handleClose,
              })
            : dropdown}
        </div>
      )}
    </div>
  );
}