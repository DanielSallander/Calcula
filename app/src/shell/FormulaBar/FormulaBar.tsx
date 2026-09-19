//! FILENAME: app/src/shell/FormulaBar/FormulaBar.tsx
// PURPOSE: Formula bar with Name Box, Cancel/Enter buttons, and formula input
// CONTEXT: Positioned between Ribbon and Spreadsheet grid
// FEATURES:
//   - Cancel (X) and Enter (checkmark) buttons appear during editing
//   - Insert Function (fx) button opens function dialog
//   - Formula input syncs with inline cell editor
//   - Expand/collapse (chevron, Ctrl+Shift+U) and a draggable bottom edge

import React, { useState, useCallback, useEffect, useRef } from "react";
import { NameBox } from "./NameBox";
import { FormulaInput } from "./FormulaInput";
import { InsertFunctionDialog } from "./InsertFunctionDialog";
import { useEditing } from "../../api/editing";
import { useGridContext } from "../../api";
import { CommandRegistry } from "../../api/commands";
import { FORMULA_BAR_TOGGLE_EXPANDED_COMMAND } from "../../api/keybindings";
import {
  FORMULA_BAR_COLLAPSED_HEIGHT,
  FORMULA_BAR_COLLAPSED_EDITOR_HEIGHT,
  FORMULA_BAR_EXPANDED_CHROME_HEIGHT,
  FORMULA_BAR_MIN_EXPANDED_HEIGHT,
  clampFormulaBarHeight,
} from "../../core/types";
import * as S from './FormulaBar.styles';

function CancelIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="3" y1="3" x2="11" y2="11" />
      <line x1="11" y1="3" x2="3" y2="11" />
    </svg>
  );
}

function EnterIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2,7.5 5.5,11 12,3" />
    </svg>
  );
}

function InsertFunctionIcon(): React.ReactElement {
  return <S.InsertFunctionIconSpan>fx</S.InsertFunctionIconSpan>;
}

/** Down while collapsed (what the click will do), up while expanded. */
function ExpandIcon({ expanded }: { expanded: boolean }): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {expanded ? <polyline points="3,9 7,5 11,9" /> : <polyline points="3,5 7,9 11,5" />}
    </svg>
  );
}

