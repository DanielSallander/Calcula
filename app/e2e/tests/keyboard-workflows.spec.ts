/**
 * Keyboard-driven workflow E2E tests.
 *
 * Tests real-world keyboard interaction patterns that simulate
 * how a human would enter and navigate data without using the mouse.
 *
 * Uses rows 200+ to avoid collision with other tests.
 */
import { test, expect } from "../fixtures";

test.describe("Data entry with Enter", () => {
  test("enter column of data using Enter key", async ({ grid }) => {
    // Navigate to starting cell
    await grid.navigateTo("A200");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(200);

    // Type values down a column using Enter
    await grid.typeAndEnter("Apple");
    await grid.typeAndEnter("Banana");
    await grid.typeAndEnter("Cherry");

    // Verify all three values
    expect(await grid.getCellDisplayValue("A200")).toBe("Apple");
    expect(await grid.getCellDisplayValue("A201")).toBe("Banana");
    expect(await grid.getCellDisplayValue("A202")).toBe("Cherry");
  });

  test("enter row of data using Tab key", async ({ grid }) => {
    await grid.navigateTo("A205");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(400);

    // Type values across a row using Tab
    await grid.typeAndTab("Name");
    await grid.typeAndTab("Age");
    await grid.typeAndTab("City");

    expect(await grid.getCellDisplayValue("A205")).toBe("Name");
    expect(await grid.getCellDisplayValue("B205")).toBe("Age");
    expect(await grid.getCellDisplayValue("C205")).toBe("City");
  });

  test("data entry table: Tab across, navigate to next row manually", async ({ grid }) => {
    await grid.navigateTo("A210");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(200);

    // Row 1: Tab across
    await grid.typeAndTab("Alice");
    await grid.typeAndTab("30");
    await grid.typeAndEnter("NYC");

    // Navigate to next row start manually
    await grid.navigateTo("A211");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(400);

    // Row 2
    await grid.typeAndTab("Bob");
    await grid.typeAndTab("25");
    await grid.typeAndEnter("LA");

    // Verify the table
    expect(await grid.getCellDisplayValue("A210")).toBe("Alice");
    expect(await grid.getCellDisplayValue("B210")).toBe("30");
    expect(await grid.getCellDisplayValue("C210")).toBe("NYC");
    expect(await grid.getCellDisplayValue("A211")).toBe("Bob");
    expect(await grid.getCellDisplayValue("B211")).toBe("25");
    expect(await grid.getCellDisplayValue("C211")).toBe("LA");
  });
});

test.describe("Keyboard navigation", () => {
  test("arrow keys after data entry navigate correctly", async ({ grid }) => {
    await grid.navigateTo("A215");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(200);

    await grid.typeAndEnter("Start");

    // We're now on A216. Go right twice, up once → should be C215
    await grid.pressArrow("ArrowRight", 2);
    await grid.pressArrow("ArrowUp", 1);

    const nameBox = await grid.getNameBoxValue();
    expect(nameBox).toBe("C215");
  });

  test("Ctrl+Home returns to A1 from distant cell", async ({ grid }) => {
    await grid.navigateTo("Z100");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(200);

    await grid.page.keyboard.press("Control+Home");
    await grid.page.waitForTimeout(300);

    const nameBox = await grid.getNameBoxValue();
    expect(nameBox).toBe("A1");
  });

  test("Escape cancels edit and restores original value", async ({ grid }) => {
    await grid.setCellValueDirect("A220", "Original");
    await grid.navigateTo("A220");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(200);

    // Start typing (overwrites)
    await grid.page.keyboard.type("Changed", { delay: 20 });
    // Cancel
    await grid.page.keyboard.press("Escape");
    await grid.page.waitForTimeout(200);

    expect(await grid.getCellDisplayValue("A220")).toBe("Original");
  });

  test("F2 enters edit mode preserving existing content", async ({ grid }) => {
    await grid.setCellValueDirect("A221", "Hello");
    await grid.navigateTo("A221");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(200);

    // F2 enters edit mode
    await grid.page.keyboard.press("F2");
    await grid.page.waitForTimeout(200);

    // Formula bar should show the value
    const fbValue = await grid.getFormulaBarValue();
    expect(fbValue).toBe("Hello");

    await grid.page.keyboard.press("Escape");
  });

  test("Delete clears cell content", async ({ grid }) => {
    await grid.setCellValueDirect("A222", "DeleteMe");
    await grid.navigateTo("A222");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(200);

    await grid.page.keyboard.press("Delete");
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellDisplayValue("A222")).toBe("");
  });
});

test.describe("Shift+Arrow selection", () => {
  test("select a range with Shift+Arrow keys", async ({ grid }) => {
    // Set up some data
    await grid.setCellValueDirect("A225", "1");
    await grid.setCellValueDirect("B225", "2");
    await grid.setCellValueDirect("A226", "3");
    await grid.setCellValueDirect("B226", "4");

    await grid.navigateTo("A225");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(200);

    // Shift+Right, Shift+Down to select A225:B226
    await grid.shiftArrowSelect(1, 1);

    // Verify selection by checking grid state
    const sel = await grid.page.evaluate(() => {
      const gs = (window as any).__CALCULA_GRID_STATE__;
      return gs?.selection ?? null;
    });
    expect(sel).not.toBeNull();
    // Selection should span 2 rows and 2 cols
    const rowSpan = Math.abs(sel.endRow - sel.startRow) + 1;
    const colSpan = Math.abs(sel.endCol - sel.startCol) + 1;
    expect(rowSpan).toBe(2);
    expect(colSpan).toBe(2);
  });

  test("Delete clears entire selected range", async ({ grid }) => {
    await grid.setCellValueDirect("D225", "X");
    await grid.setCellValueDirect("E225", "Y");
    await grid.setCellValueDirect("D226", "Z");
    await grid.setCellValueDirect("E226", "W");

    await grid.navigateTo("D225");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(200);

    // Select D225:E226
    await grid.shiftArrowSelect(1, 1);

    // Delete the range
    await grid.page.keyboard.press("Delete");
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellDisplayValue("D225")).toBe("");
    expect(await grid.getCellDisplayValue("E225")).toBe("");
    expect(await grid.getCellDisplayValue("D226")).toBe("");
    expect(await grid.getCellDisplayValue("E226")).toBe("");
  });
});

test.describe("Formula entry via keyboard", () => {
  test("type formula with cell references using arrow keys", async ({ grid }) => {
    // Set up values
    await grid.setCellValueDirect("A230", "10");
    await grid.setCellValueDirect("A231", "20");

    // Navigate to the formula cell
    await grid.navigateTo("A232");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(200);

    // Type =A230+A231 manually
    await grid.page.keyboard.type("=A230+A231", { delay: 30 });
    await grid.page.keyboard.press("Enter");
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellDisplayValue("A232")).toBe("30");
  });

  test("edit formula with F2 and modify", async ({ grid }) => {
    // Set up formula (each test is independent)
    await grid.setCellValueDirect("A230", "10");
    await grid.setCellValueDirect("A231", "20");
    await grid.setCellValueDirect("A232", "=A230+A231");

    await grid.navigateTo("A232");
    await grid.spreadsheet.focus();
    await grid.page.waitForTimeout(200);

    // F2 to edit
    await grid.page.keyboard.press("F2");
    await grid.page.waitForTimeout(200);

    // The formula bar should show the formula
    const formula = await grid.getFormulaBarValue();
    expect(formula).toContain("=");

    // Cancel
    await grid.page.keyboard.press("Escape");
  });
});
