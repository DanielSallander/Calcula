//! FILENAME: app/e2e/soak/native-dialog-hang.spec.ts
// PURPOSE: A pile of NATIVE dialogs must not hang the walker.
//
// BUG-0039, measured 2026-08-12. A soak walk stopped printing at
// `[shrink] replay 22` and sat there. Fifteen minutes later the app was still
// answering `page.evaluate`, a screenshot showed an ordinary spreadsheet, and
// `list-app-windows.ps1` reported TWELVE visible `#32770` windows stacked on it:
//
//     TEXT:Failed to rename sheet: Sheet index 2 out of range
//
// The shrinker had recorded `sheet.rename {tabIndex: 2}` against a three-sheet
// workbook, dropped the `sheet.add` that made the third sheet, and replayed the
// rename against two — dozens of times. Nothing answered the alerts, and
// `deepResetForWalk` (a long chain of invokes inside one `page.evaluate`) had
// no timeout, so the walk burned its entire 30-minute budget in silence. A hang
// is invisible to an exit-status check.
//
// A native dialog is invisible to every other instrument here: it is a separate
// Win32 window, so it is absent from page screenshots, has no DOM, and the
// `ui-not-blocked` invariant's `elementFromPoint` hit test cannot see it.
//
// This spec rebuilds the pile deliberately and asserts the reset survives it.
// It is deliberately NOT a test that "one alert blocks IPC" — measured, one
// open alert left `get_charts` answering normally. The sweep is what keeps the
// pile from forming; the timeouts are the backstop for what the sweep cannot
// see coming.

import { test, expect } from "../fixtures";
import { WalkRunner, createTraceSource, deepResetForWalk } from "../walker";
import { ALL_INVARIANTS } from "../invariants";
import { readNativeDialogText } from "../helpers/nativeDialogs";

test.describe("native dialog handling", () => {
  test.setTimeout(600_000);

  test("a pile of native dialogs no longer hangs the reset", async ({ appPage, grid }) => {
    await deepResetForWalk(appPage);
    await appPage.waitForTimeout(400);

    // Reproduce the exact pile-up: add a sheet, then raise the out-of-range
    // rename alert twelve times, as twelve shrink replays did.
    await appPage.evaluate(() => {
      const btn = document.querySelector('button[title="Add new sheet"]');
      btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await appPage.waitForTimeout(1200);
    const tabs = await appPage.evaluate(() => document.querySelectorAll("button[data-sheet-tab]").length);
    for (let i = 0; i < 12; i++) {
      await appPage.evaluate((idx: number) => {
        window.dispatchEvent(new CustomEvent("sheet:requestRename", { detail: { index: idx, newName: "Blad_X" } }));
      }, tabs);
      await appPage.waitForTimeout(120);
    }
    await appPage.waitForTimeout(800);
    expect(readNativeDialogText(), "the pile-up did not form").toContain("out of range");

    const started = Date.now();
    await deepResetForWalk(appPage);
    const elapsed = Date.now() - started;
    console.log(`PILE reset elapsed=${elapsed}ms`);
    expect(readNativeDialogText(), "dialogs survived the reset").toBeNull();
    expect(elapsed, "the reset took longer than a healthy one").toBeLessThan(120_000);

    // And the walk that follows must be able to run at all.
    const runner = new WalkRunner(appPage, grid, {
      source: createTraceSource({ version: 1, seed: 1, startedAt: "", actions: [{ id: "cell.click", params: { ref: "A1" } }] }),
      invariants: ALL_INVARIANTS,
      oracleBattery: null,
      maxActions: 1,
      settleTimeMs: 100,
      verbose: false,
    });
    const result = await runner.run();
    console.log(`PILE walk passed=${result.passed} id=${result.violation?.invariantId ?? "-"}`);
    expect(result.passed).toBe(true);
  });
});
