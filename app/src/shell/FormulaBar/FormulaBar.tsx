// FILENAME: shell/FormulaBar/FormulaBar.tsx
// PURPOSE: Formula bar with Name Box, Cancel/Enter buttons, and formula input
// CONTEXT: Positioned between Ribbon and Spreadsheet grid
// FEATURES: 
//   - Cancel (X) and Enter (checkmark) buttons appear during editing
//   - Insert Function (fx) button opens function dialog
//   - Formula input syncs with inline cell editor

import React, { useState, useCallback } from "react";
import { NameBox } from "./NameBox";
import { FormulaInput } from "./FormulaInput";
import { InsertFunctionDialog } from "./InsertFunctionDialog";
import { useGridContext } from "../../core/state/GridContext";
import { useEditing } from "../../core/hooks/useEditing";
import * as S from './FormulaBar.styles';

function CancelIcon(): React.ReactElement {
  return <S.CancelIconSpan>X</S.CancelIconSpan>;
}

function EnterIcon(): React.ReactElement {
  return <S.EnterIconSpan>[OK]</S.EnterIconSpan>;
}

function InsertFunctionIcon(): React.ReactElement {
  return <S.InsertFunctionIconSpan>fx</S.InsertFunctionIconSpan>;
}

export function FormulaBar(): React.ReactElement {
  const { state } = useGridContext();
  const { editing, commitEdit, cancelEdit, updateValue, startEditing } = useEditing();
  const [showFunctionDialog, setShowFunctionDialog] = useState(false);
  
  const isEditing = editing !== null;

  const handleCancelMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  const handleCancel = useCallback(async () => {
    await cancelEdit();
  }, [cancelEdit]);

  const handleEnterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  const handleEnter = useCallback(async () => {
    await commitEdit();
  }, [commitEdit]);

  const handleInsertFunction = useCallback(() => {
    if (!editing) {
      startEditing("=");
    }
    setShowFunctionDialog(true);
  }, [editing, startEditing]);

  const handleFunctionSelect = useCallback((functionName: string, template: string) => {
    if (editing) {
      const currentValue = editing.value;
      if (currentValue === "=" || currentValue === "") {
        updateValue(template);
      } else if (currentValue.endsWith("(") || currentValue.endsWith(",") || currentValue.endsWith("=")) {
        updateValue(currentValue + functionName + "(");
      } else {
        updateValue(currentValue + functionName + "(");
      }
    }
    setShowFunctionDialog(false);
  }, [editing, updateValue]);

  const handleDialogClose = useCallback(() => {
    setShowFunctionDialog(false);
  }, []);

  return (
    <>
      <S.FormulaBarContainer>
        <NameBox />

        <S.ButtonGroup>
          <S.IconButton
            variant="cancel"
            onMouseDown={handleCancelMouseDown}
            onClick={handleCancel}
            disabled={!isEditing}
            title="Cancel (Esc)"
          >
            <CancelIcon />
          </S.IconButton>

          <S.IconButton
            variant="enter"
            onMouseDown={handleEnterMouseDown}
            onClick={handleEnter}
            disabled={!isEditing}
            title="Enter"
          >
            <EnterIcon />
          </S.IconButton>

          <S.IconButton
            variant="function"
            onClick={handleInsertFunction}
            title="Insert Function"
          >
            <InsertFunctionIcon />
          </S.IconButton>
        </S.ButtonGroup>

        <FormulaInput />
      </S.FormulaBarContainer>

      {showFunctionDialog && (
        <InsertFunctionDialog
          onSelect={handleFunctionSelect}
          onClose={handleDialogClose}
        />
      )}
    </>
  );
}