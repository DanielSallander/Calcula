//! FILENAME: app/src/shell/FormulaBar/FormulaInput.tsx
// PURPOSE: Formula input field that syncs with cell editing state
// CONTEXT: Part of FormulaBar, displays and edits the current cell formula/value
// FIX: Now fetches content from master cell for merged regions
// FIX: Added F4 key handler for toggling absolute/relative cell references
// FIX: Parses formula references on selection change for passive highlighting
// REFACTOR: Imports from api layer instead of core internals
// FEATURE: Expanded (multi-line) mode — one <textarea> instead of the <input>

import React, { useCallback, useRef, useEffect } from "react";
import { useGridContext, getCell, getMergeInfo, isSheetProtected, getCellProtection, checkRangeGuards, getSpillRanges } from "../../api";
import { useEditing, setGlobalIsEditing, getGlobalEditingValue, setGlobalCursorPosition, getGlobalCursorPosition, setChartSeriesRefMode } from "../../api/editing";
import { toggleReferenceAtCursor } from "../../core/lib/formulaRefToggle";
import { parseFormulaReferences } from "../../core/lib/formulaRefParser";
import { formulaA1ToR1C1 } from "../../core/lib/r1c1";
import { setFormulaReferences, clearFormulaReferences } from "../../core/state/gridActions";
import { isFormulaAutocompleteVisible, AutocompleteEvents } from "../../api/formulaAutocomplete";
import { AppEvents } from "../../api/events";
import { FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT } from "../../core/types";
import * as S from './FormulaInput.styles';

/**
 * The bar's editor is an <input> collapsed and a <textarea> expanded, so every
 * handler below is written against what the two SHARE — value, selectionStart,
 * setSelectionRange, blur, getBoundingClientRect. Nothing here may reach for an
 * input-only or textarea-only member.
 */
type FormulaEditorElement = HTMLInputElement | HTMLTextAreaElement;

interface FormulaInputProps {
  /** Multi-line mode: the bar has been expanded (chevron or Ctrl+Shift+U). */
  expanded?: boolean;
  /** Editor height in px when expanded; ignored collapsed. */
  editorHeight?: number;
}

