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

  /**
   * Returns the cell centre in viewport-relative pixels, accounting for the
   * current grid scroll offset.  Falls back to the no-scroll calculation if
   * the global state is unavailable.
   */
  async cellCenterScrollAware(ref: string): Promise<{ x: number; y: number }> {
    const { row, col } = parseCellRef(ref);
    const scroll = await this.page.evaluate(() => {
      const gs = (window as any).__CALCULA_GRID_STATE__;
      return { scrollX: gs?.viewport?.scrollX ?? 0, scrollY: gs?.viewport?.scrollY ?? 0 };
    });
    return {
      x: ROW_HEADER_WIDTH + col * DEFAULT_CELL_WIDTH + DEFAULT_CELL_WIDTH / 2 - scroll.scrollX,
      y: COL_HEADER_HEIGHT + row * DEFAULT_CELL_HEIGHT + DEFAULT_CELL_HEIGHT / 2 - scroll.scrollY,
    };
  }

  // -------------------------------------------------------------------
  // High-level actions
  // -------------------------------------------------------------------

  /** Single-click a cell to select it. Scrolls to the cell first if off-screen. */
  async clickCell(ref: string) {
    // Get scroll-aware position
    let { x, y } = await this.cellCenterScrollAware(ref);
    const canvasBox = await this.canvas.boundingBox();

    // If the cell is off-screen, scroll to it via Name Box
    if (canvasBox && (y < COL_HEADER_HEIGHT || y > canvasBox.height - DEFAULT_CELL_HEIGHT
                   || x < ROW_HEADER_WIDTH || x > canvasBox.width - DEFAULT_CELL_WIDTH)) {
      await this.navigateTo(ref);
      // After navigating, re-read scroll offset for the correct click position
      ({ x, y } = await this.cellCenterScrollAware(ref));
    }

    await this.canvas.click({ position: { x, y }, force: true });
    // Brief wait for selection to register
    await this.page.waitForTimeout(100);
  }

  /** Double-click a cell to enter edit mode. */
  async doubleClickCell(ref: string) {
    // Ensure cell is visible first
    await this.clickCell(ref);
    const { x, y } = await this.cellCenterScrollAware(ref);
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
    await this.dispatchKeyOnGrid("z", true);
    await this.page.waitForTimeout(200);
  }

  async redo() {
    await this.dispatchKeyOnGrid("y", true);
    await this.page.waitForTimeout(200);
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
    const { x, y } = await this.cellCenterScrollAware(endRef);
    await this.canvas.click({
      position: { x, y },
      modifiers: ["Shift"],
      force: true,
    });
    await this.page.waitForTimeout(100);
  }

  // -------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------

  /**
   * Dispatch a keyboard shortcut directly on the spreadsheet container DOM
   * element. This bypasses WebView2's browser-level key interception (which
   * swallows Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+Z, etc. before they reach the app).
   */
  private async dispatchKeyOnGrid(key: string, ctrlKey = false, shiftKey = false) {
    await this.spreadsheet.focus();
    await this.page.waitForTimeout(100);
    await this.spreadsheet.evaluate(
      (el, opts) => {
        el.dispatchEvent(new KeyboardEvent("keydown", {
          key: opts.key,
          code: `Key${opts.key.toUpperCase()}`,
          ctrlKey: opts.ctrlKey,
          shiftKey: opts.shiftKey,
          bubbles: true,
          cancelable: true,
        }));
      },
      { key, ctrlKey, shiftKey }
    );
    await this.page.waitForTimeout(300);
  }

  /**
   * Toggle bold on the currently selected cell(s) via ribbon button.
   * Waits for the ribbon to sync with the current cell's style before clicking.
   */
  async toggleBold() {
    // Wait for the ribbon's async style fetch to complete so it reflects
    // the CURRENT cell's bold state, not the previous cell's.
    await this.page.waitForTimeout(500);
    await this.clickFormatButton("bold");
  }

  /** Toggle italic on the currently selected cell(s) via ribbon button. */
  async toggleItalic() {
    await this.page.waitForTimeout(500);
    await this.clickFormatButton("italic");
  }

  /** Toggle underline on the currently selected cell(s) via ribbon button. */
  async toggleUnderline() {
    await this.page.waitForTimeout(500);
    await this.clickFormatButton("underline");
  }

  /**
   * Check if a formatting toggle button is active in the ribbon.
   * Button IDs: "bold", "italic", "underline", "strikethrough",
   *             "superscript", "subscript", "alignLeft", "alignCenter",
   *             "alignRight", "wrapText"
   */
  async isFormatActive(formatId: string): Promise<boolean> {
    const btn = this.page.locator(`[data-testid="fmt-${formatId}"]`);
    const attr = await btn.getAttribute("data-active", { timeout: 3000 });
    return attr === "true";
  }

  /**
   * Read a cell's style property directly from the Tauri backend.
   * More reliable than checking ribbon button state since it bypasses
   * the async ribbon style refresh entirely.
   *
   * For boolean properties (bold, italic, strikethrough): returns true/false.
   * For string properties (underline): returns true if the value is truthy
   * and not "none".
   */
  async getCellStyleProp(ref: string, prop: string): Promise<boolean> {
    const { row, col } = parseCellRef(ref);
    const result = await this.page.evaluate(
      async ({ r, c, p }) => {
        const tauri = (window as any).__TAURI__;
        if (!tauri?.core?.invoke) throw new Error("Tauri API not available");
        const cell = await tauri.core.invoke("get_cell", { row: r, col: c });
        if (!cell) return false;
        const style = await tauri.core.invoke("get_style", { index: cell.styleIndex });
        if (!style) return false;
        const value = (style as any)[p];
        // underline is a string: "none" or "single"
        if (typeof value === "string") return value !== "none" && value !== "";
        return !!value;
      },
      { r: row, c: col, p: prop }
    );
    return result;
  }

  /**
   * Read a cell's style property as a raw string from the Tauri backend.
   * Useful for numberFormat, textColor, backgroundColor, etc.
   */
  async getCellStyleStringProp(ref: string, prop: string): Promise<string> {
    const { row, col } = parseCellRef(ref);
    return this.page.evaluate(
      async ({ r, c, p }) => {
        const tauri = (window as any).__TAURI__;
        if (!tauri?.core?.invoke) throw new Error("Tauri API not available");
        const cell = await tauri.core.invoke("get_cell", { row: r, col: c });
        if (!cell) return "";
        const style = await tauri.core.invoke("get_style", { index: cell.styleIndex });
        if (!style) return "";
        return String((style as any)[p] ?? "");
      },
      { r: row, c: col, p: prop }
    );
  }

  /**
   * Read the display value of a cell directly from the Tauri backend.
   * Returns the formatted display string (e.g., "42.00%", "$1,234").
   *
   * Note: After changing a source cell, dependent cells may have stale
   * `display` fields in the backend. Use `getCellFormulaBarText()` for
   * the most up-to-date value after edits that trigger recalculation.
   */
  async getCellDisplayValue(ref: string): Promise<string> {
    const { row, col } = parseCellRef(ref);
    return this.page.evaluate(
      async ({ r, c }) => {
        const tauri = (window as any).__TAURI__;
        if (!tauri?.core?.invoke) throw new Error("Tauri API not available");
        const cell = await tauri.core.invoke("get_cell", { row: r, col: c });
        return cell?.display ?? "";
      },
      { r: row, c: col }
    );
  }

  /**
   * Read a cell's current computed value by clicking it and reading the
   * formula bar. This always shows the latest recalculated value, even
   * for dependent cells after a source cell change. Slower but more
   * reliable than getCellDisplayValue() after recalculation.
   */
  async getCellLiveValue(ref: string): Promise<string> {
    await this.clickCell(ref);
    await this.page.waitForTimeout(200);
    return this.getFormulaBarValue();
  }

  /**
   * Set a cell value directly via the Tauri API, bypassing keyboard input.
   * This avoids locale-related input transformations (e.g., comma → dot in
   * Swedish locale). The value string is sent as-is to the backend.
   */
  async setCellValueDirect(ref: string, value: string) {
    const { row, col } = parseCellRef(ref);
    await this.page.evaluate(
      async ({ r, c, v }) => {
        const tauri = (window as any).__TAURI__;
        const result = await tauri.core.invoke("update_cell", { row: r, col: c, value: v });
        // Emit cell change events so dependent formulas and the grid refresh
        if (result?.cells) {
          for (const cell of result.cells) {
            window.dispatchEvent(new CustomEvent("cell:updated", {
              detail: { row: cell.row, col: cell.col },
            }));
          }
        }
        window.dispatchEvent(new Event("grid:refresh"));
      },
      { r: row, c: col, v: value }
    );
    await this.page.waitForTimeout(200);
  }

  /**
   * Select a cell and check if a specific format is active.
   * First tries reading the style directly via Tauri API (most reliable),
   * falls back to checking the ribbon button state.
   */
  async isCellFormatted(ref: string, formatId: string): Promise<boolean> {
    const { row, col } = parseCellRef(ref);

    // Try reading style data directly from the Tauri backend
    try {
      const result = await this.page.evaluate(
        async ({ r, c, prop }) => {
          const tauri = (window as any).__TAURI__;
          if (!tauri?.core?.invoke) return null;
          const cell = await tauri.core.invoke("get_cell", { row: r, col: c });
          if (!cell) return null;
          const style = await tauri.core.invoke("get_style", { index: cell.styleIndex });
          if (!style) return null;
          return (style as any)[prop] ?? false;
        },
        { r: row, c: col, prop: formatId }
      );
      if (result !== null) return !!result;
    } catch {
      // Tauri API not available, fall back to ribbon check
    }

    // Fallback: click cell and check ribbon button state
    await this.clickCell(ref);
    await this.page.waitForTimeout(1000);
    return this.isFormatActive(formatId);
  }

  /**
   * Click a formatting button in the ribbon by its testid.
   * After clicking, waits for the Tauri round-trip and ribbon state update.
   * Does NOT move focus back to the grid — call clickCell() if needed.
   */
  async clickFormatButton(formatId: string) {
    const btn = this.page.locator(`[data-testid="fmt-${formatId}"]`);
    await btn.click();
    // Wait for the Tauri applyFormatting round-trip and React state update
    await this.page.waitForTimeout(600);
  }

  // -------------------------------------------------------------------
  // Menu bar interaction
  // -------------------------------------------------------------------

  /**
   * Open a top-level menu by clicking its button text.
   * Menu names: "File", "Edit", "View", "Format", "Insert", "Data",
   *             "Formulas", "Review", "Developer"
   */
  async openMenu(menuName: string) {
    const menuBtn = this.page.locator("button").filter({ hasText: new RegExp(`^${menuName}$`) }).first();
    await menuBtn.click();
    await this.page.waitForTimeout(300);
  }

  /**
   * Click a menu item by its label text (partial match).
   * Menu items often include shortcut hints like "Undo Ctrl+Z",
   * so we match the start of the text.
   * Call openMenu() first, then clickMenuItem().
   */
  async clickMenuItem(itemLabel: string) {
    const item = this.page.locator("button").filter({ hasText: new RegExp(itemLabel) }).first();
    await item.click();
    await this.page.waitForTimeout(400);
  }

  /**
   * Hover a menu item (for opening submenus).
   */
  async hoverMenuItem(itemLabel: string) {
    const item = this.page.locator("button").filter({ hasText: new RegExp(itemLabel) }).first();
    await item.hover();
    await this.page.waitForTimeout(300);
  }

  /**
   * Open a menu and click an item in one step.
   * Handles the common pattern of menu → item click.
   */
  async menuAction(menuName: string, itemLabel: string) {
    await this.openMenu(menuName);
    await this.clickMenuItem(itemLabel);
  }

  /**
   * Close any open menu by pressing Escape or clicking outside.
   */
  async closeMenu() {
    await this.page.keyboard.press("Escape");
    await this.page.waitForTimeout(200);
  }

  // -------------------------------------------------------------------
  // Keyboard-driven workflows
  // -------------------------------------------------------------------

  /**
   * Press an arrow key N times. Useful for keyboard navigation tests.
   */
  async pressArrow(direction: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight", times = 1) {
    for (let i = 0; i < times; i++) {
      await this.page.keyboard.press(direction);
      await this.page.waitForTimeout(50);
    }
    await this.page.waitForTimeout(100);
  }

  /**
   * Select a range using Shift+Arrow keys from the current cell.
   * @param down Number of rows to extend down (negative for up)
   * @param right Number of columns to extend right (negative for left)
   */
  async shiftArrowSelect(down: number, right: number) {
    if (down > 0) {
      for (let i = 0; i < down; i++) {
        await this.page.keyboard.press("Shift+ArrowDown");
        await this.page.waitForTimeout(50);
      }
    } else if (down < 0) {
      for (let i = 0; i < -down; i++) {
        await this.page.keyboard.press("Shift+ArrowUp");
        await this.page.waitForTimeout(50);
      }
    }
    if (right > 0) {
      for (let i = 0; i < right; i++) {
        await this.page.keyboard.press("Shift+ArrowRight");
        await this.page.waitForTimeout(50);
      }
    } else if (right < 0) {
      for (let i = 0; i < -right; i++) {
        await this.page.keyboard.press("Shift+ArrowLeft");
        await this.page.waitForTimeout(50);
      }
    }
    await this.page.waitForTimeout(100);
  }

  /**
   * Enter a value by typing and pressing Enter, without clicking a cell first.
   * Useful for keyboard-only data entry workflows.
   */
  async typeAndEnter(value: string) {
    // Small delay before typing to ensure the grid is ready to receive input
    await this.page.waitForTimeout(100);
    await this.page.keyboard.type(value, { delay: 30 });
    await this.page.keyboard.press("Enter");
    await this.page.waitForTimeout(300);
  }

  /**
   * Enter a value by typing and pressing Tab (moves right after commit).
   */
  async typeAndTab(value: string) {
    await this.page.waitForTimeout(100);
    await this.page.keyboard.type(value, { delay: 30 });
    await this.page.keyboard.press("Tab");
    await this.page.waitForTimeout(300);
  }

  /**
   * Press F2 to enter edit mode, type a value, and press Enter.
   * Useful for editing an existing cell via keyboard.
   */
  async editCellViaF2(value: string) {
    await this.page.keyboard.press("F2");
    await this.page.waitForTimeout(200);
    // Select all existing content and replace
    await this.page.keyboard.press("Control+a");
    await this.page.waitForTimeout(50);
    await this.page.keyboard.type(value, { delay: 20 });
    await this.page.keyboard.press("Enter");
    await this.page.waitForTimeout(300);
  }

  /**
   * Scroll the grid using mouse wheel.
   * @param deltaY Positive = scroll down, negative = scroll up
   */
  async scrollWheel(deltaY: number) {
    await this.canvas.hover();
    await this.page.mouse.wheel(0, deltaY);
    await this.page.waitForTimeout(300);
  }
}
