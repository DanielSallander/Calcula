//! FILENAME: app/src/shell/FormulaBar/NameBox.navigate.ts
// PURPOSE: "Go to what this text names" -- an address, a range, a sheet-
//          qualified reference, a table reference, a defined name, a table, or
//          a floating grid's own address -- as ONE navigator that the Name Box
//          and Excel's Go To dialog (F5 / Ctrl+G, the GoToSpecial extension, via
//          @api/referenceNavigation) both run.
// CONTEXT: Home tab 2026-10-04. These branches lived inside the NameBox
//          component as useCallbacks, so the only way to navigate to a
//          reference was to type it into the Name Box -- which unmounts with the
//          formula bar -- and a Go To dialog would have had to re-implement
//          every branch (the sheet switch alone has two silent failure modes:
//          BUG-0052's stale frame, and a tab strip highlighting the sheet just
//          left). Moved here VERBATIM in behaviour; the component now calls it.
//          No React: the context hands in the grid dispatch and the active
//          sheet, so the shell can drive it with the formula bar hidden.

import {
  setSelection,
  scrollToCell,
  getMergeInfo,
  getNamedRange,
  getSheets,
  setActiveSheet,
  setActiveSheetApi,
  primeSheetSwitch,
  AppEvents,
  emitAppEvent,
} from "../../api";
import type { NamedRange } from "../../api";
import type { GridAction } from "../../api/grid";
import { resolveNamedRangeCoords } from "../../api/lib";
import type { NamedRangeCoords } from "../../api/lib";
import { getTableByName, resolveStructuredReference } from "../../api/backend";
import type { Table } from "../../api/backend";
import { resolveExternalAddress } from "../../api/externalEdit";
import {
  parseNameBoxAddress,
  hasTableBracket,
  parseStructuredReference,
  type ParsedNameBoxAddress,
} from "./NameBox.address";

/** What the navigator needs from its host. */
export interface ReferenceNavigatorContext {
  /** The grid's dispatch (the component's, or the non-React bridge's). */
  dispatch: (action: GridAction) => void;
  /** The active sheet's TRUE index, read at the moment of use. */
  activeSheetIndex: () => number;
}

/** What a navigation did. "unclaimed": no branch knew the text (the Name Box
 *  then defines a name; Go To says the reference is not valid). */
export type ReferenceNavigationOutcome =
  | { kind: "done" }
  | { kind: "problem"; message: string }
  | { kind: "unclaimed" };

export interface ReferenceNavigator {
  navigateToCell(row: number, col: number): Promise<void>;
  selectRange(range: { startRow: number; startCol: number; endRow: number; endCol: number; type?: "cells" | "rows" | "columns" }): void;
  switchToSheet(index: number): Promise<void>;
  goToAddress(address: ParsedNameBoxAddress): Promise<string | null>;
  goToNamedRange(nr: NamedRange): Promise<string | null>;
  goToStructuredReference(reference: string): Promise<string | null>;
  goToExternalAddress(text: string): Promise<{ kind: "none" } | { kind: "done" } | { kind: "refused"; message: string }>;
  /** Branches 0-4 of the Name Box's Enter, in order. */
  navigate(text: string): Promise<ReferenceNavigationOutcome>;
}

