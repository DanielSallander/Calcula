/**
 * Cell behaviors (granular bricks, phase 2) — e2e.
 *
 * Proves the script-tier per-cell brick end-to-end in the real worker realm:
 *  - a RESTRICTED "range" script's onClick fires when its bound cell is
 *    clicked and can write back through range.setValues (clamped, undoable)
 *  - onChange fires for edits inside the target, and the script's OWN writes
 *    never re-fire it (self-echo suppression — the classic feedback loop)
 *  - structural row inserts shift the binding target with the cells
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";

async function getCellDisplay(page: Page, row: number, col: number): Promise<string> {
  return page.evaluate(
    async (a) => {
      const tauri = (window as any).__TAURI__;
      const cell = await tauri.core.invoke("get_cell", { row: a.row, col: a.col });
      return String(cell?.display ?? "");
    },
    { row, col },
  );
}

/** Create binding + range script, mount it, and return ids for cleanup. */
async function attachBehavior(
  page: Page,
  target: { startRow: number; startCol: number; endRow: number; endCol: number },
  source: string,
  accessLevel: "restricted" | "unlocked" = "restricted",
): Promise<{ bindingId: string; scriptId: string }> {
  return page.evaluate(
    async (a) => {
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      );
      const cellBehaviors = await (window as any).__calcImport(
        new URL("/src/api/cellBehaviors.ts", document.baseURI).href,
      );
      const bindingId = crypto.randomUUID();
      const scriptId = crypto.randomUUID();
      api.ObjectScriptManager.registerScript({
        id: scriptId,
        name: "E2E Behavior",
        objectType: "range",
        instanceId: bindingId,
        source: a.source,
        accessLevel: a.accessLevel,
        description: null,
      });
      await cellBehaviors.attachCellBehavior({
        id: bindingId,
        scriptId,
        sheetIndex: 0,
        startRow: a.target.startRow,
        startCol: a.target.startCol,
        endRow: a.target.endRow,
        endCol: a.target.endCol,
      });
      await api.ObjectScriptManager.mountScript(scriptId);
      // Let the worker compile, run setup(), and register hooks.
      await new Promise((r) => setTimeout(r, 700));
      return { bindingId, scriptId };
    },
    { target, source, accessLevel: accessLevel as string },
  );
}

async function detachBehavior(page: Page, ids: { bindingId: string; scriptId: string }): Promise<void> {
  await page.evaluate(
    async (a) => {
      const api = await (window as any).__calcImport(
        new URL("/src/api/index.ts", document.baseURI).href,
      );
      const cellBehaviors = await (window as any).__calcImport(
        new URL("/src/api/cellBehaviors.ts", document.baseURI).href,
      );
      try {
        api.ObjectScriptManager.unmountScript(a.scriptId);
        api.ObjectScriptManager.removeScript(a.scriptId);
      } catch { /* best-effort */ }
      await cellBehaviors.removeCellBehavior(a.bindingId).catch(() => {});
    },
    ids,
  );
}

test.describe("Cell behaviors (range scripts)", () => {
  test("a restricted range script's onClick fires on click and writes its own cell", async ({
    appPage: page,
    grid,
  }) => {
    const ROW = 4;
    const COL = 3; // D5
    const ids = await attachBehavior(
      page,
      { startRow: ROW, startCol: COL, endRow: ROW, endCol: COL },
      `function setup(range) {
         range.onClick(function () {
           range.setValues([["clicked"]]);
         });
       }`,
    );

    try {
      await grid.clickCell("D5");
      // Interceptor -> app event -> host forwarder -> worker -> broker write.
      await page.waitForTimeout(900);
      expect(await getCellDisplay(page, ROW, COL)).toBe("clicked");
    } finally {
      await detachBehavior(page, ids);
      await page.evaluate(async (a) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("update_cell", { row: a.ROW, col: a.COL, value: "" }).catch(() => {});
      }, { ROW, COL });
    }
  });

  test("onChange fires for edits in the target and never echoes the script's own writes", async ({
    appPage: page,
    grid,
  }) => {
    const ROW = 9;
    const COL = 1; // B10
    // No self-write guard in the handler ON PURPOSE: if self-echo suppression
    // failed, this would loop ("hello!", "hello!!", ...) until the rate limit.
    const ids = await attachBehavior(
      page,
      { startRow: ROW, startCol: COL, endRow: ROW, endCol: COL },
      `function setup(range) {
         range.onChange(function (e) {
           var v = e.changes[0].newValue;
           range.setValues([[v + "!"]]);
           range.api.setCellValue(0, 0, "fired:" + v);
         });
       }`,
      "unlocked",
    );

    try {
      // Edit through the editor — CELL_VALUES_CHANGED (the onChange source)
      // fires from UI commit paths, exactly the "user edited a cell" contract.
      await grid.setCellValue("B10", "hello");
      await page.waitForTimeout(1200);

      // Exactly ONE round: the user's edit fired the handler; the handler's
      // own write into its target did not re-fire it.
      expect(await getCellDisplay(page, ROW, COL)).toBe("hello!");
      expect(await getCellDisplay(page, 0, 0)).toBe("fired:hello");
    } finally {
      await detachBehavior(page, ids);
      await page.evaluate(async (a) => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("update_cell", { row: a.ROW, col: a.COL, value: "" }).catch(() => {});
        await tauri.core.invoke("update_cell", { row: 0, col: 0, value: "" }).catch(() => {});
      }, { ROW, COL });
    }
  });

  test("row inserts shift the binding target; undo restores it", async ({ appPage: page, grid }) => {
    const ROW = 19;
    const COL = 3; // D20
    const ids = await attachBehavior(
      page,
      { startRow: ROW, startCol: COL, endRow: ROW, endCol: COL },
      `function setup(range) { /* target tracking only */ }`,
    );

    try {
      await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("insert_rows", { row: 0, count: 2 });
      });
      await page.waitForTimeout(400);

      let b = await page.evaluate(async (a) => {
        const tauri = (window as any).__TAURI__;
        return await tauri.core.invoke("get_cell_behavior", { id: a.bindingId });
      }, { bindingId: ids.bindingId });
      expect(b.startRow).toBe(ROW + 2);
      expect(b.endRow).toBe(ROW + 2);

      await grid.clickCell("A1");
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(600);

      b = await page.evaluate(async (a) => {
        const tauri = (window as any).__TAURI__;
        return await tauri.core.invoke("get_cell_behavior", { id: a.bindingId });
      }, { bindingId: ids.bindingId });
      expect(b.startRow).toBe(ROW);
    } finally {
      await detachBehavior(page, ids);
    }
  });
});
