/**
 * Customization depth — undoable macros (gap-review C4), e2e.
 *
 * A one-off QuickJS script that writes cells used to swap whole grids: a written
 * formula was stored with ast:None (never recalculated) and the writes bypassed
 * undo entirely. Now run_script routes its writes through the edit pipeline, so:
 *   - a script-written formula PARSES + RECALCULATES (incl. dependents), and
 *   - the whole macro is a SINGLE undo entry that reverts cleanly.
 *
 * The script sets A1=5 and B1=`=A1*2`; we assert B1 shows 10 (dependency recalc),
 * then undo and assert both cells revert.
 */
import { test, expect } from "../fixtures";

test.describe("Undoable macros (one-off scripts through the edit pipeline)", () => {
  test("a script-written formula recalculates and the macro is undoable", async ({
    appPage: page,
  }) => {
    const result = await page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const display = async (row: number, col: number): Promise<string> => {
        const cell = await tauri.core.invoke("get_cell", { row, col });
        return String(cell?.display ?? cell?.value ?? "");
      };

      // Make sure both cells start empty.
      await tauri.core.invoke("update_cell", { row: 0, col: 0, value: "" });
      await tauri.core.invoke("update_cell", { row: 0, col: 1, value: "" });

      // Scripts must be allowed to run.
      await tauri.core.invoke("set_script_security_level", { level: "enabled" });

      // Run a one-off macro: A1 = 5, B1 = =A1*2.
      await tauri.core.invoke("run_script", {
        request: {
          source: "Calcula.setCellValue(0, 0, '5'); Calcula.setCellValue(0, 1, '=A1*2');",
          filename: "undo-test.js",
        },
      });

      const a1AfterRun = await display(0, 0);
      const b1AfterRun = await display(0, 1); // must be 10 (formula recalculated)

      // Undo the whole macro.
      await tauri.core.invoke("undo");

      const a1AfterUndo = await display(0, 0);
      const b1AfterUndo = await display(0, 1);

      // Cleanup.
      await tauri.core.invoke("update_cell", { row: 0, col: 0, value: "" });
      await tauri.core.invoke("update_cell", { row: 0, col: 1, value: "" });

      return { a1AfterRun, b1AfterRun, a1AfterUndo, b1AfterUndo };
    });

    // The script's writes applied + the dependent formula recalculated.
    expect(result.a1AfterRun).toContain("5");
    expect(result.b1AfterRun).toContain("10");
    // One undo reverted the whole macro.
    expect(result.a1AfterUndo).toBe("");
    expect(result.b1AfterUndo).toBe("");
  });
});
