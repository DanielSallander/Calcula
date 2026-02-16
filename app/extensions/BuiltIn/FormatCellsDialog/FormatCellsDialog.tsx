//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/FormatCellsDialog.tsx
// PURPOSE: Main Format Cells dialog component with tab navigation.
// CONTEXT: Opens via Ctrl+1 or Format > Format Cells menu.
// Loads the active cell's style, allows editing across tabs, and applies on OK.

import React, { useEffect, useCallback, useRef } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import {
  useGridState,
  cellEvents,
} from "../../../src/api";
import {
  getCell,
  getStyle,
  applyFormatting,
} from "../../../src/api/lib";
import { setCellProtection, getCellProtection } from "../../../src/api/backend";
import { useFormatCellsStore } from "./hooks/useFormatCellsState";
import { NumberTab } from "./tabs/NumberTab";
import { AlignmentTab } from "./tabs/AlignmentTab";
import { FontTab } from "./tabs/FontTab";
import { BorderTab } from "./tabs/BorderTab";
import { FillTab } from "./tabs/FillTab";
import { ProtectionTab } from "./tabs/ProtectionTab";
import * as S from "./FormatCellsDialog.styles";

// ============================================================================
// Tab Definitions
// ============================================================================

const TABS = [
  { id: "number", label: "Number", component: NumberTab },
  { id: "alignment", label: "Alignment", component: AlignmentTab },
  { id: "font", label: "Font", component: FontTab },
  { id: "border", label: "Border", component: BorderTab },
  { id: "fill", label: "Fill", component: FillTab },
  { id: "protection", label: "Protection", component: ProtectionTab },
] as const;

// ============================================================================
// Main Dialog Component
// ============================================================================

export function FormatCellsDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);

  const gridState = useGridState();
  const selection = gridState.selection;

  const store = useFormatCellsStore();
  const { activeTab, setActiveTab, loadFromStyle, reset } = store;

  // Load the active cell's current style when dialog opens
  useEffect(() => {
    async function loadCurrentStyle() {
      try {
        const row = selection.startRow;
        const col = selection.startCol;

        // Load cell style
        const cell = await getCell(row, col);
        if (cell) {
          const style = await getStyle(cell.styleIndex);
          loadFromStyle({
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            bold: style.bold,
            italic: style.italic,
            underline: style.underline,
            strikethrough: style.strikethrough,
            textColor: style.textColor,
            textAlign: style.textAlign,
            verticalAlign: style.verticalAlign,
            wrapText: style.wrapText,
            textRotation: style.textRotation,
            numberFormat: style.numberFormat.toLowerCase().includes("general")
              ? "general"
              : style.numberFormat,
            backgroundColor: style.backgroundColor,
            borderTop: style.borderTop ? { style: style.borderTop.style, color: style.borderTop.color } : undefined,
            borderRight: style.borderRight ? { style: style.borderRight.style, color: style.borderRight.color } : undefined,
            borderBottom: style.borderBottom ? { style: style.borderBottom.style, color: style.borderBottom.color } : undefined,
            borderLeft: style.borderLeft ? { style: style.borderLeft.style, color: style.borderLeft.color } : undefined,
          });
        }

        // Load cell protection
        const protection = await getCellProtection(row, col);
        loadFromStyle({
          locked: protection.locked,
          formulaHidden: protection.formulaHidden,
        });
      } catch (err) {
        console.error("[FormatCellsDialog] Failed to load style:", err);
      }
    }

    loadCurrentStyle();

    // If data contains an initial tab, switch to it
    if (data?.tab && typeof data.tab === "string") {
      setActiveTab(data.tab);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- only on mount

  // Handle OK - apply all formatting
  const handleOK = useCallback(async () => {
    try {
      // Build row/col arrays from selection
      const startRow = Math.min(selection.startRow, selection.endRow);
      const endRow = Math.max(selection.startRow, selection.endRow);
      const startCol = Math.min(selection.startCol, selection.endCol);
      const endCol = Math.max(selection.startCol, selection.endCol);

      const rows: number[] = [];
      const cols: number[] = [];
      for (let r = startRow; r <= endRow; r++) rows.push(r);
      for (let c = startCol; c <= endCol; c++) cols.push(c);

      // Apply formatting via Tauri
      const result = await applyFormatting(rows, cols, {
        bold: store.bold,
        italic: store.italic,
        underline: store.underline,
        strikethrough: store.strikethrough,
        fontSize: store.fontSize,
        fontFamily: store.fontFamily,
        textColor: store.textColor,
        backgroundColor: store.backgroundColor,
        textAlign: store.textAlign as "left" | "center" | "right" | "general",
        verticalAlign: store.verticalAlign as "top" | "middle" | "bottom",
        numberFormat: store.numberFormat,
        wrapText: store.wrapText,
        textRotation: store.textRotation as "none" | "rotate90" | "rotate270",
        borderTop: { style: store.borderTop.style, color: store.borderTop.color },
        borderRight: { style: store.borderRight.style, color: store.borderRight.color },
        borderBottom: { style: store.borderBottom.style, color: store.borderBottom.color },
        borderLeft: { style: store.borderLeft.style, color: store.borderLeft.color },
      });

      // Apply protection
      await setCellProtection({
        startRow,
        startCol,
        endRow,
        endCol,
        locked: store.locked,
        formulaHidden: store.formulaHidden,
      });

      // Emit cell change events for each updated cell
      for (const cell of result.cells) {
        cellEvents.emit({
          row: cell.row,
          col: cell.col,
          oldValue: undefined,
          newValue: cell.display,
          formula: cell.formula,
        });
      }

      // Trigger style cache and grid data refresh so the canvas picks up new styles
      window.dispatchEvent(new CustomEvent("styles:refresh"));
      window.dispatchEvent(new CustomEvent("grid:refresh"));

      reset();
      onClose();
    } catch (err) {
      console.error("[FormatCellsDialog] Failed to apply formatting:", err);
    }
  }, [store, selection, onClose, reset]);

  // Handle Cancel
  const handleCancel = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  // Keyboard handling
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();

      if (e.key === "Escape") {
        handleCancel();
      } else if (e.key === "Enter" && !e.shiftKey) {
        // Enter confirms unless focus is in a specific input
        const target = e.target as HTMLElement;
        if (target.tagName !== "SELECT") {
          e.preventDefault();
          handleOK();
        }
      }
    },
    [handleCancel, handleOK]
  );

  // Find active tab component
  const activeTabDef = TABS.find((t) => t.id === activeTab) || TABS[0];
  const TabComponent = activeTabDef.component;

  return (
    <S.Backdrop onClick={handleCancel}>
      <S.DialogContainer
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <S.Header>
          <S.Title>Format Cells</S.Title>
          <S.CloseButton onClick={handleCancel} title="Close (Esc)">
            X
          </S.CloseButton>
        </S.Header>

        {/* Tab bar */}
        <S.TabBar>
          {TABS.map((tab) => (
            <S.Tab
              key={tab.id}
              $active={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </S.Tab>
          ))}
        </S.TabBar>

        {/* Tab content */}
        <S.TabContent>
          <TabComponent />
        </S.TabContent>

        {/* Footer */}
        <S.Footer>
          <S.Button onClick={handleCancel}>Cancel</S.Button>
          <S.Button $primary onClick={handleOK}>
            OK
          </S.Button>
        </S.Footer>
      </S.DialogContainer>
    </S.Backdrop>
  );
}

export default FormatCellsDialog;
