//! FILENAME: app/src/core/components/Spreadsheet/sheetSwitchListeners.ts
// PURPOSE: What Core does on the three window events every sheet switch fires
//          -- `sheet:beforeSwitch`, `sheet:normalSwitch`, `sheet:reorder` --
//          extracted from Spreadsheet.tsx so the rules are exercised by tests
//          through the SAME code the grid runs:
//            - the per-sheet VIEW MEMORY (each sheet's selection and scroll,
//              kept by TRUE index): saved for the sheet being left, restored
//              for the sheet arrived at, re-keyed on every renumbering;
//            - the SHEET GROUP (core/state/sheetGrouping.ts): ended by an
//              ordinary switch to a sheet outside it, re-keyed on every
//              renumbering;
//            - the grid's keyboard focus after a switch, unless the switch
//              said to keep it where it is (`keepFocus`, the command line).
// CONTEXT: Spreadsheet.tsx installs these from one effect
//          (`listenForSheetSwitches`), supplying how a view is captured and
//          shown. Formula point mode never fires `sheet:normalSwitch` (it fires
//          `sheet:formulaModeSwitch`), so nothing here touches a point-mode
//          visit: the edit's view, its group and its focus stay as they are.

import { renumberedSheetIndex } from "../../state/sheetRenumbering";
import { endSheetGroupUnlessMember, renumberSheetGroup } from "../../state/sheetGrouping";

/**
 * Each sheet's remembered view, by TRUE index, plus the index of the sheet on
 * screen -- where the next `leave` saves. Both follow every renumbering
 * (`renumber`), so a view is never restored onto another sheet:
 *   - a REMOVAL drops the removed sheet's view (it is never parked where a
 *     later insertion could hand it to a new sheet -- review rev3C#5);
 *   - an INSERTION leaves the new sheet's index empty (it opens at A1);
 *   - a MOVE rotates.
 */
export class SheetViewMemory<T> {
  private views = new Map<number, T>();
  private shownIndex: number | null = null;

  /** The sheet on screen when the grid mounts (Core's sheet context). */
  showing(index: number): void {
    this.shownIndex = index;
  }

  /** The TRUE index of the sheet on screen as this memory knows it; null after it was removed. */
  get shown(): number | null {
    return this.shownIndex;
  }

  /** The sheet on screen is being left: keep `view` under its index. */
  leave(view: T): void {
    if (this.shownIndex !== null) this.views.set(this.shownIndex, view);
  }

  /** Sheet `index` is now on screen: its remembered view, if it has one. */
  arrive(index: number): T | undefined {
    this.shownIndex = index;
    return this.views.get(index);
  }

  /** The view remembered for `index` (no switch implied). */
  recall(index: number): T | undefined {
    return this.views.get(index);
  }

  /** `sheet:reorder { fromIndex, toIndex }`: re-key every view, and the sheet on screen. */
  renumber(fromIndex: number, toIndex: number): void {
    const next = new Map<number, T>();
    for (const [index, view] of this.views) {
      const moved = renumberedSheetIndex(index, fromIndex, toIndex);
      if (moved !== null) next.set(moved, view);
    }
    this.views = next;
    if (this.shownIndex !== null) this.shownIndex = renumberedSheetIndex(this.shownIndex, fromIndex, toIndex);
  }
}

/** `sheet:normalSwitch`'s detail. `keepFocus`: leave the keyboard focus where it is. */
export interface NormalSwitchDetail {
  newSheetIndex: number;
  newSheetName: string;
  keepFocus?: boolean;
}

/** What the grid supplies: how its view is read and shown, and how it takes focus. */
export interface SheetSwitchHost<T> {
  /** The view on screen now -- what a sheet being left keeps. */
  captureView(): T;
  /** A switch landed on `index`: show `view`, or the default (A1) when the sheet has none. */
  showView(index: number, view: T | undefined): void;
  /** Give the grid keyboard focus, so typing works at once after a tab click. */
  focusGrid(): void;
}

/**
 * Install the three listeners on `target` (the window); returns their removal.
 *
 * ON `sheet:normalSwitch` THE SHEET GROUP ENDS when the sheet arrived at is
 * not one of it (review revG#4, BUG-0350). Excel keeps the active sheet one of
 * the selected sheets: Application.Goto Sheet2!A1 or Sheet2.Activate with
 * Sheet1 and Sheet3 grouped leaves ONE selected sheet, and Goto Sheet3!B2, a
 * member, keeps the group [LIVE, Excel 16]. The Name Box, Go To, a link, the
 * command line, a script and an undo that lands elsewhere all reach a sheet
 * through this one event, so the rule needs no copy per route. A tab click
 * clears the group itself first (SheetTabs); point mode never fires this event.
 */
export function listenForSheetSwitches<T>(
  memory: SheetViewMemory<T>,
  host: SheetSwitchHost<T>,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const onBeforeSwitch = (): void => {
    memory.leave(host.captureView());
  };
  const onNormalSwitch = (event: Event): void => {
    const detail = (event as CustomEvent<NormalSwitchDetail>).detail;
    const index = detail.newSheetIndex;
    endSheetGroupUnlessMember(index);
    host.showView(index, memory.arrive(index));
    if (detail.keepFocus !== true) host.focusGrid();
  };
  const onReorder = (event: Event): void => {
    const { fromIndex, toIndex } = (event as CustomEvent<{ fromIndex: number; toIndex: number }>).detail;
    memory.renumber(fromIndex, toIndex);
    renumberSheetGroup(fromIndex, toIndex);
  };
  target.addEventListener("sheet:beforeSwitch", onBeforeSwitch);
  target.addEventListener("sheet:normalSwitch", onNormalSwitch);
  target.addEventListener("sheet:reorder", onReorder);
  return () => {
    target.removeEventListener("sheet:beforeSwitch", onBeforeSwitch);
    target.removeEventListener("sheet:normalSwitch", onNormalSwitch);
    target.removeEventListener("sheet:reorder", onReorder);
  };
}
