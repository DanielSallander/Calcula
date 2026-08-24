//! FILENAME: app/src/shell/FormulaBar/NameBox.tsx
// PURPOSE: Name Box component displaying active cell address (or named range name)
//          with navigation, name creation, and dropdown support.
// CONTEXT: Shows current selection (e.g., "A1" or "SalesData") and allows typing
//          an address or name to navigate. Supports creating new names from input.
// FIX: Now participates in global editing state to prevent grid keyboard handler
//      from capturing keystrokes and starting cell editing
// FIX: Added merge-aware navigation - when navigating to a merged cell, expands selection
// REFACTOR: Imports from api layer instead of core internals
// FIX: Typing a RANGE did nothing at all. "A1:A10" missed the single-cell
//      address regex, missed the defined-name lookup and missed `isValidName`
//      (':' is not a name character), so Enter fell out of all three branches
//      onto a silent revert — no selection, no navigation, no message. The
//      accepted forms now live in ./NameBox.address, a malformed entry SAYS so,
//      and a name is resolved by the backend (which knows the SHEET it points
//      at) instead of by an inline regex over `refersTo` that dropped it.
// FIX: TABLES were invisible here in both directions. The display fell back
//      chart name -> named range -> address, and the Enter handler resolved a
//      cell reference or a defined name and nothing else — even though tables
//      and defined names deliberately share ONE namespace, which is the whole
//      reason a table name in this box means anything. So a workbook's tables
//      could not be seen, listed, or navigated to by name.

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  useGridContext,
  setSelection,
  scrollToCell,
  columnToLetter,
  getMergeInfo,
  getNamedRangeForSelection,
  getAllNamedRanges,
  createNamedRange,
  getNamedRange,
  getSheets,
  setActiveSheet,
  setActiveSheetApi,
  primeSheetSwitch,
  showToast,
  AppEvents,
  emitAppEvent,
  onAppEvent,
} from "../../api";
import type { NamedRange } from "../../api";
import { resolveNamedRangeCoords } from "../../api/lib";
import type { NamedRangeCoords } from "../../api/lib";
import {
  getAllTables,
  getTableAtCell,
  getTableByName,
  resolveStructuredReference,
} from "../../api/backend";
import type { Table } from "../../api/backend";
import { setGlobalIsEditing } from "../../api/editing";
import {
  parseNameBoxAddress,
  isAddressLike,
  hasTableBracket,
  parseStructuredReference,
} from "./NameBox.address";
import type { ParsedNameBoxAddress } from "./NameBox.address";
import { NameBoxDropdown } from "./NameBoxDropdown";
import * as S from "./NameBox.styles";

function formatSelectionAddress(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): string {
  const startColLetter = columnToLetter(startCol);
  const startRowDisplay = startRow + 1;

  if (startRow === endRow && startCol === endCol) {
    return `${startColLetter}${startRowDisplay}`;
  }

  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);

  const topLeft = `${columnToLetter(minCol)}${minRow + 1}`;
  const bottomRight = `${columnToLetter(maxCol)}${maxRow + 1}`;

  return `${topLeft}:${bottomRight}`;
}

/**
 * Build a refersTo formula string from selection coordinates.
 * Example: "=Sheet1!$A$1:$B$10"
 */
function buildRefersTo(
  sheetName: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): string {
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);

  const startRef = `$${columnToLetter(minCol)}$${minRow + 1}`;
  const endRef = `$${columnToLetter(maxCol)}$${maxRow + 1}`;

  if (minRow === maxRow && minCol === maxCol) {
    return `=${sheetName}!${startRef}`;
  }
  return `=${sheetName}!${startRef}:${endRef}`;
}

/**
 * Basic client-side name validation matching Rust rules.
 */
function isValidName(name: string): boolean {
  if (!name || name.length === 0) return false;

  const first = name[0];
  if (!/[a-zA-Z_]/.test(first)) return false;

  for (let i = 1; i < name.length; i++) {
    const ch = name[i];
    if (!/[a-zA-Z0-9_.]/.test(ch)) return false;
  }

  const upper = name.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE" || upper === "NULL") return false;

  // Cannot be a cell reference. Shares the Name Box's own parser so the two can
  // never disagree about what an address is — a second regex here is how "A1"
  // would end up both navigable and definable.
  if (isAddressLike(name)) return false;

  return true;
}

