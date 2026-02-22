//! FILENAME: app/extensions/BuiltIn/PasteSpecial/PasteSpecialDialog.tsx
// PURPOSE: Paste Special dialog component with Excel-like configuration matrix.
// CONTEXT: Opens via Ctrl+Alt+V or Edit > Paste Special... menu.
// Provides radio buttons for paste attribute and operation, checkboxes for
// skip blanks and transpose, and a Paste Link button.

import React, { useState, useCallback } from "react";
import type { DialogProps } from "../../../src/api/uiTypes";
import { useGridState } from "../../../src/api";
import { getInternalClipboard } from "../../../src/api/lib";
import { executePasteSpecial, executePasteLink } from "./pasteSpecialExecute";
import type { PasteAttribute, PasteOperation } from "./types";
import { DEFAULT_PASTE_SPECIAL_OPTIONS } from "./types";
import * as S from "./PasteSpecialDialog.styles";

// ============================================================================
// Radio Option Definitions
// ============================================================================

const PASTE_ATTRIBUTES: { value: PasteAttribute; label: string }[] = [
  { value: "all", label: "All" },
  { value: "formulas", label: "Formulas" },
  { value: "values", label: "Values" },
  { value: "formats", label: "Formats" },
  { value: "comments", label: "Comments" },
  { value: "validation", label: "Validation" },
  { value: "columnWidths", label: "Column widths" },
];

const OPERATIONS: { value: PasteOperation; label: string }[] = [
  { value: "none", label: "None" },
  { value: "add", label: "Add" },
  { value: "subtract", label: "Subtract" },
  { value: "multiply", label: "Multiply" },
  { value: "divide", label: "Divide" },
];

// ============================================================================
// Main Dialog Component
// ============================================================================

export function PasteSpecialDialog(props: DialogProps): React.ReactElement | null {
  const { onClose } = props;

  const gridState = useGridState();
  const selection = gridState.selection;
  const config = gridState.config;

  // Dialog state
  const [pasteAttribute, setPasteAttribute] = useState<PasteAttribute>(
    DEFAULT_PASTE_SPECIAL_OPTIONS.pasteAttribute
  );
  const [operation, setOperation] = useState<PasteOperation>(
    DEFAULT_PASTE_SPECIAL_OPTIONS.operation
  );
  const [skipBlanks, setSkipBlanks] = useState(DEFAULT_PASTE_SPECIAL_OPTIONS.skipBlanks);
  const [transpose, setTranspose] = useState(DEFAULT_PASTE_SPECIAL_OPTIONS.transpose);
  const [isExecuting, setIsExecuting] = useState(false);

  // Check if clipboard has data
  const clipboard = getInternalClipboard();
  const hasClipboard = clipboard !== null && clipboard.cells.length > 0;

  // Handle OK
  const handleOK = useCallback(async () => {
    if (!hasClipboard || !selection || isExecuting) return;

    setIsExecuting(true);
    try {
      await executePasteSpecial(
        clipboard!,
        selection,
        { pasteAttribute, operation, skipBlanks, transpose },
        config.totalRows,
        config.totalCols
      );
      onClose();
    } catch (err) {
      console.error("[PasteSpecialDialog] Execute failed:", err);
    } finally {
      setIsExecuting(false);
    }
  }, [
    hasClipboard,
    clipboard,
    selection,
    pasteAttribute,
    operation,
    skipBlanks,
    transpose,
    config.totalRows,
    config.totalCols,
    onClose,
    isExecuting,
  ]);

  // Handle Paste Link
  const handlePasteLink = useCallback(async () => {
    if (!hasClipboard || !selection || isExecuting) return;

    setIsExecuting(true);
    try {
      await executePasteLink(
        clipboard!,
        selection,
        config.totalRows,
        config.totalCols
      );
      onClose();
    } catch (err) {
      console.error("[PasteSpecialDialog] Paste Link failed:", err);
    } finally {
      setIsExecuting(false);
    }
  }, [hasClipboard, clipboard, selection, config.totalRows, config.totalCols, onClose, isExecuting]);

  // Handle Cancel
  const handleCancel = useCallback(() => {
    onClose();
  }, [onClose]);

  // Keyboard handling
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();

      if (e.key === "Escape") {
        handleCancel();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleOK();
      }
    },
    [handleCancel, handleOK]
  );

  return (
    <S.Backdrop onClick={handleCancel}>
      <S.DialogContainer
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <S.Header>
          <S.Title>Paste Special</S.Title>
          <S.CloseButton onClick={handleCancel} title="Close (Esc)">
            X
          </S.CloseButton>
        </S.Header>

        {/* Body */}
        <S.Body>
          {/* Two-column layout: Paste attributes + Operations */}
          <S.ColumnsRow>
            {/* Left column: Paste attribute */}
            <S.Column>
              <S.GroupLabel>Paste</S.GroupLabel>
              {PASTE_ATTRIBUTES.map((attr) => (
                <S.RadioLabel key={attr.value}>
                  <input
                    type="radio"
                    name="pasteAttribute"
                    value={attr.value}
                    checked={pasteAttribute === attr.value}
                    onChange={() => setPasteAttribute(attr.value)}
                  />
                  {attr.label}
                </S.RadioLabel>
              ))}
            </S.Column>

            {/* Right column: Operation */}
            <S.Column>
              <S.GroupLabel>Operation</S.GroupLabel>
              {OPERATIONS.map((op) => (
                <S.RadioLabel key={op.value}>
                  <input
                    type="radio"
                    name="operation"
                    value={op.value}
                    checked={operation === op.value}
                    onChange={() => setOperation(op.value)}
                  />
                  {op.label}
                </S.RadioLabel>
              ))}
            </S.Column>
          </S.ColumnsRow>

          {/* Checkboxes */}
          <S.CheckboxRow>
            <S.CheckboxLabel>
              <input
                type="checkbox"
                checked={skipBlanks}
                onChange={(e) => setSkipBlanks(e.target.checked)}
              />
              Skip blanks
            </S.CheckboxLabel>
            <S.CheckboxLabel>
              <input
                type="checkbox"
                checked={transpose}
                onChange={(e) => setTranspose(e.target.checked)}
              />
              Transpose
            </S.CheckboxLabel>
          </S.CheckboxRow>

          {/* No clipboard warning */}
          {!hasClipboard && (
            <div style={{ color: "var(--text-secondary)", fontSize: 12, fontStyle: "italic" }}>
              No clipboard data available. Copy cells first (Ctrl+C).
            </div>
          )}
        </S.Body>

        {/* Footer */}
        <S.Footer>
          <S.FooterLeft>
            <S.Button
              onClick={handlePasteLink}
              disabled={!hasClipboard || !selection || isExecuting}
            >
              Paste Link
            </S.Button>
          </S.FooterLeft>
          <S.FooterRight>
            <S.Button onClick={handleCancel}>Cancel</S.Button>
            <S.Button
              $primary
              onClick={handleOK}
              disabled={!hasClipboard || !selection || isExecuting}
            >
              OK
            </S.Button>
          </S.FooterRight>
        </S.Footer>
      </S.DialogContainer>
    </S.Backdrop>
  );
}

export default PasteSpecialDialog;
