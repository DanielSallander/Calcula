/**
 * Wave 3 / C1 — user-defined formula function (UDF) evaluation, end-to-end.
 *
 * Unit tests cover the engine udf_fn hook, the Rust wire conversions, and the
 * broker-routed resolve. They CANNOT cover the integration that makes the
 * feature real: the frontend collect -> resolve -> apply round-trip across the
 * Tauri boundary. This test exercises exactly that through the production path.
 *
 * It drives the CORE updateCell wrapper (not the raw update_cell command, and
 * not setCellValueDirect) because the UDF pre-resolve hook lives in that wrapper
 * (see setUdfResolveHook). Asserting through it proves:
 *   1. a registered UDF evaluates in the cell that names it (collect of the
 *      edited cell -> broker invoke -> apply with the pre-fetched table), and
 *   2. it RECALCULATES when a same-sheet input changes (the dependent-cascade
 *      path is UDF-served), which is the core spreadsheet behavior.
 */
import { test, expect } from "../fixtures";

test.describe("UDF evaluation (Phase C1)", () => {
  test("a registered custom function evaluates and recalcs on input change", async ({
    appPage: page,
  }) => {
    const result = await page.evaluate(async () => {
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      );
      const core = await (window as any).__calcImport(
        new URL("/src/core/lib/tauri-api.ts", document.baseURI).href,
      );
      const { registerFormulaFunction, installUdfEvaluation } = api;
      const tauri = (window as any).__TAURI__;

      // Register a UDF that doubles its single numeric argument, and make sure
      // the evaluation hook is installed (idempotent; the FormulaAutocomplete
      // extension also installs it at activation).
      const unregister = registerFormulaFunction({
        name: "MYDOUBLE",
        description: "Doubles a number",
        syntax: "MYDOUBLE(x)",
        category: "Custom",
        minArgs: 1,
        maxArgs: 1,
        implementation: (x: unknown) => (x as number) * 2,
      });
      installUdfEvaluation();

      const readDisplay = async (r: number, c: number): Promise<string> => {
        const cell = await tauri.core.invoke("get_cell", { row: r, col: c });
        return String(cell?.display ?? cell?.value ?? "");
      };

      try {
        // A1 = 10 (plain literal, through the core wrapper for consistency).
        await core.updateCell(0, 0, "10");
        // B1 = MYDOUBLE(A1) -> must resolve to 20 (was #NAME? before C1).
        await core.updateCell(0, 1, "=MYDOUBLE(A1)");
        const first = await readDisplay(0, 1);

        // Change the input; the same-sheet dependent must recompute to 42.
        await core.updateCell(0, 0, "21");
        const second = await readDisplay(0, 1);

        return { first, second, error: "" };
      } finally {
        unregister();
        await core.updateCell(0, 0, "");
        await core.updateCell(0, 1, "");
      }
    });

    expect(result.error).toBe("");
    // The UDF evaluated in its own cell (collect -> broker -> apply).
    expect(result.first).toContain("20");
    // And it recalculated when its input changed (dependent cascade is served).
    expect(result.second).toContain("42");
  });

  test("a UDF formula written through the BATCH path evaluates (paste/fill)", async ({
    appPage: page,
  }) => {
    // Paste, fill-handle and multi-cell edits all route through
    // updateCellsBatch. That bridge used to send no UDF data at all, so a
    // pasted =MYFN(...) had nothing pre-fetched and nothing stored to preserve
    // and landed as #NAME?. Drive the batch wrapper directly to pin the fix,
    // including an expression AROUND the call (a bare =MYFN() would look
    // correct even when the cascade re-evaluates it without a resolver).
    const result = await page.evaluate(async () => {
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      );
      const core = await (window as any).__calcImport(
        new URL("/src/core/lib/tauri-api.ts", document.baseURI).href,
      );
      const { registerFormulaFunction, installUdfEvaluation } = api;
      const tauri = (window as any).__TAURI__;

      const unregister = registerFormulaFunction({
        name: "BATCHDOUBLE",
        description: "Doubles a number",
        syntax: "BATCHDOUBLE(x)",
        category: "Custom",
        minArgs: 1,
        maxArgs: 1,
        implementation: (x: unknown) => (x as number) * 2,
      });
      installUdfEvaluation();

      const readDisplay = async (r: number, c: number): Promise<string> => {
        const cell = await tauri.core.invoke("get_cell", { row: r, col: c });
        return String(cell?.display ?? cell?.value ?? "");
      };

      try {
        // One batch writing the input AND two formulas over it, exactly like a
        // paste of a three-cell block.
        await core.updateCellsBatch([
          { row: 5, col: 0, value: "10" },
          { row: 5, col: 1, value: "=BATCHDOUBLE(A6)", invariant: true },
          { row: 5, col: 2, value: "=BATCHDOUBLE(A6)+1", invariant: true },
        ]);
        const bare = await readDisplay(5, 1);
        const wrapped = await readDisplay(5, 2);
        return { bare, wrapped };
      } finally {
        unregister();
        await core.updateCellsBatch([
          { row: 5, col: 0, value: "" },
          { row: 5, col: 1, value: "" },
          { row: 5, col: 2, value: "" },
        ]);
      }
    });

    expect(result.bare).toContain("20");
    // 21, not 41: proof the dependent cascade served the pre-fetched result
    // instead of re-applying the arithmetic to the cell's own stored value.
    expect(result.wrapped).toContain("21");
  });

  test("an unregistered name still yields #NAME?", async ({ appPage: page }) => {
    const result = await page.evaluate(async () => {
      const core = await (window as any).__calcImport(
        new URL("/src/core/lib/tauri-api.ts", document.baseURI).href,
      );
      const tauri = (window as any).__TAURI__;
      try {
        await core.updateCell(0, 3, "=NOSUCHFUNC(1)");
        const cell = await tauri.core.invoke("get_cell", { row: 0, col: 3 });
        return String(cell?.display ?? cell?.value ?? "");
      } finally {
        await core.updateCell(0, 3, "");
      }
    });
    // Unknown function names must remain #NAME? (the udf hook returns None).
    expect(result).toContain("#NAME");
  });
});
