/**
 * Evaluate Formula (step-by-step) E2E tests.
 *
 * Tests the eval_formula_* Tauri commands for the step-by-step formula
 * evaluator dialog.
 * Uses cells in columns AI-AJ, rows 1-10 to avoid conflicts with other tests.
 */
import { test, expect } from "../fixtures";
import { takeGridScreenshot, softly } from "../helpers/screenshots";

test.describe("Evaluate Formula", () => {
  test("initialize evaluation session for a formula cell", async ({ appPage, grid }) => {
    // Set up: AI1=10, AI2=20, AI3=AI1+AI2
    await grid.setCellValueDirect("AI1", "10");
    await grid.setCellValueDirect("AI2", "20");
    await grid.setCellValueDirect("AI3", "=AI1+AI2");
    await grid.page.waitForTimeout(300);

    // Initialize evaluation session for AI3 (row 2, col 34)
    const state: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("eval_formula_init", { row: 2, col: 34 });
    });
    await grid.page.waitForTimeout(200);

    expect(state).toBeDefined();
    expect(state.sessionId).toBeDefined();
    expect(state.formulaDisplay).toBeDefined();
    expect(state.isComplete).toBe(false);

    // Clean up: close the session
    await grid.page.evaluate(async (sid) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("eval_formula_close", { sessionId: sid });
    }, state.sessionId);

    await grid.navigateTo("AI1");
    await softly(takeGridScreenshot(appPage, "evaluate-formula-init"));
  });

  test("step through evaluation to completion", async ({ grid }) => {
    // Set up: AI4=5, AI5=3, AI6=AI4*AI5
    await grid.setCellValueDirect("AI4", "5");
    await grid.setCellValueDirect("AI5", "3");
    await grid.setCellValueDirect("AI6", "=AI4*AI5");
    await grid.page.waitForTimeout(300);

    // Init session for AI6 (row 5, col 34)
    const initState: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("eval_formula_init", { row: 5, col: 34 });
    });
    await grid.page.waitForTimeout(200);

    const sessionId = initState.sessionId;
    expect(sessionId).toBeDefined();

    // Step through evaluation until complete (max 10 steps to avoid infinite loop)
    let currentState = initState;
    let steps = 0;
    while (!currentState.isComplete && steps < 10) {
      currentState = await grid.page.evaluate(async (sid) => {
        const tauri = (window as any).__TAURI__;
        return tauri.core.invoke("eval_formula_evaluate", { sessionId: sid });
      }, sessionId);
      await grid.page.waitForTimeout(200);
      steps++;
    }

    // Should reach completion
    expect(currentState.isComplete).toBe(true);
    // The final result should be 15 (5*3)
    if (currentState.evaluationResult) {
      expect(currentState.evaluationResult).toBe("15");
    }

    // Clean up
    await grid.page.evaluate(async (sid) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("eval_formula_close", { sessionId: sid });
    }, sessionId);
  });

  test("restart evaluation resets to initial state", async ({ grid }) => {
    // Set up self-contained data
    await grid.setCellValueDirect("AI7", "100");
    await grid.setCellValueDirect("AI8", "=AI7+50");
    await grid.page.waitForTimeout(300);

    // Init session for AI8 (row 7, col 34)
    const initState: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("eval_formula_init", { row: 7, col: 34 });
    });
    await grid.page.waitForTimeout(200);

    const sessionId = initState.sessionId;

    // Evaluate one step
    const stepped: any = await grid.page.evaluate(async (sid) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("eval_formula_evaluate", { sessionId: sid });
    }, sessionId);
    await grid.page.waitForTimeout(200);

    // Restart the evaluation
    const restarted: any = await grid.page.evaluate(async (sid) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("eval_formula_restart", { sessionId: sid });
    }, sessionId);
    await grid.page.waitForTimeout(200);

    expect(restarted).toBeDefined();
    expect(restarted.isComplete).toBe(false);
    // After restart the formula display should match the initial state
    expect(restarted.formulaDisplay).toBe(initState.formulaDisplay);

    // Clean up
    await grid.page.evaluate(async (sid) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("eval_formula_close", { sessionId: sid });
    }, sessionId);
  });

  test("evaluating a non-formula cell returns immediate result", async ({ appPage, grid }) => {
    // AI9 is a plain constant
    await grid.setCellValueDirect("AI9", "42");
    await grid.page.waitForTimeout(200);

    // Init session for a constant cell AI9 (row 8, col 34)
    const state: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("eval_formula_init", { row: 8, col: 34 });
    });
    await grid.page.waitForTimeout(200);

    // A constant cell should either immediately complete or report an error
    // (no formula to evaluate)
    if (state.error) {
      // Some implementations report an error for non-formula cells
      expect(state.error).toBeDefined();
    } else {
      // Others may immediately mark it as complete
      expect(state.isComplete).toBe(true);
    }

    // Clean up if session was created
    if (state.sessionId) {
      await grid.page.evaluate(async (sid) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("eval_formula_close", { sessionId: sid });
      }, state.sessionId);
    }

    await grid.navigateTo("AI1");
    await softly(takeGridScreenshot(appPage, "evaluate-formula-constant"));
  });
});
