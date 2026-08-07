/**
 * Row/Column Grouping E2E tests.
 *
 * Tests grouping operations (group, ungroup, collapse, expand) via Tauri API.
 * Uses cells in columns AA-AB, rows 1-20 to avoid conflicts with other tests.
 *
 * WHY THERE ARE NO SCREENSHOTS IN THIS FILE ANY MORE
 *
 * There used to be four: `grouping-rows-grouped`, `grouping-rows-collapsed`,
 * `grouping-rows-expanded` and `grouping-columns-grouped`. None of them could
 * fail for the reason its name implies, and two of them proved it outright —
 * `grouping-rows-collapsed.png` and `grouping-rows-expanded.png` were
 * BYTE-IDENTICAL (sha256 1c8a474d...), i.e. the pair asserted that collapsing
 * and expanding a group produce the same picture.
 *
 * The cause is not the framing. These tests drive the Rust commands
 * (`group_rows`, `collapse_row_group`, ...) directly, and a backend-only
 * outline change has NO effect on what is drawn. `src/api/groupingService.ts`
 * says so in its own header: only the Grouping extension's store pushes hidden
 * rows/cols into grid state and sizes the outline bar, so calling the backend
 * behind its back leaves "the grid SHOWING rows the backend now hides (and an
 * outline bar that never appears)". Measured against the running app:
 * `group_rows` on a freshly populated span changed 0 of 42k captured pixels.
 *
 * WHAT CHANGED SINCE. There IS now an event: `app:outline-changed`
 * (AppEvents.OUTLINE_CHANGED), announced by the IPC wrapper for every outline
 * mutation so that no route can forget, and dispatchable by an out-of-band
 * mutator — which is exactly what these tests are. On it the Grouping
 * extension re-reads the outline, the group-hidden row/col sets and the outline
 * bar size from the backend, which is the sync the header above says only it
 * can do. So after an `invoke("group_rows")` a test can either dispatch
 *
 *     window.dispatchEvent(new CustomEvent("app:outline-changed"))
 *
 * or, better, drive the operation through the seam the extension publishes:
 *
 *     const gs = await window.__calcImport(
 *       new URL("/src/api/groupingService.ts", document.baseURI).href);
 *     await gs.requireGroupingController().groupRows(0, 2);
 *
 * — which resolves only once the grid, the outline bar and the backend agree,
 * so no arbitrary wait is needed. Restoring the four goldens is a follow-on:
 * re-record them against one of those paths, and note that
 * `grouping-rows-collapsed` and `grouping-rows-expanded` must now DIFFER (they
 * were byte-identical before, which is what exposed this). The functional
 * assertions below are untouched and do have teeth — they check the backend's
 * own return values.
 */
import { test, expect } from "../fixtures";

test.describe("Row Grouping", () => {
  test("group rows and verify outline", async ({ grid }) => {
    // Set up data in rows 1-5
    for (let i = 1; i <= 5; i++) {
      await grid.setCellValueDirect(`AA${i}`, `Row ${i}`);
    }
    await grid.page.waitForTimeout(200);

    // Group rows 1-3 (0-based: rows 0-2) via Tauri API
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("group_rows", {
        params: { startRow: 0, endRow: 2 },
      });
    });
    await grid.page.waitForTimeout(500);

    expect(result.success).toBe(true);

  });

  test("collapse and expand row group", async ({ grid }) => {
    // Group rows 5-8 (0-based: rows 4-7)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("group_rows", {
        params: { startRow: 4, endRow: 7 },
      });
    });
    await grid.page.waitForTimeout(500);

    // Collapse the group
    const collapseResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("collapse_row_group", { row: 7 });
    });
    await grid.page.waitForTimeout(500);

    expect(collapseResult.success).toBe(true);


    // Expand the group
    const expandResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("expand_row_group", { row: 7 });
    });
    await grid.page.waitForTimeout(500);

    expect(expandResult.success).toBe(true);

  });

  test("ungroup rows", async ({ grid }) => {
    // Group rows 10-12 (0-based: rows 9-11)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("group_rows", {
        params: { startRow: 9, endRow: 11 },
      });
    });
    await grid.page.waitForTimeout(300);

    // Ungroup the same rows
    const ungroupResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("ungroup_rows", { startRow: 9, endRow: 11 });
    });
    await grid.page.waitForTimeout(300);

    expect(ungroupResult.success).toBe(true);
  });
});

test.describe("Column Grouping", () => {
  test("group and ungroup columns", async ({ grid }) => {
    // Group columns AB-AD (0-based: cols 27-29)
    const groupResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("group_columns", {
        params: { startCol: 27, endCol: 29 },
      });
    });
    await grid.page.waitForTimeout(500);

    expect(groupResult.success).toBe(true);


    // Ungroup
    const ungroupResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("ungroup_columns", { startCol: 27, endCol: 29 });
    });
    await grid.page.waitForTimeout(300);

    expect(ungroupResult.success).toBe(true);
  });
});
