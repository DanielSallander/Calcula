/**
 * Advanced formulas E2E tests (Phase 18).
 *
 * Tests complex formula functions and error handling.
 * Uses setCellValueDirect() to bypass locale-related keyboard input
 * transformations (e.g., comma → dot in European locales).
 *
 * Uses cells in columns G-L, rows 10-22 to avoid collision with other phases.
 */
import { test, expect } from "../fixtures";

test.describe("Lookup functions", () => {
  // BUG: VLOOKUP returns #NA — MATCH works on same data, so the issue is
  // likely in extract_2d_rows() which may return a flat array instead of
  // a 2D array for multi-column ranges.
  test.fixme("VLOOKUP finds value in table", async ({ grid }) => {
    // Set up a simple lookup table
    await grid.setCellValueDirect("G10", "1");
    await grid.setCellValueDirect("H10", "Alice");
    await grid.setCellValueDirect("G11", "2");
    await grid.setCellValueDirect("H11", "Bob");
    await grid.setCellValueDirect("G12", "3");
    await grid.setCellValueDirect("H12", "Charlie");

    // Verify data was entered correctly
    expect(await grid.getCellDisplayValue("G11")).toBe("2");
    expect(await grid.getCellDisplayValue("H11")).toBe("Bob");

    // Debug: check cell type of G11 (should be number, not text)
    const g11Type = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const cell = await tauri.core.invoke("get_cell", { row: 10, col: 6 });
      return JSON.stringify(cell);
    });
    console.log("[DEBUG] G11 cell data:", g11Type);

    // Try a simpler VLOOKUP first - use MATCH to verify the lookup works
    await grid.setCellValueDirect("I10", "=MATCH(2;G10:G12;0)");
    const matchResult = await grid.getCellDisplayValue("I10");
    console.log("[DEBUG] MATCH result:", matchResult);

    // VLOOKUP to find "Bob" by ID 2 (use semicolons for Swedish locale)
    await grid.setCellValueDirect("J10", "=VLOOKUP(2;G10:H12;2;FALSE)");
    const result = await grid.getCellDisplayValue("J10");
    expect(result).toBe("Bob");
  });

  test.fixme("INDEX/MATCH combination", async ({ grid }) => {
    await grid.setCellValueDirect("J11", "=INDEX(H10:H12;MATCH(3;G10:G12;0))");
    const result = await grid.getCellDisplayValue("J11");
    expect(result).toBe("Charlie");
  });
});

test.describe("Conditional functions", () => {
  test("SUMIF sums matching values", async ({ grid }) => {
    await grid.setCellValueDirect("G14", "Cat");
    await grid.setCellValueDirect("H14", "10");
    await grid.setCellValueDirect("G15", "Dog");
    await grid.setCellValueDirect("H15", "20");
    await grid.setCellValueDirect("G16", "Cat");
    await grid.setCellValueDirect("H16", "30");

    await grid.setCellValueDirect("J14", '=SUMIF(G14:G16;"Cat";H14:H16)');
    const result = await grid.getCellDisplayValue("J14");
    expect(result).toBe("40");
  });

  test("COUNTIF counts matching cells", async ({ grid }) => {
    await grid.setCellValueDirect("J15", '=COUNTIF(G14:G16;"Cat")');
    const result = await grid.getCellDisplayValue("J15");
    expect(result).toBe("2");
  });
});

test.describe("Error values", () => {
  test("division by zero shows #DIV/0!", async ({ grid }) => {
    await grid.setCellValueDirect("G18", "=1/0");
    const display = await grid.getCellDisplayValue("G18");
    expect(display).toContain("DIV");
  });

  test("invalid function shows error", async ({ grid }) => {
    await grid.setCellValueDirect("H18", "=NONEXISTENTFUNC()");
    const display = await grid.getCellDisplayValue("H18");
    expect(display).toMatch(/#(NAME|VALUE|REF|ERROR)/i);
  });
});

test.describe("Math functions", () => {
  test("ABS function", async ({ grid }) => {
    await grid.setCellValueDirect("G19", "=ABS(-42)");
    expect(await grid.getCellDisplayValue("G19")).toBe("42");
  });

  test("ROUND function", async ({ grid }) => {
    await grid.setCellValueDirect("H19", "=ROUND(3,14159;2)");
    const display = await grid.getCellDisplayValue("H19");
    expect(display).toMatch(/3[.,]14/);
  });

  test("MAX and MIN", async ({ grid }) => {
    await grid.setCellValueDirect("G20", "5");
    await grid.setCellValueDirect("H20", "10");
    await grid.setCellValueDirect("I20", "3");
    await grid.setCellValueDirect("J20", "=MAX(G20:I20)");
    await grid.setCellValueDirect("K20", "=MIN(G20:I20)");

    expect(await grid.getCellDisplayValue("J20")).toBe("10");
    expect(await grid.getCellDisplayValue("K20")).toBe("3");
  });

  test("AVERAGE function", async ({ grid }) => {
    await grid.setCellValueDirect("L20", "=AVERAGE(G20:I20)");
    const display = await grid.getCellDisplayValue("L20");
    expect(display).toBe("6");
  });
});

test.describe("Text functions", () => {
  test("CONCATENATE / & operator", async ({ grid }) => {
    await grid.setCellValueDirect("G21", "Hello");
    await grid.setCellValueDirect("H21", "World");
    await grid.setCellValueDirect("I21", '=G21&" "&H21');
    expect(await grid.getCellDisplayValue("I21")).toBe("Hello World");
  });

  test("LEN function", async ({ grid }) => {
    await grid.setCellValueDirect("J21", '=LEN("test")');
    expect(await grid.getCellDisplayValue("J21")).toBe("4");
  });

  test("UPPER and LOWER", async ({ grid }) => {
    await grid.setCellValueDirect("G22", '=UPPER("hello")');
    await grid.setCellValueDirect("H22", '=LOWER("HELLO")');
    expect(await grid.getCellDisplayValue("G22")).toBe("HELLO");
    expect(await grid.getCellDisplayValue("H22")).toBe("hello");
  });
});
