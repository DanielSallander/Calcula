//! FILENAME: app/extensions/BuiltIn/PasteSpecial/PasteSpecialDialog.tsx
// PURPOSE: Paste Special dialog component with Excel-like configuration matrix.
// CONTEXT: Opens via Ctrl+Alt+V or Edit > Paste Special... menu.
// Provides radio buttons for paste attribute and operation, checkboxes for
// skip blanks and transpose, and a Paste Link button.

import React, { useState, useCallback } from "react";
import type { DialogProps } from "@api/uiTypes";
import { useDialogWindow } from "@api/dialogWindow";
import { useGridState } from "@api";
import { getInternalClipboard } from "@api/lib";
import type { CellTarget } from "@api/cellTarget";
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
  { value: "allExceptBorders", label: "All except borders" },
  { value: "columnWidths", label: "Column widths" },
  { value: "formulasAndNumberFormats", label: "Formulas and number formats" },
  { value: "valuesAndNumberFormats", label: "Values and number formats" },
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

/** The OBJECT target the dialog was opened for, or null (Core's selection). */
function objectTargetOf(data: Record<string, unknown> | undefined): Extract<CellTarget, { kind: "object" }> | null {
  const t = data?.target as CellTarget | undefined;
  return t && t.kind === "object" ? t : null;
}

export function PasteSpecialDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;

  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 360, minHeight: 280 });

  const gridState = useGridState();
  // Opened for a floating grid's cells (P3: the PASTE_SPECIAL door resolved
  // an OBJECT target and handed it in): the paste lands in the object's
  // selection, within its extent, through its target. Otherwise Core's.
  const owned = objectTargetOf(data);
  const selection = owned ? owned.selection : gridState.selection;
  const totalRows = owned ? owned.bounds.rows : gridState.config.totalRows;
  const totalCols = owned ? owned.bounds.cols : gridState.config.totalCols;
  const target = owned?.ref;

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
        totalRows,
        totalCols,
        "Paste Special",
        target,
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
    totalRows,
    totalCols,
    target,
    onClose,
    isExecuting,
  ]);

  // Handle Paste Link
  const handlePasteLink = useCallback(async () => {
    if (!hasClipboard || !selection || isExecuting) return;

    setIsExecuting(true);
    try {
      await executePasteLink(clipboard!, selection, totalRows, totalCols, "Paste Link", target);
      onClose();
    } catch (err) {
      console.error("[PasteSpecialDialog] Paste Link failed:", err);
    } finally {
      setIsExecuting(false);
    }
  }, [hasClipboard, clipboard, selection, totalRows, totalCols, target, onClose, isExecuting]);

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
        ref={win.ref}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{ position: "relative", ...win.style }}
      >
        {/* Header — drag handle */}
        <S.Header onMouseDown={win.onHeaderMouseDown}>
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
        {win.resizeHandles}
      </S.DialogContainer>
    </S.Backdrop>
  );
}

export default PasteSpecialDialog;
