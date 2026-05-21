/**
 * Regression scenario tests.
 *
 * Complex multi-feature combinations designed to catch regressions
 * where one operation breaks another. Each test combines 3+ features
 * in sequences that reflect real-world usage patterns.
 *
 * Uses rows 800-850.
 */
import { test, expect } from "../fixtures";

test.describe("Format + Sort + Filter pipeline", () => {
  test("apply formatting, sort, filter, then verify all survive", async ({ grid }) => {
    // 1. Enter data
    await grid.setCellValueDirect("A800", "Name");
    await grid.setCellValueDirect("B800", "Score");
    await grid.setCellValueDirect("A801", "Charlie");
    await grid.setCellValueDirect("B801", "90");
    await grid.setCellValueDirect("A802", "Alice");
    await grid.setCellValueDirect("B802", "45");
    await grid.setCellValueDirect("A803", "Bob");
    await grid.setCellValueDirect("B803", "75");
    await grid.setCellValueDirect("A804", "Diana");
    await grid.setCellValueDirect("B804", "30");

    // 2. Bold the header row
    await grid.selectRange("A800", "B800");
    await grid.toggleBold();
    expect(await grid.getCellStyleProp("A800", "bold")).toBe(true);

    // 3. Apply comma format to scores
    await grid.selectRange("B801", "B804");
    await grid.clickFormatButton("commaFormat");

    // 4. Sort by score descending
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("sort_range", {
        params: {
          startRow: 800, startCol: 0, endRow: 803, endCol: 1,
          fields: [{ key: 1, ascending: false }],
          matchCase: false, hasHeaders: false, orientation: "rows",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    // Verify sort: 90, 75, 45, 30
    expect(await grid.getCellDisplayValue("B801")).toBe("90");
    expect(await grid.getCellDisplayValue("B802")).toBe("75");

    // 5. Apply auto filter
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("apply_auto_filter", {
        params: { startRow: 799, startCol: 0, endRow: 803, endCol: 1 },
      });
    });
    await grid.page.waitForTimeout(300);

    // 6. Filter to scores > 50 (show Charlie=90 and Bob=75)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_column_filter_values", {
        columnIndex: 1, values: ["90", "75"], includeBlanks: false,
      });
    });
    await grid.page.waitForTimeout(300);

    const hidden = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_hidden_rows");
    });
    expect(hidden.length).toBeGreaterThan(0);

    // 7. Clear filter and remove auto filter
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("clear_auto_filter_criteria");
      await tauri.core.invoke("remove_auto_filter");
    });
    await grid.page.waitForTimeout(300);

    // 8. Verify formatting survived the sort + filter round-trip
    expect(await grid.getCellStyleProp("A800", "bold")).toBe(true);
    const fmt = await grid.getCellStyleStringProp("B801", "numberFormat");
    expect(fmt).toContain("separator");
  });
});

test.describe("Undo across feature boundaries", () => {
  test("undo formatting, then undo cell edit in sequence", async ({ grid }) => {
    await grid.setCellValueDirect("A810", "Original");
    await grid.page.waitForTimeout(200);

    // Bold it
    await grid.clickCell("A810");
    await grid.toggleBold();
    expect(await grid.getCellStyleProp("A810", "bold")).toBe(true);

    // Undo bold
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("undo");
    });
    await grid.page.waitForTimeout(300);
    expect(await grid.getCellStyleProp("A810", "bold")).toBe(false);

    // Undo the cell edit (should revert to empty)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("undo");
    });
    await grid.page.waitForTimeout(300);
    expect(await grid.getCellDisplayValue("A810")).toBe("");
  });

  test("undo merge operation restores individual cells", async ({ grid }) => {
    await grid.setCellValueDirect("A815", "Cell1");
    await grid.setCellValueDirect("B815", "Cell2");
    await grid.setCellValueDirect("C815", "Cell3");
    await grid.page.waitForTimeout(200);

    // Merge A815:C815
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("merge_cells", {
        startRow: 814, startCol: 0, endRow: 814, endCol: 2,
      });
    });
    await grid.page.waitForTimeout(300);

    // Verify merged
    const mergeInfo = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_merge_info", { row: 814, col: 0 });
    });
    expect(mergeInfo).not.toBeNull();

    // Undo merge
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("undo");
    });
    await grid.page.waitForTimeout(300);

    // Should be unmerged
    const afterUndo = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_merge_info", { row: 814, col: 0 });
    });
    expect(afterUndo).toBeNull();
  });
});

