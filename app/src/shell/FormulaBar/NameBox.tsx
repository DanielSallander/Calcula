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
// FIX: The chart half is read from the `@api/chartSelection` REGISTRY instead of
//      hand-parsed out of the raw CHART_SELECTION_CHANGED payload. The old
//      reader pulled `chartName` out of the event and showed that and nothing
//      else, so selecting a series, a point, an axis or the chart title all
//      printed "Chart 1" — the box said WHICH chart but never WHAT in it. The
//      registry derives Excel's own Name Box wording in one place; the shell
//      renders it verbatim and derives nothing.
//
//      PRODUCT DECISION (D5-5), LANDED: at `level: "chart"` the Name Box says
//      "Chart Area", not the chart's name — and it says `Chart 1 Chart Area`,
//      qualified, because this is the ONLY surface that tells the reader WHICH
//      chart is selected. Excel can afford the bare wording; its charts are
//      sheet-scoped objects whose identity its Name Box carries separately, and
//      dropping the name to match it exactly would trade one known fact for
//      another instead of adding it.
//
//      `level: "chart"` IS the chart area — which is why the Format pane
//      already shows chart-area fields there — and `elementId: "chartArea"` is
//      the element vocabulary's name for the same canvas, so the two are one
//      rung and return ONE string. (The PLOT area is a different region and now
//      has a rung of its own that both the mouse and the keyboard can reach; it
//      reads "Plot Area".) The wording lives in `chartSelectionDisplayName`
//      (`app/src/api/chartSelection.ts`) and NOWHERE ELSE; this component
//      renders `displayName` verbatim, so the pane header and the box moved
//      together with that one function.

