//! FILENAME: z_archive/addins/_disabled/formatting/font/FontGroup.tsx
// PURPOSE: Font formatting group for the Home tab.
// CONTEXT: Contains Bold, Italic, Underline, text color, and background color controls.

import React, { useState, useCallback, useRef } from "react";
import type { RibbonContext } from "../../../../core/extensions/types";
import { RibbonButton } from "../../../../shell/Ribbon/components";
import { ColorPicker } from "../shared";
import { applyFormatting } from "../../../../core/lib/tauri-api";
import { getFormatButtonStyle, getColorButtonStyle } from "../../../../shell/Ribbon/styles";

interface FontGroupProps {
  context: RibbonContext;
}

/**
 * Font formatting controls.
 */
export function FontGroup({ context }: FontGroupProps): React.ReactElement {
  const { selection, isDisabled, onCellsUpdated } = context;
  const [showTextColorPicker, setShowTextColorPicker] = useState(false);
  const [showBgColorPicker, setShowBgColorPicker] = useState(false);
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
        console.error("[FontGroup] Failed to apply formatting:", error);
      } finally {
        setIsApplying(false);
      }
    },
    [isDisabled, isApplying, getSelectionRange, onCellsUpdated]
  );

  const handleBold = useCallback(() => {
    console.log("[FontGroup] Bold clicked");
    applyFormat({ bold: true });
  }, [applyFormat]);

  const handleItalic = useCallback(() => {
    console.log("[FontGroup] Italic clicked");
    applyFormat({ italic: true });
  }, [applyFormat]);

  const handleUnderline = useCallback(() => {
    console.log("[FontGroup] Underline clicked");
    applyFormat({ underline: true });
  }, [applyFormat]);

  const handleTextColor = useCallback(
    async (color: string) => {
      setShowTextColorPicker(false);
      if (color) {
        console.log("[FontGroup] Applying text color:", color);
        await applyFormat({ textColor: color });
      }
    },
    [applyFormat]
  );

  const handleBgColor = useCallback(
    async (color: string) => {
      setShowBgColorPicker(false);
      const bgColor = color || "#ffffff";
      console.log("[FontGroup] Applying background color:", bgColor);
      await applyFormat({ backgroundColor: bgColor });
    },
    [applyFormat]
  );

  const effectiveDisabled = isDisabled || isApplying;

  const getColorButtonStyle = (disabled: boolean): React.CSSProperties => ({
    ...colorButtonStyles,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    backgroundColor: disabled ? "#f5f5f5" : "#fff",
  });

  return (
    <>
      <div style={buttonRowStyles}>
        <RibbonButton
          onClick={handleBold}
          disabled={effectiveDisabled}
          title="Bold (Ctrl+B)"
          style={{ fontWeight: "bold" }}
        >
          B
        </RibbonButton>
        <RibbonButton
          onClick={handleItalic}
          disabled={effectiveDisabled}
          title="Italic (Ctrl+I)"
          style={{ fontStyle: "italic" }}
        >
          I
        </RibbonButton>
        <RibbonButton
          onClick={handleUnderline}
          disabled={effectiveDisabled}
          title="Underline (Ctrl+U)"
          style={{ textDecoration: "underline" }}
        >
          U
        </RibbonButton>
      </div>
      <div style={buttonRowStyles}>
        {/* Text Color */}
        <div
          style={colorPickerContainerStyles}
          className="color-picker-container"
        >
          <button
            style={getColorButtonStyle(effectiveDisabled)}
            onClick={(e) => {
              e.stopPropagation();
              if (!effectiveDisabled) {
                setShowTextColorPicker(!showTextColorPicker);
                setShowBgColorPicker(false);
              }
            }}
            disabled={effectiveDisabled}
            title="Text Color"
            type="button"
          >
            <span style={{ borderBottom: "3px solid #000000" }}>A</span>
            <span style={dropdownArrowStyles}>v</span>
          </button>
          {showTextColorPicker && (
            <ColorPicker
              onSelect={handleTextColor}
              onClose={() => setShowTextColorPicker(false)}
            />
          )}
        </div>
        {/* Background Color */}
        <div
          style={colorPickerContainerStyles}
          className="color-picker-container"
        >
          <button
            style={getColorButtonStyle(effectiveDisabled)}
            onClick={(e) => {
              e.stopPropagation();
              if (!effectiveDisabled) {
                setShowBgColorPicker(!showBgColorPicker);
                setShowTextColorPicker(false);
              }
            }}
            disabled={effectiveDisabled}
            title="Fill Color"
            type="button"
          >
            <span
              style={{
                display: "inline-block",
                width: 14,
                height: 14,
                backgroundColor: "#ffff00",
                border: "1px solid #999",
              }}
            />
            <span style={dropdownArrowStyles}>v</span>
          </button>
          {showBgColorPicker && (
            <ColorPicker
              onSelect={handleBgColor}
              onClose={() => setShowBgColorPicker(false)}
            />
          )}
        </div>
      </div>
    </>
  );
}