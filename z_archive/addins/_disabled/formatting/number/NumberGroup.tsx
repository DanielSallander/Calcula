//! FILENAME: z_archive/addins/_disabled/formatting/number/NumberGroup.tsx
// PURPOSE: Number formatting group for the Home tab.
// CONTEXT: Contains number format dropdown and quick access buttons for currency,
// percentage, and comma formatting.

import React, { useState, useCallback, useRef } from "react";
import type { RibbonContext } from "../../../../core/extensions/types";
import { RibbonButton } from "../../../../shell/Ribbon/components";
import { NumberFormatPicker } from "../shared";
import { applyFormatting } from "../../../../core/lib/tauri-api";
import { getNumberFormatButtonStyle } from "../../../../shell/Ribbon/styles";

interface NumberGroupProps {
  context: RibbonContext;
}

/**
 * Number formatting controls.
 */
export function NumberGroup({ context }: NumberGroupProps): React.ReactElement {
  const { selection, isDisabled, onCellsUpdated } = context;
  const [showNumberFormatPicker, setShowNumberFormatPicker] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const getSelectionRange = useCallback((): { rows: number[]; cols: number[] } => {
    const currentSelection = selectionRef.current;
    if (!currentSelection) {
      return { rows: [], cols: [] };
    }

    const minRow = Math.min(currentSelection.startRow, currentSelection.endRow);
    const maxRow = Math.max(currentSelection.startRow, currentSelection.endRow);
    const minCol = Math.min(currentSelection.startCol, currentSelection.endCol);
    const maxCol = Math.max(currentSelection.startCol, currentSelection.endCol);

    const rows: number[] = [];
    const cols: number[] = [];
    for (let r = minRow; r <= maxRow; r++) rows.push(r);
    for (let c = minCol; c <= maxCol; c++) cols.push(c);

    return { rows, cols };
  }, []);

  const applyFormat = useCallback(
    async (formatting: Record<string, unknown>) => {
      const currentSelection = selectionRef.current;
      if (!currentSelection || isDisabled || isApplying) return;

      const { rows, cols } = getSelectionRange();
      if (rows.length === 0 || cols.length === 0) return;

      setIsApplying(true);
      try {
        await applyFormatting(rows, cols, formatting);
        if (onCellsUpdated) await onCellsUpdated();
      } catch (error) {
        console.error("[NumberGroup] Failed to apply formatting:", error);
      } finally {
        setIsApplying(false);
      }
    },
    [isDisabled, isApplying, getSelectionRange, onCellsUpdated]
  );

  const handleNumberFormat = useCallback(
    async (formatId: string) => {
      console.log("[NumberGroup] Number format:", formatId);
      setShowNumberFormatPicker(false);
      await applyFormat({ numberFormat: formatId });
    },
    [applyFormat]
  );

  const effectiveDisabled = isDisabled || isApplying;

  const getButtonStyle = (disabled: boolean): React.CSSProperties => ({
    ...numberFormatButtonStyles,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    backgroundColor: disabled ? "#f5f5f5" : "#fff",
  });

  return (
    <>
      <div
        style={numberFormatContainerStyles}
        className="number-format-container"
      >
        <button
          style={getButtonStyle(effectiveDisabled)}
          onClick={(e) => {
            e.stopPropagation();
            if (!effectiveDisabled) {
              setShowNumberFormatPicker(!showNumberFormatPicker);
            }
          }}
          disabled={effectiveDisabled}
          title="Number Format"
          type="button"
        >
          General
          <span style={dropdownArrowStyles}>v</span>
        </button>
        {showNumberFormatPicker && (
          <NumberFormatPicker
            onSelect={handleNumberFormat}
            onClose={() => setShowNumberFormatPicker(false)}
          />
        )}
      </div>
      <div style={buttonRowStyles}>
        <RibbonButton
          onClick={() => handleNumberFormat("currency_usd")}
          disabled={effectiveDisabled}
          title="Currency"
        >
          $
        </RibbonButton>
        <RibbonButton
          onClick={() => handleNumberFormat("percentage")}
          disabled={effectiveDisabled}
          title="Percentage"
        >
          %
        </RibbonButton>
        <RibbonButton
          onClick={() => handleNumberFormat("number_sep")}
          disabled={effectiveDisabled}
          title="Comma Style"
        >
          ,
        </RibbonButton>
      </div>
    </>
  );
}