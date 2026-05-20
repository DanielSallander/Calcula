/**
 * Grid interaction helpers for Calcula E2E tests.
 *
 * The spreadsheet grid is rendered on an HTML5 Canvas, so standard DOM
 * selectors cannot target individual cells. Instead we calculate pixel
 * coordinates from grid geometry and simulate mouse/keyboard events.
 *
 * Default grid dimensions (from core/types/types.ts):
 *   rowHeaderWidth  = 50 px
 *   colHeaderHeight = 24 px
 *   defaultCellWidth  = 100 px
 *   defaultCellHeight = 24 px
 */
import { type Page, type Locator, expect } from "@playwright/test";

// ---- Grid geometry constants (must match core/types/types.ts defaults) ----
const ROW_HEADER_WIDTH = 50;
const COL_HEADER_HEIGHT = 24;
const DEFAULT_CELL_WIDTH = 100;
const DEFAULT_CELL_HEIGHT = 24;

// ---- Selectors ----
const SEL_CANVAS = "canvas";
const SEL_FORMULA_BAR = 'input[data-formula-bar="true"]';
const SEL_NAME_BOX = 'input[aria-label="Name Box"]';
const SEL_SPREADSHEET = '[data-focus-container="spreadsheet"]';

/**
 * Convert a column letter (A, B, ..., Z, AA, AB, ...) to a 0-based index.
 */
function colLetterToIndex(letters: string): number {
  let idx = 0;
  for (const ch of letters.toUpperCase()) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  return idx - 1; // 0-based
}

/**
 * Parse a cell reference like "A1", "B2", "AA10" into { row, col } (0-based).
 */
function parseCellRef(ref: string): { row: number; col: number } {
  const match = ref.match(/^([A-Za-z]+)(\d+)$/);
  if (!match) throw new Error(`Invalid cell reference: ${ref}`);
  return {
    col: colLetterToIndex(match[1]),
    row: Number(match[2]) - 1, // 1-based in UI, 0-based internally
  };
}

export class GridHelper {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // -------------------------------------------------------------------
  // Locators
  // -------------------------------------------------------------------

  get canvas(): Locator {
    return this.page.locator(SEL_CANVAS).first();
  }

  get formulaBar(): Locator {
    return this.page.locator(SEL_FORMULA_BAR);
  }

  get nameBox(): Locator {
    return this.page.locator(SEL_NAME_BOX);
  }

  get spreadsheet(): Locator {
    return this.page.locator(SEL_SPREADSHEET);
  }

  // -------------------------------------------------------------------
  // Coordinate helpers
  // -------------------------------------------------------------------

  /**
   * Returns the centre pixel of the given cell relative to the canvas element.
   * Does NOT account for scroll offset or custom column/row sizes — fine for
   * cells visible in the initial viewport.
   */
  cellCenter(ref: string): { x: number; y: number } {
    const { row, col } = parseCellRef(ref);
    return {
      x: ROW_HEADER_WIDTH + col * DEFAULT_CELL_WIDTH + DEFAULT_CELL_WIDTH / 2,
      y: COL_HEADER_HEIGHT + row * DEFAULT_CELL_HEIGHT + DEFAULT_CELL_HEIGHT / 2,
    };
  }

  // -------------------------------------------------------------------
  // High-level actions
  // -------------------------------------------------------------------

  /** Single-click a cell to select it. */
  async clickCell(ref: string) {
    const { x, y } = this.cellCenter(ref);
    await this.canvas.click({ position: { x, y }, force: true });
    // Brief wait for selection to register
    await this.page.waitForTimeout(100);
  }

  /** Double-click a cell to enter edit mode. */
  async doubleClickCell(ref: string) {
    const { x, y } = this.cellCenter(ref);
    await this.canvas.dblclick({ position: { x, y }, force: true });
    await this.page.waitForTimeout(200);
  }

  /**
   * Type a value into the currently selected cell and press Enter.
   * Starts from a "selected but not editing" state — the first keystroke
   * activates the inline editor.
   */
  async typeIntoCell(value: string) {
    await this.page.keyboard.type(value, { delay: 30 });
    await this.page.keyboard.press("Enter");
    // Wait for the commit round-trip to Rust and re-render.
    await this.page.waitForTimeout(300);
  }