export function NameBox(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const [inputValue, setInputValue] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [matchedName, setMatchedName] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownNames, setDropdownNames] = useState<NamedRange[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  /** The table spelling the current selection matches, e.g. "Sales[#All]". */
  const [matchedTable, setMatchedTable] = useState<string | null>(null);
  /** Which of the dropdown's rows are TABLES rather than defined names. */
  const [dropdownTableNames, setDropdownTableNames] = useState<Set<string>>(
    () => new Set<string>(),
  );
  /** Bumped by any table change, to re-derive the displayed table spelling. */
  const [tableRevision, setTableRevision] = useState(0);

  /** Chart name to display when a chart is selected. */
  const [chartName, setChartName] = useState<string | null>(null);

  const displayAddress = state.selection
    ? formatSelectionAddress(
        state.selection.startRow,
        state.selection.startCol,
        state.selection.endRow,
        state.selection.endCol
      )
    : "A1";

  // Check if the current selection matches a named range
  useEffect(() => {
    if (!state.selection || isEditing) return;

    let cancelled = false;
    const sel = state.selection;

    getNamedRangeForSelection(
      state.sheetContext.activeSheetIndex,
      Math.min(sel.startRow, sel.endRow),
      Math.min(sel.startCol, sel.endCol),
      Math.max(sel.startRow, sel.endRow),
      Math.max(sel.startCol, sel.endCol)
    )
      .then((nr) => {
        if (cancelled) return;
        if (nr) {
          setMatchedName(nr.name);
        } else {
          setMatchedName(null);
        }
      })
      .catch(() => {
        if (!cancelled) setMatchedName(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    state.selection?.startRow,
    state.selection?.startCol,
    state.selection?.endRow,
    state.selection?.endCol,
    state.sheetContext.activeSheetIndex,
    isEditing,
  ]);

  // Listen for named range changes to refresh the matched name
  useEffect(() => {
    return onAppEvent(AppEvents.NAMED_RANGES_CHANGED, () => {
      setMatchedName(null); // Will re-check on next render cycle
    });
  }, []);

  /**
   * The TABLE spelling for the current selection, the way Excel shows one.
   *
   * Excel's rule is not "the cursor is inside a table": a single cell in a
   * table shows its ADDRESS. A name appears when the selection IS one of the
   * table's blocks — its data body ("Sales"), the whole table ("Sales[#All]"),
   * or one column's data ("Sales[Margin]"). That is exactly the set of
   * spellings the Enter handler below can navigate back to, which is the point:
   * anything this box displays must be something this box accepts.
   *
   * Where the data body IS comes from the backend's `[#Data]`, which owns
   * `data_start_row()`/`data_end_row()`. Deriving it here from `headerRow` and
   * `totalRow` would be a third copy of that arithmetic — the Table extension
   * already has the second — and the copy that drifts shows the user a name
   * that selects a different block than the one they were looking at.
   */
  useEffect(() => {
    if (!state.selection || isEditing) return;

    const sel = state.selection;
    const minRow = Math.min(sel.startRow, sel.endRow);
    const maxRow = Math.max(sel.startRow, sel.endRow);
    const minCol = Math.min(sel.startCol, sel.endCol);
    const maxCol = Math.max(sel.startCol, sel.endCol);

    // One cell is an address in Excel, table or no table. Short-circuiting here
    // also keeps arrow-key navigation off the IPC path entirely.
    if (minRow === maxRow && minCol === maxCol) {
      setMatchedTable(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const table = await getTableAtCell(sel.endRow, sel.endCol);
        if (cancelled) return;
        if (!table) {
          setMatchedTable(null);
          return;
        }

        if (
          minRow === table.startRow &&
          maxRow === table.endRow &&
          minCol === table.startCol &&
          maxCol === table.endCol
        ) {
          // A table with neither a header nor a totals row IS its data body, and
          // Excel spells that with the bare name.
          const wholeIsMoreThanData =
            table.styleOptions.headerRow || table.styleOptions.totalRow;
          setMatchedTable(wholeIsMoreThanData ? `${table.name}[#All]` : table.name);
          return;
        }

        const data = await resolveStructuredReference(`${table.name}[#Data]`);
        if (cancelled) return;
        const body = data.success ? data.resolved : undefined;
        if (!body || minRow !== body.startRow || maxRow !== body.endRow) {
          setMatchedTable(null);
          return;
        }
        if (minCol === body.startCol && maxCol === body.endCol) {
          setMatchedTable(table.name);
          return;
        }
        if (minCol === maxCol) {
          const column = table.columns[minCol - table.startCol];
          if (column) {
            setMatchedTable(`${table.name}[${column.name}]`);
            return;
          }
        }
        setMatchedTable(null);
      } catch (error) {
        console.error("[NameBox] Failed to match the selection to a table:", error);
        if (!cancelled) setMatchedTable(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    state.selection?.startRow,
    state.selection?.startCol,
    state.selection?.endRow,
    state.selection?.endCol,
    state.sheetContext.activeSheetIndex,
    isEditing,
    tableRevision,
  ]);

  // A rename, a resize or a totals row changes what the selection is called
  // without moving the selection, so the effect above needs a reason to re-run.
  useEffect(() => {
    const bump = () => setTableRevision((n) => n + 1);
    const offUpdated = onAppEvent(AppEvents.TABLE_DEFINITIONS_UPDATED, bump);
    const offCreated = onAppEvent(AppEvents.TABLE_CREATED, bump);
    return () => {
      offUpdated();
      offCreated();
    };
  }, []);

  // Listen for chart selection changes to show chart name
  useEffect(() => {
    return onAppEvent(AppEvents.CHART_SELECTION_CHANGED, (detail: unknown) => {
      const d = detail as { chartId?: number | null; chartName?: string | null } | null;
      if (d && d.chartId != null && d.chartName) {
        setChartName(d.chartName);
      } else {
        setChartName(null);
      }
    });
  }, []);

  // Listen for F5 / Go To - focus the Name Box input
  useEffect(() => {
    return onAppEvent(AppEvents.NAMEBOX_FOCUS, () => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    });
  }, []);

  // The displayed value: chart name > matched named range > table > address.
  // A defined name and a table name can both be exact for the same block (you
  // may define a name over a table's data body). Both are true, both navigate
  // to the same cells, and the tie goes to the one the user typed themselves.
  const displayValue = chartName ?? matchedName ?? matchedTable ?? displayAddress;

  // Sync inputValue with displayValue when not editing
  const [prevDisplay, setPrevDisplay] = useState(displayValue);
  if (displayValue !== prevDisplay) {
    setPrevDisplay(displayValue);
    if (!isEditing) {
      setInputValue(displayValue);
    }
  }

  useEffect(() => {
    if (!isEditing) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setIsEditing(false);
        setGlobalIsEditing(false);
        setInputValue(displayValue);
      }
    };

    document.addEventListener("mousedown", handleMouseDown, { capture: true });
    return () => {
      document.removeEventListener("mousedown", handleMouseDown, {
        capture: true,
      });
    };
  }, [isEditing, displayValue]);

  const handleFocus = useCallback(() => {
    setIsEditing(true);
    setGlobalIsEditing(true);
    setShowDropdown(false);
    setTimeout(() => {
      inputRef.current?.select();
    }, 0);
  }, []);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    setGlobalIsEditing(false);
    setInputValue(displayValue);
  }, [displayValue]);

  const navigateToCell = useCallback(
    async (row: number, col: number) => {
      try {
        const mergeInfo = await getMergeInfo(row, col);

        if (mergeInfo) {
          dispatch(
            setSelection({
              startRow: mergeInfo.startRow,
              startCol: mergeInfo.startCol,
              endRow: mergeInfo.endRow,
              endCol: mergeInfo.endCol,
              type: "cells",
            })
          );
          dispatch(scrollToCell(mergeInfo.startRow, mergeInfo.startCol, false));
        } else {
          dispatch(
            setSelection({
              startRow: row,
              startCol: col,
              endRow: row,
              endCol: col,
              type: "cells",
            })
          );
          dispatch(scrollToCell(row, col, false));
        }
      } catch (error) {
        console.error("[NameBox] Failed to get merge info:", error);
        dispatch(
          setSelection({
            startRow: row,
            startCol: col,
            endRow: row,
            endCol: col,
            type: "cells",
          })
        );
        dispatch(scrollToCell(row, col, false));
      }
    },
    [dispatch]
  );

  /** Select a block and bring its top-left into view. */
  const selectRange = useCallback(
    (range: {
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
      type?: "cells" | "rows" | "columns";
    }) => {
      dispatch(
        setSelection({
          startRow: range.startRow,
          startCol: range.startCol,
          endRow: range.endRow,
          endCol: range.endCol,
          type: range.type ?? "cells",
        })
      );
      dispatch(scrollToCell(range.startRow, range.startCol, false));
    },
    [dispatch]
  );

  /**
   * Switch the active sheet, the way a sheet-tab click does.
   *
   * The sequence is copied from SheetTabs' normal-mode tab click on purpose:
   * without `primeSheetSwitch` the canvas keeps painting the OLD sheet's cells
   * under the new sheet's name for a frame (BUG-0052), and without the
   * SHEET_CHANGED announcement the tab strip goes on highlighting the sheet the
   * user just left, because that is what SheetTabs reloads itself from.
   */
  const switchToSheet = useCallback(
    async (index: number) => {
      window.dispatchEvent(
        new CustomEvent("sheet:beforeSwitch", {
          detail: {
            oldSheetIndex: state.sheetContext.activeSheetIndex,
            newSheetIndex: index,
          },
        })
      );

      const result = await setActiveSheetApi(index);
      await primeSheetSwitch(result.activeIndex);
      const activeName = result.sheets[result.activeIndex]?.name ?? "";

      dispatch(setActiveSheet(result.activeIndex, activeName));
      window.dispatchEvent(
        new CustomEvent("sheet:normalSwitch", {
          detail: { newSheetIndex: result.activeIndex, newSheetName: activeName },
        })
      );
      emitAppEvent(AppEvents.SHEET_CHANGED, {
        sheetIndex: result.activeIndex,
        sheetName: activeName,
      });
    },
    [dispatch, state.sheetContext.activeSheetIndex]
  );

  /**
   * Go to a parsed address. Returns null on success, or the sentence to show the
   * user — a Name Box entry that cannot be honoured must SAY so; reverting the
   * text is indistinguishable from the app having ignored the keypress.
   */
  const goToAddress = useCallback(
    async (address: ParsedNameBoxAddress): Promise<string | null> => {
      if (address.sheetName) {
        const { sheets } = await getSheets();
        const index = sheets.findIndex(
          (s) => s.name.toLowerCase() === address.sheetName!.toLowerCase()
        );
        if (index === -1) {
          return `There is no sheet named "${address.sheetName}" in this workbook.`;
        }
        if (index !== state.sheetContext.activeSheetIndex) {
          await switchToSheet(index);
        }
      }

      // Merge expansion is a SINGLE-CELL behaviour. Expanding a typed range to
      // its top-left cell's merged block would silently select something other
      // than what the user asked for.
      if (address.isSingleCell) {
        await navigateToCell(address.startRow, address.startCol);
      } else {
        selectRange(address);
      }
      return null;
    },
    [navigateToCell, selectRange, switchToSheet, state.sheetContext.activeSheetIndex]
  );

  /**
   * Go to a defined name. Returns null on success, or the sentence to show.
   *
   * Resolution is the BACKEND's (`resolve_named_range_coords`), not a regex over
   * `refersTo` as it used to be here and in the dropdown. That regex dropped the
   * sheet prefix, so a workbook-scoped name pointing at Sheet3 selected those
   * coordinates on whatever sheet was active — a silent wrong answer — and when
   * it simply did not match it closed the box having done nothing at all.
   */
  const goToNamedRange = useCallback(
    async (nr: NamedRange): Promise<string | null> => {
      let coords: NamedRangeCoords;
      try {
        coords = await resolveNamedRangeCoords(nr.name);
      } catch {
        return `"${nr.name}" does not refer to a range that can be selected (${nr.refersTo}).`;
      }

      if (coords.sheetIndex !== state.sheetContext.activeSheetIndex) {
        const { sheets } = await getSheets();
        if (!sheets[coords.sheetIndex]) {
          return `"${nr.name}" refers to a sheet that is no longer in this workbook.`;
        }
        await switchToSheet(coords.sheetIndex);
      }

      selectRange(coords);
      return null;
    },
    [selectRange, switchToSheet, state.sheetContext.activeSheetIndex]
  );

  /**
   * Go to a structured (table) reference. Returns null on success, or the
   * sentence to show.
   *
   * Resolution is the BACKEND's `resolve_structured_reference`, for the same
   * reason a defined name is: it knows which SHEET the table lives on, and it
   * owns where a table's data starts and stops. The Name Box hands it the text
   * and reads back coordinates.
   */
  const goToStructuredReference = useCallback(
    async (reference: string): Promise<string | null> => {
      let result;
      try {
        result = await resolveStructuredReference(reference);
      } catch (error) {
        console.error("[NameBox] Failed to resolve a table reference:", error);
        return `Could not resolve "${reference}": ${String(error)}`;
      }
      if (!result.success || !result.resolved) {
        return (
          result.error ?? `"${reference}" does not refer to a range that can be selected.`
        );
      }

      const coords = result.resolved;
      if (coords.sheetIndex !== state.sheetContext.activeSheetIndex) {
        const { sheets } = await getSheets();
        if (!sheets[coords.sheetIndex]) {
          return `"${reference}" refers to a sheet that is no longer in this workbook.`;
        }
        await switchToSheet(coords.sheetIndex);
      }

      selectRange(coords);
      return null;
    },
    [selectRange, switchToSheet, state.sheetContext.activeSheetIndex],
  );

  /** Leave edit mode after an entry that was honoured. */
  const finishEditing = useCallback(() => {
    setIsEditing(false);
    setGlobalIsEditing(false);
    inputRef.current?.blur();
  }, []);

  /**
   * Refuse out loud, and KEEP what the user typed (selected, ready to fix).
   * The old code reverted the text and logged nothing the user could see.
   */
  const reportProblem = useCallback((message: string) => {
    showToast(message, { variant: "error" });
    inputRef.current?.select();
  }, []);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();

      if (e.key === "Enter") {
        e.preventDefault();
        const value = inputValue.trim();
        if (!value) {
          setInputValue(displayValue);
          return;
        }

        // 1. An ADDRESS: cell or range, relative or absolute, this sheet or
        //    another. `parseNameBoxAddress` returns null both for "not an
        //    address" and for a malformed one, which is deliberate — a
        //    malformed address is indistinguishable from a name until the name
        //    lookup below has also missed.
        const address = parseNameBoxAddress(value);
        if (address) {
          const problem = await goToAddress(address);
          if (problem) {
            reportProblem(problem);
            return;
          }
          finishEditing();
          return;
        }

        // 2. A STRUCTURED REFERENCE: Sales[Margin], Sales[#All], Sales[#Totals].
        //    Decided by the BRACKET, before the name branches, because '[' is
        //    neither an address character nor a name character — every one of
        //    these spellings used to fall through all three branches and be
        //    refused with a sentence about cell references, including the exact
        //    text this box had just displayed.
        if (hasTableBracket(value)) {
          if (!parseStructuredReference(value)) {
            reportProblem(
              `"${value}" is not a table reference this box can read. ` +
                "Type a table name (Sales), a column (Sales[Margin]) or a part " +
                "of it (Sales[#All], Sales[#Headers], Sales[#Totals]).",
            );
            return;
          }
          const problem = await goToStructuredReference(value);
          if (problem) {
            reportProblem(problem);
            return;
          }
          finishEditing();
          return;
        }

        // 3. An existing DEFINED NAME.
        let existing: NamedRange | null = null;
        try {
          existing = await getNamedRange(value);
        } catch (error) {
          console.error("[NameBox] Failed to look up name:", error);
        }
        if (existing) {
          const problem = await goToNamedRange(existing);
          if (problem) {
            reportProblem(problem);
            return;
          }
          finishEditing();
          return;
        }

        // 4. A TABLE NAME. Tables and defined names share one namespace — the
        //    backend refuses a name that would shadow a table — so this cannot
        //    be reached by anything branch 3 could have answered. A bare table
        //    name means the table's DATA, which is what Excel selects and what
        //    the box displays for that block.
        //
        //    The lookup is by NAME rather than by trying `[#Data]` and reading
        //    the error text: a failure here must fall through to the
        //    create-a-name branch below, and telling "no such table" from "that
        //    table cannot answer" by string-matching a backend message is the
        //    kind of test that passes until someone rewords the message.
        let table: Table | null = null;
        try {
          table = await getTableByName(value);
        } catch (error) {
          console.error("[NameBox] Failed to look up table:", error);
        }
        if (table) {
          const problem = await goToStructuredReference(`${table.name}[#Data]`);
          if (problem) {
            reportProblem(problem);
            return;
          }
          finishEditing();
          return;
        }

        // 5. An UNKNOWN name defines itself over the current selection. Excel
        //    does this without asking and so does Calcula; what changed is that
        //    a refusal (duplicate name, name that shadows a table) now reaches
        //    the user instead of console.warn, where a rejected definition
        //    looked exactly like a successful one.
        if (isValidName(value) && state.selection) {
          const sel = state.selection;
          const refersTo = buildRefersTo(
            state.sheetContext.activeSheetName,
            sel.startRow,
            sel.startCol,
            sel.endRow,
            sel.endCol
          );

          try {
            const result = await createNamedRange(value, null, refersTo);
            if (!result.success) {
              reportProblem(result.error ?? `Could not define the name "${value}".`);
              return;
            }
            setMatchedName(value);
            emitAppEvent(AppEvents.NAMED_RANGES_CHANGED);
          } catch (error) {
            console.error("[NameBox] Failed to create named range:", error);
            reportProblem(`Could not define the name "${value}": ${String(error)}`);
            return;
          }

          finishEditing();
        } else {
          reportProblem(
            `"${value}" is not a valid cell reference or defined name. ` +
              "Type an address (A1, A1:B10, Sheet2!A1) or a name that starts " +
              "with a letter or underscore."
          );
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsEditing(false);
        setGlobalIsEditing(false);
        setInputValue(displayValue);
        inputRef.current?.blur();
      }
    },
    [
      inputValue,
      displayValue,
      goToAddress,
      goToNamedRange,
      goToStructuredReference,
      finishEditing,
      reportProblem,
      state.selection,
      state.sheetContext,
    ]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setInputValue(e.target.value);
    },
    []
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLInputElement>) => {
      e.stopPropagation();
    },
    []
  );

  const handleDropdownToggle = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (showDropdown) {
        setShowDropdown(false);
        return;
      }

      try {
        // Names AND tables. They share one namespace, so a list that showed
        // only half of it was telling the user their tables did not exist —
        // Excel lists both here and so does the Name Manager.
        //
        // LIMITATION, stated rather than hidden: `getAllTables` answers for the
        // ACTIVE SHEET. The backend has `get_tables_all_sheets` and @api/backend
        // has no wrapper over it yet, so a table on another sheet can be TYPED
        // into this box (that path resolves workbook-wide) but cannot be picked
        // out of this list.
        const [names, tables] = await Promise.all([getAllNamedRanges(), getAllTables()]);
        const tableRows: NamedRange[] = tables.map((table) => ({
          name: table.name,
          sheetIndex: table.sheetIndex,
          refersTo: buildRefersTo(
            state.sheetContext.activeSheetName,
            table.startRow,
            table.startCol,
            table.endRow,
            table.endCol,
          ),
        }));
        setDropdownTableNames(new Set(tableRows.map((row) => row.name)));
        setDropdownNames(
          [...names, ...tableRows].sort((a, b) => {
            // Case-insensitive, and deliberately NOT localeCompare: this box is
            // a list of identifiers, and a locale-aware collation would order
            // them differently for a Swedish user than for anyone else.
            const left = a.name.toUpperCase();
            const right = b.name.toUpperCase();
            if (left === right) return 0;
            return left < right ? -1 : 1;
          }),
        );
        setShowDropdown(true);
      } catch (error) {
        console.error("[NameBox] Failed to fetch named ranges:", error);
      }
    },
    [showDropdown, state.sheetContext.activeSheetName]
  );

  const handleDropdownSelect = useCallback(
    async (nr: NamedRange) => {
      setShowDropdown(false);
      // A table row goes through the table route: `resolve_named_range_coords`
      // knows nothing about tables and would refuse it, which would read as the
      // list offering something it cannot open.
      if (dropdownTableNames.has(nr.name)) {
        const tableProblem = await goToStructuredReference(`${nr.name}[#Data]`);
        if (tableProblem) reportProblem(tableProblem);
        return;
      }
      // Same resolution as typing the name: the backend knows which SHEET the
      // name lives on. The regex this replaced ignored the sheet prefix, so
      // picking a name defined on another sheet selected those coordinates on
      // the sheet you were already looking at.
      const problem = await goToNamedRange(nr);
      if (problem) reportProblem(problem);
    },
    [dropdownTableNames, goToNamedRange, goToStructuredReference, reportProblem]
  );

  const handleDropdownClose = useCallback(() => {
    setShowDropdown(false);
  }, []);

  return (
    <S.NameBoxWrapper>
      <S.StyledNameBoxInput
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onMouseDown={handleMouseDown}
        $isEditing={isEditing}
        aria-label="Name Box"
      />
      <S.DropdownArrow
        onMouseDown={handleDropdownToggle}
        tabIndex={-1}
        aria-label="Show named ranges"
      >
        &#9660;
      </S.DropdownArrow>
      {showDropdown && (
        <NameBoxDropdown
          names={dropdownNames}
          onSelect={handleDropdownSelect}
          onClose={handleDropdownClose}
        />
      )}
    </S.NameBoxWrapper>
  );
}
