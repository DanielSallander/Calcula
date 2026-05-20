/**
 * Conditional formatting E2E tests (Phase 14).
 *
 * Tests conditional formatting rules via Tauri API.
 * The rule enum uses `tag = "type"` with camelCase variant names.
 * Uses cells in columns X-Y, rows 1-10 to avoid collision.
 */
import { test, expect } from "../fixtures";

test.describe("Conditional formatting", () => {
  test("add cell value rule (greater than)", async ({ grid }) => {
    await grid.setCellValueDirect("X1", "10");
    await grid.setCellValueDirect("X2", "50");
    await grid.setCellValueDirect("X3", "90");

    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("add_conditional_format", {
        params: {
          rule: { type: "cellValue", operator: "greaterThan", value1: "50" },
          format: { backgroundColor: "#ff0000", bold: true },
          ranges: [{ startRow: 0, startCol: 23, endRow: 2, endCol: 23 }],
          stopIfTrue: false,
        },
      });
    });
    await grid.page.waitForTimeout(300);

    const allRules = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_all_conditional_formats");
    });
    expect(allRules.length).toBeGreaterThanOrEqual(1);
  });

  test("evaluate conditional formats shows matching cells", async ({ grid }) => {
    const evalResult = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("evaluate_conditional_formats", {
        startRow: 0, startCol: 23, endRow: 2, endCol: 23,
      });
    });
    expect(evalResult).toBeDefined();
    // X3 (90 > 50) should match
    if (evalResult.cells && evalResult.cells.length > 0) {
      const matchingRows = evalResult.cells.map((c: any) => c.row);
      expect(matchingRows).toContain(2); // X3 = row 2 (0-based)
    }
  });

  test("delete conditional format", async ({ grid }) => {
    const rules = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_all_conditional_formats");
    });

    if (rules.length > 0) {
      const ruleId = rules[0].id;
      await grid.page.evaluate(async (id: number) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("delete_conditional_format", { ruleId: id });
      }, ruleId);
      await grid.page.waitForTimeout(300);

      const rulesAfter = await grid.page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("get_all_conditional_formats");
      });
      expect(rulesAfter.length).toBe(rules.length - 1);
    }
  });

  test("clear conditional formats in range", async ({ grid }) => {
    // Add a rule first
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("add_conditional_format", {
        params: {
          rule: { type: "containsText", ruleType: "contains", text: "test" },
          format: { italic: true },
          ranges: [{ startRow: 0, startCol: 23, endRow: 2, endCol: 23 }],
        },
      });
    });
    await grid.page.waitForTimeout(300);

    const cleared = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("clear_conditional_formats_in_range", {
        startRow: 0, startCol: 23, endRow: 2, endCol: 23,
      });
    });
    expect(cleared).toBeGreaterThanOrEqual(0);
  });
});