import React, { useState, useEffect, useRef, useCallback, useSyncExternalStore } from "react";
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
// Deliberately the SUBPATH, the way this file already reaches `api/lib`,
// `api/backend` and `api/editing`. The registry is a dependency-free store, and
// importing it by subpath keeps it out of the barrel doubles the Name Box's own
// tests install — a barrel mock that does not list a newly used export makes it
// `undefined` and the component throws on mount.
import { getChartSelection, onChartSelectionChanged } from "../../api/chartSelection";
// The same reasoning, and the same shape, for every other floating object.
import {
  EMPTY_OBJECT_LABEL,
  getObjectLabel,
  onObjectLabelChanged,
  type ObjectLabelSnapshot,
} from "../../api/objectSelectionLabel";
// And for an EXTERNAL cell (a selected floating-grid cell, or its open edit):
// the address it publishes, and the resolver its owner registers so that what
// this box displays ("Float1!B2") it also accepts. Dependency-free store; the
// subpath keeps it out of this box's own `api/editing` double.
import {
  subscribeExternalEdit,
  getExternalEditVersion,
  getExternalNameBoxAddress,
  resolveExternalAddress,
} from "../../api/externalEdit";
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

  /**
   * What the Name Box shows while something inside a chart is selected.
   *
   * READ FROM THE REGISTRY, NOT FROM THE EVENT. This used to subscribe to the
   * raw `CHART_SELECTION_CHANGED` CustomEvent and pick `chartName` out of the
   * payload by hand, which made the shell a fourth place that re-derived the
   * chart selection — exactly the duplication `@api/chartSelection` was added to
   * retire, and the reason the box could only ever say the chart's name however
   * deep the ladder had gone. The registry already derives Excel's Name Box
   * wording ("Series 1 Point 3", "Chart Title", "Vertical (Value) Axis") in ONE
   * place, so the shell reads it and renders it verbatim. Deriving anything from
   * the snapshot's parts here would put the decision back in two places.
   *
   * It starts EMPTY and is filled by the subscribing effect's first read, which
   * is not the same as seeding it from the registry here. The box syncs its
   * input text on a CHANGE of the displayed value, so a label that is already
   * correct at the first render never reaches the input: mounting while a chart
   * is selected (a panel toggle, a re-mount after a sheet switch) would render
   * a blank box. Letting the effect move it from "" to the label is the change
   * the sync is waiting for.
   */
  const [chartLabel, setChartLabel] = useState<string>("");

  /**
   * What the Name Box shows while floating OBJECTS are selected on a canvas:
   * the object's name ("Slicer_Region", "Sales"), or "3 objects" for a
   * multi-selection -- published by the canvas through
   * `@api/objectSelectionLabel`, rendered verbatim. Starts EMPTY for the same
   * reason `chartLabel` does: the subscribing effect's first read is the change
   * the input sync waits for.
   */
  const [objectLabel, setObjectLabel] = useState<ObjectLabelSnapshot>(EMPTY_OBJECT_LABEL);

  /**
   * The EXTERNAL cell's address ("Float1!A1", "Float1!A1:B3", "'My Float'!A1"):
   * a selected floating-grid cell, or the cell its open edit belongs to. A
   * CORE edit wins: the address of the cell actually being edited is Core's.
   *
   * SUBSCRIBED BY THE STORE'S VERSION, READ DURING RENDER -- never with the
   * address itself as the snapshot. This component sets state DURING render
   * (the `prevDisplay` sync below), and a render-phase update makes React
   * re-run the render without keeping useSyncExternalStore's record of the
   * snapshot it just rendered. With the address as the snapshot, that record
   * stayed at the value BEFORE the publish, so withdrawing the address (back to
   * that same value) looked like "no change" and the box went on showing
   * "Float1!B3" after the floating-grid cell was gone. The version never
   * repeats, so a stale record still compares as changed. (Measured in
   * nameBoxExternalAddress.test.tsx.)
   */
  useSyncExternalStore(subscribeExternalEdit, getExternalEditVersion);
  const shownExternal = state.editing ? null : getExternalNameBoxAddress();

  const displayAddress = state.selection
    ? formatSelectionAddress(
        state.selection.startRow,
        state.selection.startCol,
        state.selection.endRow,
        state.selection.endCol
      )
    : // A CANVAS has no cell cursor: an "A1" here would name a cell nobody
      // can see. The box stays empty until an object publishes its label.
      state.surface === "canvas"
      ? ""
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

  // Follow the published chart selection. `displayName` is "" when no chart is
  // selected, which is the registry's own way of saying "show the address".
  useEffect(() => {
    setChartLabel(getChartSelection().displayName);
    return onChartSelectionChanged((snapshot) => {
      setChartLabel(snapshot.displayName);
    });
  }, []);

  // Follow the published object label. Its text is "" when nothing is
  // labelled -- a worksheet, or a canvas with nothing selected.
  useEffect(() => {
    setObjectLabel(getObjectLabel());
    return onObjectLabelChanged((snapshot) => {
      setObjectLabel(snapshot);
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

  // The displayed value: chart selection > matched named range > table > address.
  // A defined name and a table name can both be exact for the same block (you
  // may define a name over a table's data body). Both are true, both navigate
  // to the same cells, and the tie goes to the one the user typed themselves.
  //
  // The chart label wins outright because while a chart is selected the grid
  // selection underneath it has not moved, so the address would name a cell the
  // user is not looking at.
  //
  // Then the OBJECT label (a canvas's selected slicer, timeline, floating range,
  // pivot box or control), for the same reason. One exception reorders the two:
  // a MULTI-selection's "3 objects" beats the chart label, because a chart's
  // rung ("Series 1") names one member of the selection, not the selection.
  //
  // An EXTERNAL cell's address sits between the chart rung and the object
  // label: a selected floating-grid CELL is more specific than the floating
  // grid's own name ("Float1!B3" beats "Float1"), and on a worksheet it is the
  // only true answer -- the grid address is Core's last active cell, hidden
  // under the floating grid. With the object selected and no cell selected,
  // the object label stays.
  const objectText = objectLabel.text !== "" ? objectLabel.text : null;
  const multiObjectText = objectLabel.count > 1 ? objectText : null;
  const displayValue =
    multiObjectText ??
    (chartLabel !== "" ? chartLabel : null) ??
    shownExternal ??
    objectText ??
    matchedName ??
    matchedTable ??
    displayAddress;

  // Sync inputValue with displayValue when not editing.
  //
  // THE SENTINEL IS THE POINT. `prevDisplay` used to be seeded with the FIRST
  // `displayValue`, while `inputValue` starts "" — so on the very first pass
  // the two were already "equal", nothing reconciled them, and the Name Box
  // rendered an EMPTY input until something moved. Mounting on a selection
  // that never changes (the app's own first paint, a panel toggle, a re-mount
  // after a sheet switch) showed a blank box where Excel shows "A1".
  //
  // `null` is a value `displayValue` can never take — it falls back through
  // chart label -> name -> table -> `displayAddress`, and `displayAddress` is
  // "A1" even with no selection — so seeding with it makes the FIRST render a
  // change like any other, and the one branch below does the work for both the
  // first pass and every later one. (Writing `setInputValue(displayValue)`
  // into a mount effect instead would be a second copy of the same rule, on a
  // different schedule, for the one case that is hardest to notice.)
  const [prevDisplay, setPrevDisplay] = useState<string | null>(null);
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
      // By the index FIELD, never list position: object-backed sheets are
      // absent from the list while indices stay true (see SheetTabs.sheetAt).
      const activeSheet = result.sheets.find((s) => s.index === result.activeIndex);
      const activeName = activeSheet?.name ?? "";

      dispatch(
        setActiveSheet(
          result.activeIndex,
          activeName,
          activeSheet?.kind === "canvas" ? "canvas" : "grid",
        ),
      );
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
      // The sheet is found by NAME and addressed by its TRUE index (the list
      // omits object-backed sheets, so a list position is not an index), and a
      // CANVAS is refused before anything moves: selecting on it is a no-op
      // and scrolling to a cell would scroll the page out of view.
      const { sheets } = await getSheets();
      const target = address.sheetName
        ? sheets.find((s) => s.name.toLowerCase() === address.sheetName!.toLowerCase())
        : sheets.find((s) => s.index === state.sheetContext.activeSheetIndex);
      if (address.sheetName && !target) {
        return `There is no sheet named "${address.sheetName}" in this workbook.`;
      }
      if (target?.kind === "canvas") {
        return `"${target.name}" is a canvas: a canvas sheet holds objects, not cells, so there is no cell to go to.`;
      }
      if (target && target.index !== state.sheetContext.activeSheetIndex) {
        await switchToSheet(target.index);
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

      {
        const { sheets } = await getSheets();
        const target = sheets.find((s) => s.index === coords.sheetIndex);
        if (!target) {
          return `"${nr.name}" refers to a sheet that is no longer in this workbook.`;
        }
        if (target.kind === "canvas") {
          return `"${nr.name}" refers to "${target.name}", which is a canvas: a canvas sheet holds objects, not cells, so there is no cell to go to.`;
        }
        if (coords.sheetIndex !== state.sheetContext.activeSheetIndex) {
          await switchToSheet(coords.sheetIndex);
        }
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
      {
        const { sheets } = await getSheets();
        const target = sheets.find((s) => s.index === coords.sheetIndex);
        if (!target) {
          return `"${reference}" refers to a sheet that is no longer in this workbook.`;
        }
        if (target.kind === "canvas") {
          return `"${reference}" refers to "${target.name}", which is a canvas: a canvas sheet holds objects, not cells, so there is no cell to go to.`;
        }
        if (coords.sheetIndex !== state.sheetContext.activeSheetIndex) {
          await switchToSheet(coords.sheetIndex);
        }
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

  /**
   * Branch 0 of EVERY navigation this box makes -- a typed entry and a pick
   * from the name list alike: ask the extension that owns external addresses
   * first. "none": nobody claimed the text, the box goes on with its own
   * branches. "done": the owner selected its cells. "refused": the owner said
   * why not, and the box has shown it.
   *
   * One helper for both doors ON PURPOSE. The owner is also where the box's
   * refusal during an edit lives: while a floating grid's formula picks a
   * reference (or is parked on another sheet) the floating-range resolver
   * claims EVERY entry and refuses it ("Finish the formula ... first"), because
   * navigating would end that edit through `sheet:beforeSwitch`, which cannot
   * return to the edit's sheet -- the half-typed formula was stored as text.
   * The list pick skipped this branch, so picking a defined name on another
   * sheet did exactly that.
   */
  const goToExternalAddress = useCallback(
    async (text: string): Promise<"none" | "done" | "refused"> => {
      const external = resolveExternalAddress(text);
      if (!external) return "none";
      // On another sheet the box switches there first with its own
      // `switchToSheet` (a canvas host included).
      if (external.hostSheetIndex !== state.sheetContext.activeSheetIndex) {
        await switchToSheet(external.hostSheetIndex);
      }
      const problem = await external.go();
      if (problem) {
        reportProblem(problem);
        return "refused";
      }
      return "done";
    },
    [reportProblem, switchToSheet, state.sheetContext.activeSheetIndex],
  );

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

        // 0. An EXTERNAL address ("Float1!B2"): a floating grid's cell, claimed
        //    by the extension that owns it. First, because it has the SHAPE of
        //    a sheet-qualified address and branch 1 would refuse it with "There
        //    is no sheet named Float1" -- the text this box itself displays for
        //    a selected floating-grid cell. (See goToExternalAddress: the
        //    list pick asks the same question.)
        const external = await goToExternalAddress(value);
        if (external === "refused") return;
        if (external === "done") {
          finishEditing();
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
        //
        //    NOT while the box shows an EXTERNAL cell: "the current selection"
        //    would be Core's, which on a worksheet is a cell hidden under the
        //    floating grid the user is looking at -- a silent definition over
        //    the wrong cells. Refused out loud until a name can refer to a
        //    floating-grid cell from here.
        if (isValidName(value) && shownExternal !== null) {
          reportProblem(
            `"${value}" was not defined: a name cannot yet be defined over a floating-grid cell ` +
              "from the Name Box (it would have been defined over a worksheet cell you are not looking at).",
          );
          return;
        }
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
      goToExternalAddress,
      goToAddress,
      goToNamedRange,
      goToStructuredReference,
      finishEditing,
      reportProblem,
      state.selection,
      state.sheetContext,
      switchToSheet,
      shownExternal,
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
      // Branch 0 first, exactly as for a typed entry: while a floating grid's
      // formula picks a reference (or is parked), its owner refuses every
      // navigation -- a list pick included.
      if ((await goToExternalAddress(nr.name)) !== "none") return;
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
    [dropdownTableNames, goToExternalAddress, goToNamedRange, goToStructuredReference, reportProblem]
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
