//! FILENAME: app/src/api/objectModel.ts
// PURPOSE: The Workbook/Sheet levels of Calcula's canonical shared object model
//          (Workbook -> Sheet -> Range -> Cell). The first increment of C3 — the
//          unification of the three script runtimes around one object model.
// CONTEXT: `CellRange` (api/range.ts) is already the Range/Cell. This adds the
//          navigation levels above it for the EXTENSION runtime. The full plan
//          (object scripts + Rust QuickJS notebooks binding the same model, one
//          shared .d.ts) is in docs/design/c3-shared-object-model.md.

import { CellRange } from "./range";
import { getSheets, setActiveSheet } from "./lib";

export type SheetVisibility = "visible" | "hidden" | "veryHidden";

/**
 * A worksheet — the navigation level above a Range. Part of the canonical shared
 * object model. Construct via the `workbook` facade, not directly.
 */
export class Sheet {
  constructor(
    public readonly index: number,
    public readonly name: string,
    public readonly visibility: SheetVisibility = "visible",
    public readonly tabColor?: string,
  ) {}

  /**
   * A range on this sheet by A1 address ("A1", "A1:B5").
   *
   * The returned CellRange is BOUND to this sheet (C3 step 2): its data ops
   * (getValue/getValues/setValue/setValues) read/write THIS sheet whether or not
   * it is the active one — no `activate()` needed first. (Formatting ops still
   * target the active sheet; see range.ts.)
   */
  range(address: string): CellRange {
    return CellRange.fromAddress(address, this.index);
  }

  /** A single cell on this sheet (0-based), bound to this sheet (see range()). */
  cell(row: number, col: number): CellRange {
    return CellRange.fromCell(row, col, this.index);
  }

  /** Make this the active sheet. */
  async activate(): Promise<void> {
    await setActiveSheet(this.index);
  }
}

/**
 * The workbook — the top of the canonical object model. Lets extensions navigate
 * Workbook → Sheet → Range → Cell instead of juggling sheet indices and free
 * functions.
 */
export class Workbook {
  /** All sheets, in tab order. */
  async sheets(): Promise<Sheet[]> {
    const r = await getSheets();
    return r.sheets.map((s) => new Sheet(s.index, s.name, s.visibility, s.tabColor));
  }

  /** The active sheet. */
  async activeSheet(): Promise<Sheet> {
    const r = await getSheets();
    const info = r.sheets.find((s) => s.index === r.activeIndex) ?? r.sheets[0];
    return new Sheet(info.index, info.name, info.visibility, info.tabColor);
  }

  /** A sheet by name (exact match) or 0-based index; `null` if not found. */
  async sheet(nameOrIndex: string | number): Promise<Sheet | null> {
    const r = await getSheets();
    const info =
      typeof nameOrIndex === "number"
        ? r.sheets.find((s) => s.index === nameOrIndex)
        : r.sheets.find((s) => s.name === nameOrIndex);
    return info ? new Sheet(info.index, info.name, info.visibility, info.tabColor) : null;
  }
}

/** The active workbook — a convenience singleton for extension authors. */
export const workbook = new Workbook();