  /**
   * Click a cell, type a value, and press Enter.
   * Convenience wrapper combining clickCell + typeIntoCell.
   */
  async setCellValue(ref: string, value: string) {
    await this.clickCell(ref);
    await this.typeIntoCell(value);
  }

  /**
   * Navigate to a cell via the Name Box (type the ref + Enter).
   * More reliable than clicking for cells that may be off-screen.
   * After navigation, explicitly focuses the spreadsheet container so
   * subsequent keyboard events (arrows, Ctrl+Z, etc.) reach the grid.
   */
  async navigateTo(ref: string) {
    await this.nameBox.click();
    await this.nameBox.fill(ref.toUpperCase());
    await this.page.keyboard.press("Enter");
    await this.page.waitForTimeout(200);
    // Move focus from the name box input to the spreadsheet container,
    // which has tabIndex={0} and onKeyDown for all grid keyboard handling.
    await this.spreadsheet.focus();
    await this.page.waitForTimeout(100);
  }

  // -------------------------------------------------------------------
  // Reading state
  // -------------------------------------------------------------------

  /** Read the text currently shown in the formula bar. */
  async getFormulaBarValue(): Promise<string> {
    return await this.formulaBar.inputValue();
  }

  /** Read the text currently shown in the name box. */
  async getNameBoxValue(): Promise<string> {
    return await this.nameBox.inputValue();
  }

  /**
   * Select a cell and return the formula bar contents.
   * This is the primary way to "read" a cell value in E2E tests since
   * the canvas pixels are not easily inspectable.
   */
  async getCellFormulaBarText(ref: string): Promise<string> {
    await this.clickCell(ref);
    // Small wait for the formula bar to update
    await this.page.waitForTimeout(150);
    return await this.getFormulaBarValue();
  }

  /**
   * Enter edit mode on a cell (double-click or F2) and return
   * the editing value shown in the inline editor / formula bar.
   */
  async getEditingValue(ref: string): Promise<string> {
    await this.clickCell(ref);
    await this.page.keyboard.press("F2");
    await this.page.waitForTimeout(200);
    const value = await this.getFormulaBarValue();
    await this.page.keyboard.press("Escape");
    await this.page.waitForTimeout(100);
    return value;
  }

  // -------------------------------------------------------------------
  // Assertions
  // -------------------------------------------------------------------

  /**
   * Assert that the formula bar shows the expected text when a cell is
   * selected (not in edit mode).
   */
  async expectFormulaBar(ref: string, expected: string) {
    const actual = await this.getCellFormulaBarText(ref);
    expect(actual).toBe(expected);
  }

  /**
   * Assert the formula bar starts with the expected prefix when the
   * cell is selected. Useful for verifying "=" prefix on formulas.
   */
  async expectFormulaBarStartsWith(ref: string, prefix: string) {
    const actual = await this.getCellFormulaBarText(ref);
    expect(actual.startsWith(prefix)).toBe(true);
  }

  // -------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------

  async undo() {
    // The keyboard handler is gated on isFocused, which React updates via
    // onFocus/onBlur. After the inline editor closes, focus may go to body,
    // making isFocused=false. We need to focus the container and wait for
    // React to re-render and re-attach the useEffect keyboard listener.
    await this.spreadsheet.focus();
    await this.page.waitForTimeout(500);
    await this.page.keyboard.press("Control+z");
    await this.page.waitForTimeout(500);
  }

  async redo() {
    await this.spreadsheet.focus();
    await this.page.waitForTimeout(500);
    await this.page.keyboard.press("Control+y");
    await this.page.waitForTimeout(500);
  }

  async copy() {
    await this.page.keyboard.press("Control+c");
    await this.page.waitForTimeout(100);
  }

  async paste() {
    await this.page.keyboard.press("Control+v");
    await this.page.waitForTimeout(300);
  }

  async cut() {
    await this.page.keyboard.press("Control+x");
    await this.page.waitForTimeout(100);
  }

  async delete() {
    await this.page.keyboard.press("Delete");
    await this.page.waitForTimeout(200);
  }

  // -------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------

  /** Select a range by clicking the start cell and shift-clicking the end. */
  async selectRange(startRef: string, endRef: string) {
    await this.clickCell(startRef);
    const { x, y } = this.cellCenter(endRef);
    await this.canvas.click({
      position: { x, y },
      modifiers: ["Shift"],
    });
    await this.page.waitForTimeout(100);
  }
}
