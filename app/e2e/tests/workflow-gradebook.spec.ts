/**
 * Advanced workflow: Student grade book with statistics.
 *
 * Simulates building a teacher's grade book with:
 * - Student names and test scores
 * - Average, min, max formulas per student and per test
 * - Conditional pass/fail logic
 * - Sorting by average grade
 * - Formatting: bold headers, color-coded pass/fail
 *
 * Uses rows 440-465, columns A-H.
 */
import { test, expect } from "../fixtures";

test.describe("Grade book workflow", () => {
  test.describe.configure({ mode: "serial" });

  test("step 1: set up headers and student data", async ({ grid }) => {
    // Headers
    await grid.setCellValueDirect("A440", "Student");
    await grid.setCellValueDirect("B440", "Test 1");
    await grid.setCellValueDirect("C440", "Test 2");
    await grid.setCellValueDirect("D440", "Test 3");
    await grid.setCellValueDirect("E440", "Average");
    await grid.setCellValueDirect("F440", "Min");
    await grid.setCellValueDirect("G440", "Max");
    await grid.setCellValueDirect("H440", "Status");

    // Bold headers
    await grid.selectRange("A440", "H440");
    await grid.toggleBold();

    // Student data
    const students = [
      ["Anna Svensson",  "85", "92", "78"],
      ["Erik Johansson",  "45", "58", "52"],
      ["Maria Karlsson",  "91", "88", "95"],
      ["Lars Andersson",  "72", "65", "70"],
      ["Sofia Nilsson",   "38", "42", "35"],
    ];

    for (let i = 0; i < students.length; i++) {
      const row = 441 + i;
      for (let j = 0; j < students[i].length; j++) {
        const col = String.fromCharCode(65 + j); // A, B, C, D
        await grid.setCellValueDirect(`${col}${row}`, students[i][j]);
      }
    }

    expect(await grid.getCellDisplayValue("A441")).toBe("Anna Svensson");
    expect(await grid.getCellDisplayValue("D443")).toBe("95");
  });

  test("step 2: add per-student formulas (average, min, max)", async ({ grid }) => {
    for (let i = 0; i < 5; i++) {
      const row = 441 + i;
      // Use semicolons for locale-aware formulas
      await grid.setCellValueDirect(`E${row}`, `=AVERAGE(B${row}:D${row})`);
      await grid.setCellValueDirect(`F${row}`, `=MIN(B${row}:D${row})`);
      await grid.setCellValueDirect(`G${row}`, `=MAX(B${row}:D${row})`);
    }

    // Anna's average: (85+92+78)/3 = 85
    const annaAvg = await grid.getCellDisplayValue("E441");
    expect(parseFloat(annaAvg.replace(",", "."))).toBe(85);

    // Maria's max should be 95
    expect(await grid.getCellDisplayValue("G443")).toBe("95");
  });

  test("step 3: add pass/fail status with IF formula", async ({ grid }) => {
    for (let i = 0; i < 5; i++) {
      const row = 441 + i;
      // Pass if average >= 60
      await grid.setCellValueDirect(`H${row}`, `=IF(E${row}>=60;"Pass";"Fail")`);
    }

    expect(await grid.getCellDisplayValue("H441")).toBe("Pass"); // Anna: 85
    expect(await grid.getCellDisplayValue("H442")).toBe("Fail"); // Erik: 51.67
    expect(await grid.getCellDisplayValue("H443")).toBe("Pass"); // Maria: 91.33
    expect(await grid.getCellDisplayValue("H444")).toBe("Pass"); // Lars: 69
    expect(await grid.getCellDisplayValue("H445")).toBe("Fail"); // Sofia: 38.33
  });

  test("step 4: add class statistics row", async ({ grid }) => {
    await grid.setCellValueDirect("A447", "Class Avg:");
    await grid.setCellValueDirect("B447", "=AVERAGE(B441:B445)");
    await grid.setCellValueDirect("C447", "=AVERAGE(C441:C445)");
    await grid.setCellValueDirect("D447", "=AVERAGE(D441:D445)");
    await grid.setCellValueDirect("E447", "=AVERAGE(E441:E445)");

    // Bold the stats row
    await grid.clickCell("A447");
    await grid.toggleBold();

    // Class average of Test 1: (85+45+91+72+38)/5 = 66.2
    const classAvg = await grid.getCellDisplayValue("B447");
    expect(parseFloat(classAvg.replace(",", "."))).toBeCloseTo(66.2, 1);
  });

  test("step 5: sort students by average descending", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("sort_range", {
        params: {
          startRow: 440, startCol: 0, endRow: 444, endCol: 7,
          fields: [{ key: 4, ascending: false }],
          matchCase: false, hasHeaders: false, orientation: "rows",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    // First student should be Maria (highest avg ~91.33)
    expect(await grid.getCellDisplayValue("A441")).toBe("Maria Karlsson");
    // Last should be Sofia (lowest avg ~38.33)
    expect(await grid.getCellDisplayValue("A445")).toBe("Sofia Nilsson");
  });

  test("step 6: apply conditional formatting to fail cells", async ({ grid }) => {
    // Add red background to cells that say "Fail"
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("add_conditional_format", {
        params: {
          rule: { type: "containsText", ruleType: "contains", text: "Fail" },
          format: { backgroundColor: "#ffcccc", bold: true },
          ranges: [{ startRow: 440, startCol: 7, endRow: 444, endCol: 7 }],
        },
      });
    });
    await grid.page.waitForTimeout(300);

    // Evaluate and verify
    const evalResult = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("evaluate_conditional_formats", {
        startRow: 440, startCol: 7, endRow: 444, endCol: 7,
      });
    });
    expect(evalResult).toBeDefined();
  });

  test.fixme("step 7: update a score and verify cascade", async ({ grid }) => {
    // Change Erik's Test 1 from 45 to 75
    // After sort, Erik is at row index... let's find him
    const erik442 = await grid.getCellDisplayValue("A442");
    // Find Erik's row
    let erikRow = 0;
    for (let r = 441; r <= 445; r++) {
      const name = await grid.getCellDisplayValue(`A${r}`);
      if (name.includes("Erik")) { erikRow = r; break; }
    }

    if (erikRow > 0) {
      await grid.setCellValueDirect(`B${erikRow}`, "75");
      await grid.page.waitForTimeout(300);

      // Erik's average should increase: (75+58+52)/3 = 61.67
      const avg = await grid.getCellLiveValue(`E${erikRow}`);
      expect(parseFloat(avg.replace(",", "."))).toBeCloseTo(61.67, 0);

      // Status should flip to Pass (61.67 >= 60)
      expect(await grid.getCellLiveValue(`H${erikRow}`)).toBe("Pass");
    }
  });
});
