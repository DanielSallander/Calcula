// FILENAME: app/src/components/Ribbon/pickers/NumberFormatPicker.tsx
// PURPOSE: Number format picker dropdown component for selecting cell number formats.
// CONTEXT: Displays a list of predefined number format options (General, Number, Currency,
// Percentage, etc.) that users can apply to selected cells in the spreadsheet.

import React, { useCallback } from "react";
import { NUMBER_FORMAT_PRESETS } from "../../../../core/types";
import { getButtonStyle } from "../../../../shell/Ribbon/styles/styles";

export interface NumberFormatPickerProps {
  onSelect: (formatId: string) => void;
  onClose: () => void;
}

/**
 * Number format picker dropdown component.
 * Displays a list of format presets with labels and example values.
 */
export function NumberFormatPicker({
  onSelect,
  onClose,
}: NumberFormatPickerProps): React.ReactElement {
  const handleFormatClick = useCallback(
    (formatId: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      console.log("[NumberFormatPicker] Format clicked:", formatId);
      onSelect(formatId);
      onClose();
    },
    [onSelect, onClose]
  );

  return (
    <div
      style={numberFormatDropdownStyles}
      className="number-format-dropdown"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
    >
      {NUMBER_FORMAT_PRESETS.map((preset) => (
        <button
          key={preset.id}
          style={numberFormatOptionStyles}
          onClick={(e) => handleFormatClick(preset.id, e)}
          onMouseDown={(e) => e.preventDefault()}
          type="button"
        >
          <span style={formatLabelStyles}>{preset.label}</span>
          <span style={formatExampleStyles}>{preset.example}</span>
        </button>
      ))}
    </div>
  );
}