export function FormulaBar(): React.ReactElement {
  const { state } = useGridContext();
  const { editing, commitEdit, cancelEdit, updateValue, startEditing } = useEditing();
  const [showFunctionDialog, setShowFunctionDialog] = useState(false);

  /**
   * WHY THE LIVE SIZE IS LOCAL AND THE SEED IS IN GRID STATE
   * ========================================================
   * `formulaBarExpanded` / `formulaBarHeight` live in grid state so the bar
   * comes back the size the user left it. The value the bar RENDERS from is
   * local because the drag below updates it at mousemove rate, and every
   * consumer of GridContext — the whole canvas included — re-renders on a grid
   * dispatch; sixty reducer round trips a second to move an edge is not a
   * trade worth making.
   */
  const [expanded, setExpanded] = useState(state.formulaBarExpanded);
  const [editorHeight, setEditorHeight] = useState(() => clampFormulaBarHeight(state.formulaBarHeight));
  const [isResizing, setIsResizing] = useState(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(0);

  // Adopt the grid-state values whenever THEY change (a workbook load, a View
  // command), never on every render — re-reading them unconditionally would
  // undo the drag in progress. Same render-time derived-state pattern the
  // formula input uses for `editing`.
  //
  // Object.is, not !==, and the reason is NaN: a junk height compares unequal
  // to ITSELF, so `!==` re-seeds on every render and React tears the app down
  // with "Too many re-renders". The clamp below repairs the value it renders,
  // which is precisely why the raw one can sit in `seed` forever.
  const [seed, setSeed] = useState({ expanded: state.formulaBarExpanded, height: state.formulaBarHeight });
  if (!Object.is(seed.expanded, state.formulaBarExpanded) || !Object.is(seed.height, state.formulaBarHeight)) {
    setSeed({ expanded: state.formulaBarExpanded, height: state.formulaBarHeight });
    setExpanded(state.formulaBarExpanded);
    setEditorHeight(clampFormulaBarHeight(state.formulaBarHeight));
  }

  const isEditing = editing !== null;

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  /**
   * Ctrl+Shift+U arrives as a COMMAND: the keybinding registry is the one
   * dispatcher for named shortcuts, and it holds a command id, not a callback.
   * Registering here rather than at bootstrap ties the handler's lifetime to
   * the bar's own — hiding the formula bar (View menu) unmounts this component,
   * and a shortcut that toggles a bar nobody can see would be a keystroke with
   * no visible effect at all.
   */
  useEffect(() => {
    CommandRegistry.register(FORMULA_BAR_TOGGLE_EXPANDED_COMMAND, toggleExpanded);
    return () => CommandRegistry.unregister(FORMULA_BAR_TOGGLE_EXPANDED_COMMAND);
  }, [toggleExpanded]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    // Without this the mousedown starts a text selection that then drags along
    // with the pointer, and it steals focus from an entry in progress.
    e.preventDefault();
    dragStartYRef.current = e.clientY;
    // Dragging DOWN from a collapsed bar is how it opens, so the drag measures
    // from what is on screen now — one line collapsed, the user's height not.
    dragStartHeightRef.current = expanded ? editorHeight : FORMULA_BAR_COLLAPSED_EDITOR_HEIGHT;
    setIsResizing(true);
  }, [expanded, editorHeight]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const proposed = dragStartHeightRef.current + (e.clientY - dragStartYRef.current);
      // Dragged back up past two lines, the bar COLLAPSES rather than sticking
      // at the minimum: one edge, both jobs, and no dead zone where the pointer
      // moves and nothing happens.
      if (proposed < FORMULA_BAR_MIN_EXPANDED_HEIGHT) {
        setExpanded(false);
        return;
      }
      setExpanded(true);
      setEditorHeight(clampFormulaBarHeight(proposed));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  // Prevent text selection during resize (same treatment as the side panel's
  // edge): without it the pointer paints a selection across the ribbon.
  useEffect(() => {
    if (!isResizing) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing]);

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

  // The chevron must not take focus off an entry in progress — clicking it
  // mid-formula would otherwise blur the editor and commit the cell.
  const handleExpandMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  const handleFunctionSelect = useCallback((functionName: string, template: string) => {
    if (editing) {
      const currentValue = editing.value;
      if (currentValue === "=" || currentValue === "") {
        updateValue(template);
      } else if (currentValue.endsWith("(") || currentValue.endsWith(",") || currentValue.endsWith(";") || currentValue.endsWith("=")) {
        updateValue(currentValue + functionName + "(");
      } else {
        updateValue(currentValue + functionName + "(");
      }
    }
    setShowFunctionDialog(false);
  }, [editing, updateValue]);

  /**
   * A function-argument builder produced a COMPLETE formula, so unlike a
   * template there is nothing left for the user to fill in and the cell is
   * committed for them — Excel's Function Arguments OK button.
   *
   * WHY THIS COMMITS ON A LATER RENDER INSTEAD OF RIGHT HERE.
   * `commitEdit` commits `editing.value` out of its own closure — it is a
   * useCallback with `editing` in its deps — and `editing` is React state, so
   * `updateValue(formula); commitEdit();` in one handler writes the formula
   * into the editor and then commits a value from an EARLIER render: "=", the
   * seed the fx button started the session with, or nothing at all when the
   * handler's own closure is older still. Measured, not assumed: sabotaging
   * this into the same-tick form commits "<not editing>". So the formula is
   * parked, and the effect below commits once the dispatch has landed.
   *
   * It must also go through `commitEdit` rather than straight to `updateCell`,
   * which is what the old standalone builder dialog did: only the commit path
   * runs the commit guards, the R1C1 rewrite and the grouped-sheet replication,
   * and a cell written around them is a cell that skipped its own validation.
   */
  const pendingCommitRef = useRef<string | null>(null);

  const handleFunctionBuilt = useCallback((formula: string) => {
    setShowFunctionDialog(false);
    pendingCommitRef.current = formula;
    updateValue(formula);
  }, [updateValue]);

  useEffect(() => {
    if (pendingCommitRef.current === null) return;
    // The edit session went away underneath us (Esc, a click elsewhere):
    // abandon the commit rather than resurrecting it into whatever is
    // selected now.
    if (!editing) {
      pendingCommitRef.current = null;
      return;
    }
    if (editing.value !== pendingCommitRef.current) return;
    pendingCommitRef.current = null;
    void commitEdit();
  }, [editing, commitEdit]);

  const handleDialogClose = useCallback(() => {
    setShowFunctionDialog(false);
  }, []);

  // Where a built formula will land. `editing` is authoritative once the fx
  // button's startEditing has resolved; the selection anchor covers the window
  // before that, so the builder is never handed (0,0) by accident.
  const builderAnchor = editing
    ? { row: editing.row, col: editing.col }
    : { row: state.selection?.startRow ?? 0, col: state.selection?.startCol ?? 0 };

  const barHeight = expanded
    ? editorHeight + FORMULA_BAR_EXPANDED_CHROME_HEIGHT
    : FORMULA_BAR_COLLAPSED_HEIGHT;
  const expandLabel = expanded
    ? "Collapse Formula Bar (Ctrl+Shift+U)"
    : "Expand Formula Bar (Ctrl+Shift+U)";

  return (
    <>
      <S.FormulaBarContainer
        $expanded={expanded}
        $height={barHeight}
        data-formula-bar-expanded={expanded ? "true" : "false"}
      >
        <NameBox />

        <S.ButtonGroup $expanded={expanded}>
          <S.IconButton
            $variant="cancel"
            onMouseDown={handleCancelMouseDown}
            onClick={handleCancel}
            disabled={!isEditing}
            title="Cancel (Esc)"
          >
            <CancelIcon />
          </S.IconButton>

          <S.IconButton
            $variant="enter"
            onMouseDown={handleEnterMouseDown}
            onClick={handleEnter}
            disabled={!isEditing}
            title="Enter"
          >
            <EnterIcon />
          </S.IconButton>

          <S.IconButton
            $variant="function"
            onClick={handleInsertFunction}
            title="Insert Function"
          >
            <InsertFunctionIcon />
          </S.IconButton>
        </S.ButtonGroup>

        <FormulaInput expanded={expanded} editorHeight={editorHeight} />

        <S.IconButton
          $variant="expand"
          onMouseDown={handleExpandMouseDown}
          onClick={toggleExpanded}
          title={expandLabel}
          aria-label={expandLabel}
          aria-expanded={expanded}
          data-formula-bar-expand="true"
        >
          <ExpandIcon expanded={expanded} />
        </S.IconButton>

        <S.ResizeGrip
          onMouseDown={handleResizeStart}
          data-formula-bar-resize="true"
          aria-hidden="true"
        />
      </S.FormulaBarContainer>

      {showFunctionDialog && (
        <InsertFunctionDialog
          onSelect={handleFunctionSelect}
          onBuilt={handleFunctionBuilt}
          anchor={builderAnchor}
          onClose={handleDialogClose}
        />
      )}
    </>
  );
}