test.describe("Copy-paste with formulas and formatting combined", () => {
  test("copy block with formulas, formatting, and number format", async ({ grid }) => {
    // Source block: A820-B822 with formula in B, bold in A, percent format in B
    await grid.setCellValueDirect("A820", "Revenue");
    await grid.setCellValueDirect("B820", "0.15");
    await grid.setCellValueDirect("A821", "Cost");
    await grid.setCellValueDirect("B821", "0.08");
    await grid.setCellValueDirect("A822", "Margin");
    await grid.setCellValueDirect("B822", "=B820-B821");

    // Bold labels
    for (const ref of ["A820", "A821", "A822"]) {
      await grid.clickCell(ref);
      await grid.toggleBold();
    }

    // Percent format on values
    await grid.selectRange("B820", "B822");
    await grid.clickFormatButton("percentFormat");

    // Verify source
    expect(await grid.getCellStyleProp("A820", "bold")).toBe(true);
    const display = await grid.getCellDisplayValue("B822");
    expect(display).toMatch(/7\s*%/); // 0.15 - 0.08 = 0.07 = 7%

    // Copy and paste the block
    await grid.selectRange("A820", "B822");
    await grid.clickFormatButton("copy");
    await grid.clickCell("D820");
    await grid.clickFormatButton("paste");
    await grid.page.waitForTimeout(500);

    // Verify paste: formatting and values carried over
    expect(await grid.getCellStyleProp("D820", "bold")).toBe(true);
    expect(await grid.getCellDisplayValue("D820")).toBe("Revenue");
    const pastedFmt = await grid.getCellStyleStringProp("E820", "numberFormat");
    expect(pastedFmt).toContain("Percentage");
  });
});

test.describe("Find-replace then undo then redo", () => {
  test("replace values, undo the replace, redo it", async ({ grid }) => {
    await grid.setCellValueDirect("A830", "foo");
    await grid.setCellValueDirect("A831", "foo");
    await grid.setCellValueDirect("A832", "bar");
    await grid.page.waitForTimeout(200);

    // Replace foo -> baz
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("replace_all", {
        search: "foo", replacement: "baz",
        caseSensitive: false, matchEntireCell: true,
      });
    });
    await grid.page.waitForTimeout(300);
    expect(await grid.getCellDisplayValue("A830")).toBe("baz");
    expect(await grid.getCellDisplayValue("A831")).toBe("baz");
    expect(await grid.getCellDisplayValue("A832")).toBe("bar"); // unchanged

    // Undo
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("undo");
    });
    await grid.page.waitForTimeout(300);
    expect(await grid.getCellDisplayValue("A830")).toBe("foo");
    expect(await grid.getCellDisplayValue("A831")).toBe("foo");

    // Redo
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("redo");
    });
    await grid.page.waitForTimeout(300);
    expect(await grid.getCellDisplayValue("A830")).toBe("baz");
    expect(await grid.getCellDisplayValue("A831")).toBe("baz");
  });
});

test.describe("Insert row in middle of formula range", () => {
  test.fixme("inserting a row expands formula references", async ({ grid }) => {
    await grid.setCellValueDirect("A840", "10");
    await grid.setCellValueDirect("A841", "20");
    await grid.setCellValueDirect("A842", "30");
    await grid.setCellValueDirect("A843", "=SUM(A840:A842)");
    expect(await grid.getCellDisplayValue("A843")).toBe("60");

    // Insert row at 841 (between 10 and 20)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("insert_rows", { row: 841, count: 1 });
    });
    await grid.page.waitForTimeout(500);

    // The new row is empty, SUM range should have expanded to include it
    // Original data shifted: A840=10, A841=empty, A842=20, A843=30
    // SUM formula (now in A844) should reference A840:A843
    // Sum = 10 + 0 + 20 + 30 = 60 (same total, range expanded)
    const sum = await grid.getCellLiveValue("A844");
    expect(sum).toBe("60");

    // Add a value in the inserted row
    await grid.setCellValueDirect("A841", "15");
    await grid.page.waitForTimeout(300);

    // Sum should now include it: 10+15+20+30 = 75
    expect(await grid.getCellLiveValue("A844")).toBe("75");

    // Clean up: delete the inserted row
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("delete_rows", { row: 841, count: 1 });
    });
  });
});

test.describe("Data validation + formatting + edit cycle", () => {
  test("validation blocks invalid input but allows valid with formatting", async ({ grid }) => {
    // Set up validation: only allow 1-100
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_data_validation", {
        startRow: 849, startCol: 0, endRow: 849, endCol: 0,
        validation: {
          rule: { wholeNumber: { formula1: 1, formula2: 100, operator: "between" } },
          errorAlert: { title: "Error", message: "1-100 only", style: "stop", showAlert: true },
          prompt: { title: "", message: "", showPrompt: false },
          ignoreBlanks: true,
        },
      });
    });

    // Valid value
    const valid = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("validate_pending_value", {
        row: 849, col: 0, pendingValue: "50",
      });
    });
    expect(valid.isValid).toBe(true);

    // Enter the valid value and apply formatting
    await grid.setCellValueDirect("A850", "50");
    await grid.clickCell("A850");
    await grid.toggleBold();
    await grid.clickFormatButton("percentFormat");

    // Value should display as percentage AND be bold
    const display = await grid.getCellDisplayValue("A850");
    expect(display).toMatch(/50.*%|5000.*%/); // 50 as percent = 5000%
    expect(await grid.getCellStyleProp("A850", "bold")).toBe(true);

    // Invalid value should fail validation
    const invalid = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("validate_pending_value", {
        row: 849, col: 0, pendingValue: "200",
      });
    });
    expect(invalid.isValid).toBe(false);

    // Clean up validation
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("clear_data_validation", {
        startRow: 849, startCol: 0, endRow: 849, endCol: 0,
      });
    });
  });
});
