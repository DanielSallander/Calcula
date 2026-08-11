/**
 * THE RECALCULATION PASS MUST NOT EMIT TO THE WEBVIEW WHILE IT HOLDS THE GRID
 * LOCKS.
 *
 * WHAT THIS CATCHES, and it is not a race that "might" happen — it wedged the
 * app twice in one session, for 27 minutes the first time:
 *
 *   * `calculate_now` / `calculate_sheet` are the only two
 *     `#[tauri::command(async)]` commands in the crate, so they are the only
 *     ones that run on a BACKGROUND thread. Everything else is synchronous and
 *     runs on the WebView2 MAIN thread.
 *   * The pass takes `state.grid` and `state.grids` (write) and holds both for
 *     the whole evaluation.
 *   * Inside that region it calls `ProgressEmitter::tick()` every 100 ms and
 *     `finish()` at the end. An emit has to reach the WebView, which is
 *     main-thread-affine.
 *   * So: pass (background) holds the grid locks and waits for the main thread;
 *     main thread is inside ANY synchronous command that reads the grid, and
 *     waits for the pass's locks. Neither can move. There is no panic, no crash
 *     and no log line — the window simply stops answering, and the last thing
 *     in the app log is the entry line of whatever the main thread was in.
 *
 * WHY IT NEEDS A BIG SHEET. `tick()` only emits once 100 ms have passed, so a
 * pass over a handful of cells never emits at all and the cycle never closes.
 * That is exactly why this survived: it appears only on a workbook big enough
 * to calculate for longer than a tenth of a second, which in practice meant
 * "late in a soak walk", which read as flake.
 *
 * HOW IT IS DETECTED WITHOUT HANGING THE WHOLE RUN. A wedged backend cannot be
 * distinguished from a slow one by waiting for a promise — a hang has no error.
 * So the two calls are made from the PAGE with `Promise.race` against a timer,
 * and the assertion is on the race's outcome. A hung app fails this test in
 * `TIMEOUT_MS` instead of at the project's 300 s timeout, and the failure names
 * the deadlock instead of reading as a flaky slow test.
 *
 * NOTE FOR WHOEVER SEES THIS FAIL: the app is genuinely wedged at that point.
 * The rest of the run will fail too. Kill it and read this comment.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

/** How long the two calls get before the app is declared wedged. */
const TIMEOUT_MS = 45_000;

/**
 * Rows of `=SUM(...)` to plant. Enough that a workbook pass takes longer than
 * the 100 ms progress interval on a debug build, which is what makes the pass
 * emit at all.
 */
const FORMULA_ROWS = 4000;

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const t = (
        window as unknown as {
          __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
        }
      ).__TAURI__;
      return t.core.invoke(c, a);
    },
    { c: cmd, a: args },
  ) as Promise<T>;
}

test.describe("The recalculation pass and the main thread", () => {
  test.setTimeout(240_000);

  test("a long recalculation does not wedge a concurrent main-thread command", async ({
    appPage,
  }) => {
    // ---- fixture: enough formulas that the pass runs past 100 ms ----
    await invoke(appPage, "new_file");
    await appPage.waitForTimeout(500);

    const cells: Array<{ row: number; col: number; value: string }> = [];
    for (let r = 0; r < FORMULA_ROWS; r++) {
      cells.push({ row: r, col: 0, value: String(r + 1) });
      cells.push({ row: r, col: 1, value: `=SUM($A$1:A${r + 1})*1.0001` });
    }
    await invoke(appPage, "update_cells_batch", { updates: cells });
    await appPage.waitForTimeout(1500);

    // Sanity: the fixture really is there, and it really calculates.
    const probe = await invoke<{ display?: string } | null>(appPage, "get_cell", {
      row: FORMULA_ROWS - 1,
      col: 1,
    });
    expect(
      probe?.display ?? "",
      "the fixture did not calculate, so the pass below has nothing to do and " +
        "this test would pass without ever emitting progress",
    ).not.toBe("");

    // ---- the race ----
    //
    // `calculate_now` is async (background thread, takes the grid locks and
    // emits progress); `get_workbook_state_digest` is synchronous (main
    // thread, reads the grid). Fired in that order, without awaiting the
    // first, so they really do overlap.
    const outcome = await appPage.evaluate(async (timeoutMs: number) => {
      const t = (
        window as unknown as {
          __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
        }
      ).__TAURI__;
      const started = Date.now();
      const calc = t.core.invoke("calculate_now", { cubeResults: null });
      // Let the pass take its locks and get far enough in to emit.
      await new Promise((r) => setTimeout(r, 120));
      const digest = t.core.invoke("get_workbook_state_digest", { options: { cellsOnly: true } });
      const both = Promise.all([calc, digest]).then(() => "completed");
      const timer = new Promise<string>((r) => setTimeout(() => r("wedged"), timeoutMs));
      const result = await Promise.race([both, timer]);
      return { result, elapsedMs: Date.now() - started };
    }, TIMEOUT_MS);

    expect(
      outcome.result,
      `DEADLOCK: a background recalculation pass and a synchronous main-thread ` +
        `command did not both finish within ${TIMEOUT_MS} ms. The pass holds ` +
        `state.grid and state.grids for its whole evaluation and emits progress ` +
        `to the WebView from inside that region; the emit needs the main thread, ` +
        `and the main thread is waiting for those locks. The app is wedged now — ` +
        `it will not recover, and every later test in this run will fail too.`,
    ).toBe("completed");

    // The app is still answering afterwards — a weaker claim than the race, but
    // it fails loudly if the process survived in a half-usable state.
    const after = await invoke<{ display?: string } | null>(appPage, "get_cell", {
      row: 0,
      col: 0,
    });
    expect(after?.display, "the backend stopped answering after the race").toBe("1");
  });
});