// Both props default to the collapsed one-line editor — the shape this
// component had before the bar could expand — so anything that renders it
// without a size (a test, a future host) gets the ordinary formula bar.
export function FormulaInput({
  expanded = false,
  editorHeight = FORMULA_BAR_DEFAULT_EXPANDED_HEIGHT,
}: FormulaInputProps = {}): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const { editing, updateValue, commitEdit, cancelEdit, startEdit } = useEditing();
  const inputRef = useRef<FormulaEditorElement | null>(null);
  const [displayValue, setDisplayValue] = React.useState("");
  const [isFocused, setIsFocused] = React.useState(false);
  const [prevEditing, setPrevEditing] = React.useState(editing);

  /** Whether a chart series is currently selected (formula bar shows SERIES formula). */
  const [chartSeriesFormula, setChartSeriesFormula] = React.useState<string | null>(null);
  /** Whether the selected cell is a non-origin spill cell (show formula in grey). */
  const [isSpillRef, setIsSpillRef] = React.useState(false);

  // Sync displayValue with editing state (render-time derived state pattern)
  if (editing !== prevEditing) {
    setPrevEditing(editing);
    if (editing) {
      setDisplayValue(editing.value);
    }
  }

  /**
   * WHAT THE SELECTION FETCH WRITES, AND WHY IT IS CANCELLED
   * =========================================================
   * This effect answers "what does the newly selected cell contain" and it
   * writes THREE pieces of shared state: the formula bar's text, the spill-ref
   * flag, and — through `dispatch` — `state.formulaReferences`, which the GRID
   * CANVAS paints as the faint dashed precedent boxes (`isPassive` in
   * gridRenderer/rendering/references.ts). So a cell click repaints the grid,
   * not just this input.
   *
   * Getting the answer takes up to FIVE backend round trips: `getMergeInfo`
   * (twice for a range), `getSpillRanges`, `getCell`, and — only for a formula
   * cell — `isSheetProtected` + `getCellProtection`. That is 5 IPC hops between
   * the click and the paint.
   *
   * It used to fire `fetchCellContent()` with NO cancellation and NO cleanup, so
   * two selections in quick succession left two chains racing and **the SLOWER
   * one won**. Selecting a formula cell and then a plain one could therefore end
   * with the formula bar showing the PREVIOUS cell's formula and the canvas
   * still painting the PREVIOUS cell's precedents — a wrong answer on screen
   * about which cell you are standing on, with no error and nothing to retry.
   * The last write should belong to the last selection; whether it did was
   * decided by which IPC call the backend happened to answer first.
   *
   * It also made two visual goldens (`grid with data`, `cell selection
   * highlight`) unstable run to run: a capture taken between the click and the
   * highlight photographs a grid with no highlight, and one taken after
   * photographs a grid with it. Fixing the RACE is what makes the end state a
   * function of the selection; the capture helper then only has to wait for it
   * (see waitForGridStable in e2e/helpers/screenshots.ts).
   *
   * `cancelled` is checked after EVERY await, before every write — not once at
   * the top — because each await is a point at which a newer selection can have
   * superseded this one.
   */
  useEffect(() => {
    // Skip cell content fetch when chart series formula is displayed
    if (chartSeriesFormula) return;

    if (!editing && state.selection) {
      const { startRow, startCol, endRow, endCol } = state.selection;
      let cancelled = false;

      const fetchCellContent = async () => {
        try {
          const mergeInfo = await getMergeInfo(startRow, startCol);
          if (cancelled) return;

          let cellRow = startRow;
          let cellCol = startCol;

          if (mergeInfo) {
            cellRow = mergeInfo.startRow;
            cellCol = mergeInfo.startCol;
          } else {
            const activeMerge = await getMergeInfo(endRow, endCol);
            if (cancelled) return;
            if (activeMerge) {
              cellRow = activeMerge.startRow;
              cellCol = activeMerge.startCol;
            } else {
              cellRow = endRow;
              cellCol = endCol;
            }
          }

          // Check if this cell is a non-origin spill cell
          const spillRanges = await getSpillRanges();
          if (cancelled) return;
          let spillOrigin: { row: number; col: number } | null = null;
          for (const sr of spillRanges) {
            if (
              cellRow >= sr.originRow && cellRow <= sr.endRow &&
              cellCol >= sr.originCol && cellCol <= sr.endCol &&
              !(cellRow === sr.originRow && cellCol === sr.originCol)
            ) {
              spillOrigin = { row: sr.originRow, col: sr.originCol };
              break;
            }
          }

          if (spillOrigin) {
            // Non-origin spill cell: show the origin cell's formula in grey
            const originCell = await getCell(spillOrigin.row, spillOrigin.col);
            if (cancelled) return;
            const formula = originCell?.formula || "";
            // Show in R1C1 (relative to the origin cell) when that style is active.
            setDisplayValue(
              state.referenceStyle === "R1C1" && formula.startsWith("=")
                ? formulaA1ToR1C1(formula, spillOrigin.row, spillOrigin.col)
                : formula,
            );
            setIsSpillRef(true);
            if (formula && formula.startsWith("=")) {
              const refs = parseFormulaReferences(formula, true);
              dispatch(setFormulaReferences(refs));
            } else {
              dispatch(clearFormulaReferences());
            }
          } else {
            const cell = await getCell(cellRow, cellCol);
            if (cancelled) return;
            setIsSpillRef(false);
            if (cell) {
              let content = cell.formula || cell.display || "";

              // Formula hiding: if sheet is protected and cell has formulaHidden, show blank
              if (cell.formula && cell.formula.startsWith("=")) {
                try {
                  const [sheetProt, cellProt] = await Promise.all([
                    isSheetProtected(),
                    getCellProtection(cellRow, cellCol),
                  ]);
                  if (cancelled) return;
                  if (sheetProt && cellProt.formulaHidden) {
                    content = "";
                  }
                } catch {
                  // Ignore errors - show formula as fallback
                }
                if (cancelled) return;
              }

              // Show the formula in R1C1 notation when that reference style is
              // active; the A1 form (content) still drives reference highlighting.
              setDisplayValue(
                state.referenceStyle === "R1C1" && content.startsWith("=")
                  ? formulaA1ToR1C1(content, cellRow, cellCol)
                  : content,
              );

              // FIX: Parse formula references for passive highlighting when selecting a formula cell
              if (content && content.startsWith("=")) {
                const refs = parseFormulaReferences(content, true);
                dispatch(setFormulaReferences(refs));
              } else {
                dispatch(clearFormulaReferences());
              }
            } else {
              setDisplayValue("");
              dispatch(clearFormulaReferences());
            }
          }
        } catch (error) {
          if (cancelled) return;
          console.error("[FormulaInput] Failed to fetch cell content:", error);
          setDisplayValue("");
          setIsSpillRef(false);
          dispatch(clearFormulaReferences());
        }
      };

      fetchCellContent();
      return () => {
        cancelled = true;
      };
    }
  }, [editing, state.selection, state.referenceStyle, dispatch, chartSeriesFormula]);

  // Listen for chart selection changes to show SERIES formula
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.chartId == null) {
        // Chart deselected — clear chart formula state
        if (chartSeriesFormula !== null) {
          setChartSeriesFormula(null);
          setChartSeriesRefMode(false);
        }
        return;
      }

      if (detail.seriesFormula) {
        // Series selected — show SERIES formula and highlight ranges
        setChartSeriesFormula(detail.seriesFormula);
        setDisplayValue(detail.seriesFormula);

        // Parse the SERIES formula to extract range references for highlighting
        const refs = parseFormulaReferences(detail.seriesFormula, false);
        dispatch(setFormulaReferences(refs));

        // Enable chart series reference mode for drag/resize
        setChartSeriesRefMode(true);
      } else {
        // Chart selected but no series (Level 1) — clear series formula
        setChartSeriesFormula(null);
        setChartSeriesRefMode(false);
        dispatch(clearFormulaReferences());
      }
    };

    window.addEventListener(AppEvents.CHART_SELECTION_CHANGED, handler);
    return () => {
      window.removeEventListener(AppEvents.CHART_SELECTION_CHANGED, handler);
    };
  }, [chartSeriesFormula, dispatch]);

  // Listen for autocomplete accepted events to update the formula bar value
  React.useEffect(() => {
    const handleAccepted = (e: Event) => {
      const { newValue, newCursorPosition } = (e as CustomEvent).detail;
      setDisplayValue(newValue);
      if (editing) {
        updateValue(newValue);
      }
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        }
      });
    };

    window.addEventListener(AutocompleteEvents.ACCEPTED, handleAccepted);
    return () => window.removeEventListener(AutocompleteEvents.ACCEPTED, handleAccepted);
  }, [editing, updateValue]);

  /**
   * Tell the autocomplete extension what the caret is standing in.
   *
   * Both halves of that feature read this one event, and they need it at
   * different moments: the suggestion dropdown only while a name is being
   * TYPED, but the function screen tip whenever the CARET moves — its whole job
   * is to say which argument of which (innermost) call the caret is in.
   */
  const emitAutocompleteInput = useCallback((value: string, cursorPos: number) => {
    const inputEl = inputRef.current;
    if (!inputEl) return;
    const rect = inputEl.getBoundingClientRect();
    window.dispatchEvent(
      new CustomEvent(AutocompleteEvents.INPUT, {
        detail: {
          value,
          cursorPosition: cursorPos,
          anchorRect: {
            x: rect.left,
            y: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
          source: "formulaBar",
        },
      })
    );
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<FormulaEditorElement>) => {
      const newValue = e.target.value;
      setDisplayValue(newValue);
      if (editing) {
        updateValue(newValue);
      }

      // FIX: Track cursor position globally for cursor-aware formula mode detection
      const cursorPos = inputRef.current?.selectionStart ?? newValue.length;
      setGlobalCursorPosition(cursorPos);

      emitAutocompleteInput(newValue, cursorPos);
    },
    [editing, updateValue, emitAutocompleteInput]
  );

  const handleFocus = useCallback(async () => {
    // Block editing in spill ref cells (non-origin spill cells are read-only)
    if (isSpillRef) {
      if (inputRef.current) inputRef.current.blur();
      return;
    }

    // Block editing in protected ranges (e.g., pivot tables)
    if (state.selection) {
      const guard = checkRangeGuards(
        state.selection.endRow, state.selection.endCol,
        state.selection.endRow, state.selection.endCol
      );
      if (guard?.blocked) {
        // Blur immediately to prevent typing
        if (inputRef.current) inputRef.current.blur();
        return;
      }
    }

    setIsFocused(true);
    setGlobalIsEditing(true);

    if (!editing && state.selection) {
      await startEdit(state.selection.endRow, state.selection.endCol);
    }

    // An edit that OPENS on an existing formula gets its screen tip straight
    // away. Nothing else emits for this: the first keystroke used to be the
    // earliest the extension heard anything at all, so clicking into
    // `=VLOOKUP(...)` to check which argument you were on showed nothing.
    const inputEl = inputRef.current;
    if (inputEl && inputEl.value.startsWith("=")) {
      emitAutocompleteInput(inputEl.value, inputEl.selectionStart ?? inputEl.value.length);
    }
  }, [editing, state.selection, startEdit, isSpillRef, emitAutocompleteInput]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
  }, []);

  /**
   * FIX: Track cursor position changes from arrow keys, mouse clicks within input, etc.
   * This ensures globalCursorPosition stays accurate even when the value doesn't change.
   *
   * It also re-emits the autocomplete input, because the screen tip resolves
   * the INNERMOST open call: arrowing or clicking out of `SUM` into the nested
   * `ROUND` changes which tip is correct without changing a character of the
   * formula. Emitting only from onChange meant that logic — which is written
   * and correct — was simply never re-run, so the tip kept describing the call
   * the caret had left. (The Define Name dialog's "Refers to" field has always
   * emitted from onSelect; the grid's two editors had not.)
   */
  const handleSelect = useCallback(() => {
    const inputEl = inputRef.current;
    if (!inputEl) return;
    const cursorPos = inputEl.selectionStart ?? inputEl.value.length;
    setGlobalCursorPosition(cursorPos);
    if (inputEl.value.startsWith("=")) {
      emitAutocompleteInput(inputEl.value, cursorPos);
    }
  }, [emitAutocompleteInput]);

  /**
   * THE TEXTAREA TRAP. Expanded, this runs on a <textarea>, where Enter inserts
   * a newline by DEFAULT. Every branch below that ends an entry — Enter, Tab,
   * Escape — therefore has to keep calling preventDefault() before it commits,
   * or committing an entry would also leave a stray "\n" in the cell. The one
   * key that is allowed to type a newline is Alt+Enter, and it does so by
   * splicing the character itself rather than by letting the default through,
   * which is exactly what the in-cell editor (a <textarea> since it shipped)
   * does. Nothing in here may be "simplified" by dropping a preventDefault.
   */
  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<FormulaEditorElement>) => {
      e.stopPropagation();

      // Intercept keys for formula autocomplete when the dropdown is visible
      if (isFormulaAutocompleteVisible()) {
        const autocompleteKeys = ["ArrowUp", "ArrowDown", "Tab", "Escape", "Enter"];
        if (autocompleteKeys.includes(e.key)) {
          e.preventDefault();
          window.dispatchEvent(
            new CustomEvent(AutocompleteEvents.KEY, {
              detail: { key: e.key },
            })
          );
          return;
        }
      }

      if (e.key === "Enter" && e.altKey && !e.ctrlKey && !e.metaKey) {
        // Alt+Enter - insert newline in cell
        e.preventDefault();
        e.stopPropagation();
        const inputEl = inputRef.current;
        if (inputEl) {
          const cursorPos = inputEl.selectionStart ?? inputEl.value.length;
          const currentValue = inputEl.value;
          const newValue = currentValue.slice(0, cursorPos) + "\n" + currentValue.slice(cursorPos);
          updateValue(newValue);
          requestAnimationFrame(() => {
            if (inputRef.current) {
              inputRef.current.setSelectionRange(cursorPos + 1, cursorPos + 1);
            }
          });
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const shiftKey = e.shiftKey;
        const result = await commitEdit();
        inputRef.current?.blur();
        // FIX: Dispatch event so core layer can move active cell and restore focus
        // The core layer (useSpreadsheetEditing) listens for this event
        if (result?.success) {
          window.dispatchEvent(new CustomEvent("formulaBar:commitComplete", {
            detail: { key: "Enter", shiftKey }
          }));
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        const shiftKey = e.shiftKey;
        const result = await commitEdit();
        inputRef.current?.blur();
        // FIX: Dispatch event so core layer can move active cell and restore focus
        if (result?.success) {
          window.dispatchEvent(new CustomEvent("formulaBar:commitComplete", {
            detail: { key: "Tab", shiftKey }
          }));
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        await cancelEdit();
        inputRef.current?.blur();
        // FIX: Dispatch event so core layer can restore focus to grid
        window.dispatchEvent(new CustomEvent("formulaBar:commitComplete", {
          detail: { key: "Escape", shiftKey: false }
        }));
      } else if (e.key === "F4") {
        // FIX: Toggle absolute/relative reference mode on the cell reference
        // at the current cursor position. Only active when editing a formula.
        const inputEl = inputRef.current;
        if (!inputEl) return;
        
        // Use global value (updated synchronously) with fallback to DOM
        const currentValue = getGlobalEditingValue() || inputEl.value;
        if (currentValue.startsWith("=")) {
          e.preventDefault();
          e.stopPropagation();
          const cursorPos = inputEl.selectionStart ?? 0;
          const result = toggleReferenceAtCursor(currentValue, cursorPos);
          if (result.formula !== currentValue) {
            setDisplayValue(result.formula);
            updateValue(result.formula);
            // Restore cursor position after React re-renders the input value
            requestAnimationFrame(() => {
              inputEl.setSelectionRange(result.cursorPos, result.cursorPos);
            });
          }
        }
      }
    },
    [commitEdit, cancelEdit, updateValue]
  );

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  // Check if the current selection is in a protected range (e.g., pivot table)
  const isProtectedCell = state.selection
    ? checkRangeGuards(
        state.selection.endRow, state.selection.endCol,
        state.selection.endRow, state.selection.endCol
      )?.blocked === true
    : false;

  // Read-only when showing chart series formula, protected cell, or spill ref
  const isReadOnly = isProtectedCell || chartSeriesFormula !== null || isSpillRef;

  /**
   * One ref for two element types. A callback ref takes the union without the
   * cast a `RefObject<HTMLInputElement>` would need on the textarea branch.
   */
  const setEditorRef = useCallback((el: FormulaEditorElement | null) => {
    inputRef.current = el;
  }, []);

  /**
   * Identical on both elements — including `data-formula-bar`, which is how the
   * in-cell editor decides that focus moving to the bar is a hand-off rather
   * than a blur to be committed (InlineEditor.tsx), and how the E2E helpers
   * find the bar.
   */
  const editorProps = {
    value: displayValue,
    onChange: handleChange,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
    onMouseDown: handleMouseDown,
    onSelect: handleSelect,
    readOnly: isReadOnly,
    $isFocused: isFocused,
    $isSpillRef: isSpillRef,
    "data-formula-bar": "true",
    placeholder: "",
    "aria-label": "Formula Bar",
  };

  // Collapsed the bar stays an <input>: it is the shape everything already
  // points at, and a one-line textarea would only be an input that can scroll
  // its second line out of sight.
  return expanded ? (
    <S.StyledTextArea
      ref={setEditorRef}
      rows={1}
      spellCheck={false}
      $height={editorHeight}
      {...editorProps}
    />
  ) : (
    <S.StyledInput ref={setEditorRef} type="text" {...editorProps} />
  );
}