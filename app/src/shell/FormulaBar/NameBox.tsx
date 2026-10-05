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

import React, { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } from "react";
import {
  useGridContext,
  columnToLetter,
  getNamedRangeForSelection,
  getAllNamedRanges,
  createNamedRange,
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
  quoteSheetNameForFormula,
} from "../../api/externalEdit";
import type { NamedRange } from "../../api";
// The selection-owner seam (BUG-0270 review): a selected OBJECT holds the
// selection, and a new name must not be defined over the cell behind it.
import { selectionRefusalFor } from "../../api/selectionOwner";
import {
  getAllTables,
  getTableAtCell,
  resolveStructuredReference,
} from "../../api/backend";
// NOT Core's cell-edit flag (`setGlobalIsEditing`): this box is a text field,
// and the flag means "Core's own cell edit is open". Raised here it had no
// edit behind it, and an unmount while focused left it up for good (E12).
import { isAddressLike } from "./NameBox.address";
// Every navigation -- typed, picked from the list -- through the navigator the
// Go To dialog also runs (NameBox.navigate.ts).
import { createReferenceNavigator } from "./NameBox.navigate";
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
 * Example: "=Sheet1!$A$1:$B$10", "='My Sheet'!$A$1".
 *
 * The sheet is spelled by the formula PARSER's rule (quoteSheetNameForFormula,
 * W13): it was written with no quoting at all, so a name defined on "My Sheet"
 * referred to `=My Sheet!$A$1` -- text the parser rejects, and the name
 * evaluated to an error.
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
  const sheet = quoteSheetNameForFormula(sheetName);

  if (minRow === maxRow && minCol === maxCol) {
    return `=${sheet}!${startRef}`;
  }
  return `=${sheet}!${startRef}:${endRef}`;
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
    setShowDropdown(false);
    setTimeout(() => {
      inputRef.current?.select();
    }, 0);
  }, []);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    setInputValue(displayValue);
  }, [displayValue]);

  /**
   * Every navigation this box makes goes through the ONE navigator Excel's Go
   * To dialog (F5 / Ctrl+G) also runs -- NameBox.navigate.ts, handed to
   * extensions through @api/referenceNavigation -- so the box and the dialog
   * cannot disagree about what a reference, a name or a table means. Rebuilt
   * when the active sheet changes, as the callbacks it replaced were.
   */
  const navigator = useMemo(
    () =>
      createReferenceNavigator({
        dispatch,
        activeSheetIndex: () => state.sheetContext.activeSheetIndex,
      }),
    [dispatch, state.sheetContext.activeSheetIndex],
  );

  /** Leave edit mode after an entry that was honoured. */
  const finishEditing = useCallback(() => {
    setIsEditing(false);
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

        // 0-4. An EXTERNAL address (a floating grid's cell, asked first: it
        //      has the shape of a sheet-qualified address), an ADDRESS or
        //      range on this sheet or another, a STRUCTURED reference, a DEFINED
        //      NAME, a TABLE name -- in that order, by the navigator Go To also
        //      runs (NameBox.navigate.ts, where each branch is explained).
        const outcome = await navigator.navigate(value);
        if (outcome.kind === "problem") {
          reportProblem(outcome.message);
          return;
        }
        if (outcome.kind === "done") {
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
        //    NOR while an OBJECT holds the selection (a slicer, a chart, a
        //    shape, a floating grid selected whole -- @api/selectionOwner):
        //    "the current selection" is then the active cell hidden behind the
        //    object (BUG-0270 review). The owner's own sentence; navigating to
        //    an address or a name above stays allowed -- it is the way back to
        //    the cells, not a write.
        if (isValidName(value)) {
          const refusal = selectionRefusalFor("Define Name");
          if (refusal !== null) {
            reportProblem(refusal);
            return;
          }
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
        setInputValue(displayValue);
        inputRef.current?.blur();
      }
    },
    [
      inputValue,
      displayValue,
      navigator,
      finishEditing,
      reportProblem,
      state.selection,
      state.sheetContext,
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
      const external = await navigator.goToExternalAddress(nr.name);
      if (external.kind === "refused") {
        reportProblem(external.message);
        return;
      }
      if (external.kind === "done") return;
      // A table row goes through the table route: `resolve_named_range_coords`
      // knows nothing about tables and would refuse it, which would read as the
      // list offering something it cannot open.
      if (dropdownTableNames.has(nr.name)) {
        const tableProblem = await navigator.goToStructuredReference(`${nr.name}[#Data]`);
        if (tableProblem) reportProblem(tableProblem);
        return;
      }
      // Same resolution as typing the name: the backend knows which SHEET the
      // name lives on. The regex this replaced ignored the sheet prefix, so
      // picking a name defined on another sheet selected those coordinates on
      // the sheet you were already looking at.
      const problem = await navigator.goToNamedRange(nr);
      if (problem) reportProblem(problem);
    },
    [dropdownTableNames, navigator, reportProblem]
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