export function createReferenceNavigator(ctx: ReferenceNavigatorContext): ReferenceNavigator {
  const { dispatch } = ctx;

  const navigateToCell = async (row: number, col: number): Promise<void> => {
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
  };

  /** Select a block and bring its top-left into view. */
  const selectRange = (range: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    type?: "cells" | "rows" | "columns";
  }): void => {
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
  };

  /**
   * Switch the active sheet, the way a sheet-tab click does.
   *
   * The sequence is copied from SheetTabs' normal-mode tab click on purpose:
   * without `primeSheetSwitch` the canvas keeps painting the OLD sheet's cells
   * under the new sheet's name for a frame (BUG-0052), and without the
   * SHEET_CHANGED announcement the tab strip goes on highlighting the sheet the
   * user just left, because that is what SheetTabs reloads itself from.
   */
  const switchToSheet = async (index: number): Promise<void> => {
    window.dispatchEvent(
      new CustomEvent("sheet:beforeSwitch", {
        detail: {
          oldSheetIndex: ctx.activeSheetIndex(),
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
  };

  /**
   * Go to a parsed address. Returns null on success, or the sentence to show the
   * user — an entry that cannot be honoured must SAY so; reverting the text is
   * indistinguishable from the app having ignored the keypress.
   */
  const goToAddress = async (address: ParsedNameBoxAddress): Promise<string | null> => {
    // The sheet is found by NAME and addressed by its TRUE index (the list
    // omits object-backed sheets, so a list position is not an index), and a
    // CANVAS is refused before anything moves: selecting on it is a no-op
    // and scrolling to a cell would scroll the page out of view.
    const activeIndex = ctx.activeSheetIndex();
    const { sheets } = await getSheets();
    const target = address.sheetName
      ? sheets.find((s) => s.name.toLowerCase() === address.sheetName!.toLowerCase())
      : sheets.find((s) => s.index === activeIndex);
    if (address.sheetName && !target) {
      return `There is no sheet named "${address.sheetName}" in this workbook.`;
    }
    if (target?.kind === "canvas") {
      return `"${target.name}" is a canvas: a canvas sheet holds objects, not cells, so there is no cell to go to.`;
    }
    if (target && target.index !== activeIndex) {
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
  };

  /**
   * Go to a defined name. Returns null on success, or the sentence to show.
   *
   * Resolution is the BACKEND's (`resolve_named_range_coords`), not a regex over
   * `refersTo` as it used to be here and in the dropdown. That regex dropped the
   * sheet prefix, so a workbook-scoped name pointing at Sheet3 selected those
   * coordinates on whatever sheet was active — a silent wrong answer — and when
   * it simply did not match it closed the box having done nothing at all.
   */
  const goToNamedRange = async (nr: NamedRange): Promise<string | null> => {
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
      if (coords.sheetIndex !== ctx.activeSheetIndex()) {
        await switchToSheet(coords.sheetIndex);
      }
    }

    selectRange(coords);
    return null;
  };

  /**
   * Go to a structured (table) reference. Returns null on success, or the
   * sentence to show.
   *
   * Resolution is the BACKEND's `resolve_structured_reference`, for the same
   * reason a defined name is: it knows which SHEET the table lives on, and it
   * owns where a table's data starts and stops. The navigator hands it the text
   * and reads back coordinates.
   */
  const goToStructuredReference = async (reference: string): Promise<string | null> => {
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
      if (coords.sheetIndex !== ctx.activeSheetIndex()) {
        await switchToSheet(coords.sheetIndex);
      }
    }

    selectRange(coords);
    return null;
  };

  /**
   * Branch 0 of EVERY navigation -- a typed entry and a pick from a name list
   * alike: ask the extension that owns external addresses first. "none":
   * nobody claimed the text. "done": the owner selected its cells. "refused":
   * the owner said why not.
   *
   * The owner is also where the refusal during an edit lives: while a floating
   * grid's formula picks a reference (or is parked on another sheet) the
   * floating-range resolver claims EVERY entry and refuses it ("Finish the
   * formula ... first"), because navigating would end that edit through
   * `sheet:beforeSwitch`, which cannot return to the edit's sheet -- the
   * half-typed formula was stored as text.
   */
  const goToExternalAddress = async (
    text: string,
  ): Promise<{ kind: "none" } | { kind: "done" } | { kind: "refused"; message: string }> => {
    const external = resolveExternalAddress(text);
    if (!external) return { kind: "none" };
    // On another sheet the navigator switches there first with its own
    // `switchToSheet` (a canvas host included).
    if (external.hostSheetIndex !== ctx.activeSheetIndex()) {
      await switchToSheet(external.hostSheetIndex);
    }
    const problem = await external.go();
    if (problem) return { kind: "refused", message: problem };
    return { kind: "done" };
  };

  const navigate = async (value: string): Promise<ReferenceNavigationOutcome> => {
    const done = (problem: string | null): ReferenceNavigationOutcome =>
      problem ? { kind: "problem", message: problem } : { kind: "done" };

    // 0. An EXTERNAL address ("Float1!B2"): a floating grid's cell, claimed
    //    by the extension that owns it. First, because it has the SHAPE of
    //    a sheet-qualified address and branch 1 would refuse it with "There
    //    is no sheet named Float1" -- the text the Name Box itself displays
    //    for a selected floating-grid cell.
    const external = await goToExternalAddress(value);
    if (external.kind === "refused") return { kind: "problem", message: external.message };
    if (external.kind === "done") return { kind: "done" };

    // 1. An ADDRESS: cell or range, relative or absolute, this sheet or
    //    another. `parseNameBoxAddress` returns null both for "not an
    //    address" and for a malformed one, which is deliberate — a
    //    malformed address is indistinguishable from a name until the name
    //    lookup below has also missed.
    const address = parseNameBoxAddress(value);
    if (address) return done(await goToAddress(address));

    // 2. A STRUCTURED REFERENCE: Sales[Margin], Sales[#All], Sales[#Totals].
    //    Decided by the BRACKET, before the name branches, because '[' is
    //    neither an address character nor a name character.
    if (hasTableBracket(value)) {
      if (!parseStructuredReference(value)) {
        return {
          kind: "problem",
          message:
            `"${value}" is not a table reference this box can read. ` +
            "Type a table name (Sales), a column (Sales[Margin]) or a part " +
            "of it (Sales[#All], Sales[#Headers], Sales[#Totals]).",
        };
      }
      return done(await goToStructuredReference(value));
    }

    // 3. An existing DEFINED NAME.
    let existing: NamedRange | null = null;
    try {
      existing = await getNamedRange(value);
    } catch (error) {
      console.error("[NameBox] Failed to look up name:", error);
    }
    if (existing) return done(await goToNamedRange(existing));

    // 4. A TABLE NAME. Tables and defined names share one namespace — the
    //    backend refuses a name that would shadow a table — so this cannot
    //    be reached by anything branch 3 could have answered. A bare table
    //    name means the table's DATA, which is what Excel selects.
    //
    //    The lookup is by NAME rather than by trying `[#Data]` and reading
    //    the error text: a failure here must fall through to the caller's
    //    own branch, and telling "no such table" from "that table cannot
    //    answer" by string-matching a backend message is the kind of test
    //    that passes until someone rewords the message.
    let table: Table | null = null;
    try {
      table = await getTableByName(value);
    } catch (error) {
      console.error("[NameBox] Failed to look up table:", error);
    }
    if (table) return done(await goToStructuredReference(`${table.name}[#Data]`));

    return { kind: "unclaimed" };
  };

  return {
    navigateToCell,
    selectRange,
    switchToSheet,
    goToAddress,
    goToNamedRange,
    goToStructuredReference,
    goToExternalAddress,
    navigate,
  };
}
