// FILENAME: app/src/components/Ribbon/pickers/ColorPicker.tsx
// PURPOSE: Color picker dropdown component for selecting text and background colors.
// CONTEXT: Renders a grid of predefined colors that users can click to apply to selected
// cells. Used by both the text color and fill color buttons in the Ribbon toolbar.

import React, { useCallback } from "react";
import { COLOR_PALETTE } from "../../../../shell/Ribbon/styles/constants";
import { getButtonStyle } from "../../../../shell/Ribbon/styles/styles";

export interface ColorPickerProps {
  onSelect: (color: string) => void;
  onClose: () => void;
}

/**
 * Color picker dropdown component.
 * Displays a grid of colors for selection and a "No Fill" option.
 */
export function ColorPicker({
  onSelect,
  onClose,
}: ColorPickerProps): React.ReactElement {
  const handleColorClick = useCallback(
    (color: string) => {
      console.log("[ColorPicker] Color clicked:", color);
      onSelect(color);
      onClose();
    },
    [onSelect, onClose]
  );

  return (
    <div
      style={colorPickerDropdownStyles}
      className="color-picker-dropdown"
      onClick={(e) => e.stopPropagation()}
    >
      <div style={colorGridStyles}>
        {COLOR_PALETTE.map((color) => (
          <button
            key={color}
            style={{
              ...colorSwatchStyles,
              backgroundColor: color,
              border:
                color === "#ffffff"
                  ? "1px solid #ccc"
                  : "1px solid transparent",
            }}
            onClick={() => handleColorClick(color)}
            title={color}
            type="button"
          />
        ))}
      </div>
      <button
        style={noColorButtonStyles}
        onClick={() => handleColorClick("")}
        type="button"
      >
        No Fill
      </button>
    </div>
  );
}