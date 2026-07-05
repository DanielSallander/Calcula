/**
 * Cell Types (granular bricks, slice 1) — e2e.
 *
 * Proves the per-cell composition brick end-to-end:
 *  - checkbox: canvas click toggles the real TRUE/FALSE value (undoable),
 *    Space toggles via the generic cell-type keydown hook
 *  - structural edits: row inserts shift assignments WITH the cells, and ONE
 *    undo restores grid + assignments atomically (same undo transaction)
 *  - button: click fires a registered command and never enters edit mode
 *  - unknown type id: cell degrades to plain text, stays editable, tag survives
 *
 * Assignments are written through the @api wrapper (updates the frontend
 * index exactly like real UI flows); assertions read backend truth via invoke.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";

async function apiSetCellType(
  page: Page,
  row: number,
  col: number,
  typeId: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  await page.evaluate(
    async (a) => {
      const cellTypes = await (window as any).__calcImport(
        new URL("/src/api/cellTypes.ts", document.baseURI).href,
      );
      await cellTypes.setCellType(a.row, a.col, a.typeId, a.params);
    },
    { row, col, typeId, params },
  );
}

async function apiClearCellType(page: Page, row: number, col: number): Promise<void> {
  await page.evaluate(
    async (a) => {
      const cellTypes = await (window as any).__calcImport(
        new URL("/src/api/cellTypes.ts", document.baseURI).href,
      );
      await cellTypes.clearCellType(a.row, a.col);
    },
    { row, col },
  );
}

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

async function getBackendCellType(
  page: Page,
  row: number,
  col: number,
): Promise<{ typeId: string } | null> {
  return page.evaluate(
    async (a) => {
      const tauri = (window as any).__TAURI__;
      return await tauri.core.invoke("get_cell_type", { row: a.row, col: a.col });
    },
    { row, col },
  );
}

async function setCellValue(page: Page, row: number, col: number, value: string): Promise<void> {
  await page.evaluate(
    async (a) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("update_cell", { row: a.row, col: a.col, value: a.value });
    },
    { row, col, value },
  );
}

test.describe("Cell Types (granular bricks)", () => {
  test("checkbox cell toggles on click and Space, undoably", async ({ appPage: page, grid }) => {
    const ROW = 5;
    const COL = 1; // B6

    try {
      await setCellValue(page, ROW, COL, "FALSE");
      await apiSetCellType(page, ROW, COL, "calcula.checkbox");
      await page.waitForTimeout(200);

      // Click the cell center: the type's onClick claims the click and toggles.
      await grid.clickCell("B6");
      await page.waitForTimeout(500);
      expect(await getCellDisplay(page, ROW, COL)).toBe("TRUE");

      // The toggle went through the normal write path -> one undo step.
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(500);
      expect(await getCellDisplay(page, ROW, COL)).toBe("FALSE");

      // Space on the selected cell toggles via the generic keydown hook.
      await page.keyboard.press(" ");
      await page.waitForTimeout(500);
      expect(await getCellDisplay(page, ROW, COL)).toBe("TRUE");
    } finally {
      await apiClearCellType(page, ROW, COL).catch(() => {});
      await setCellValue(page, ROW, COL, "").catch(() => {});
    }
  });

  test("row inserts shift assignments; one undo restores grid + tags atomically", async ({
    appPage: page,
    grid,
  }) => {
    const ROW = 10;
    const COL = 2; // C11

    try {
      await setCellValue(page, ROW, COL, "TRUE");
      await apiSetCellType(page, ROW, COL, "calcula.checkbox");
      await page.waitForTimeout(200);

      // Insert 2 rows above -> the assignment must move with its cell.
      await page.evaluate(async () => {
        const tauri = (window as any).__TAURI__;
        await tauri.core.invoke("insert_rows", { row: 0, count: 2 });
      });
      await page.waitForTimeout(400);

      expect(await getBackendCellType(page, ROW, COL)).toBeNull();
      expect((await getBackendCellType(page, ROW + 2, COL))?.typeId).toBe("calcula.checkbox");
      expect(await getCellDisplay(page, ROW + 2, COL)).toBe("TRUE");

      // ONE undo restores both the grid and the assignment (same transaction).
      await grid.clickCell("A1");
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(600);

      expect((await getBackendCellType(page, ROW, COL))?.typeId).toBe("calcula.checkbox");
      expect(await getBackendCellType(page, ROW + 2, COL)).toBeNull();
      expect(await getCellDisplay(page, ROW, COL)).toBe("TRUE");
    } finally {
      await apiClearCellType(page, ROW, COL).catch(() => {});
      await setCellValue(page, ROW, COL, "").catch(() => {});
    }
  });

  test("button cell fires its command on click and does not enter edit mode", async ({
    appPage: page,
    grid,
  }) => {
    const ROW = 15;
    const COL = 3; // D16
    const MARKER = "button-fired";

    try {
      // Register a marker command through the public registry.
      await page.evaluate(async (a) => {
        const api = await (window as any).__calcImport(
          new URL("/src/api/index.ts", document.baseURI).href,
        );
        api.ExtensionRegistry.registerCommand({
          id: "e2e.cellTypeMarker",
          name: "E2E Cell Type Marker",
          execute: async (ctx: {
            setCellValue: (r: number, c: number, v: string) => Promise<void>;
          }) => {
            await ctx.setCellValue(0, 0, a.MARKER);
          },
        });
      }, { MARKER });

      await apiSetCellType(page, ROW, COL, "calcula.button", {
        label: "Run",
        action: { kind: "command", commandId: "e2e.cellTypeMarker" },
      });
      await page.waitForTimeout(200);

      await grid.clickCell("D16");
      await page.waitForTimeout(600);

      // The command ran...
      expect(await getCellDisplay(page, 0, 0)).toBe(MARKER);

      // ...and the click never opened the editor (editor:"none").
      const editing = await page.evaluate(async () => {
        const gridApi = await (window as any).__calcImport(
          new URL("/src/api/grid.ts", document.baseURI).href,
        );
        return gridApi.getGridStateSnapshot()?.editing ?? null;
      });
      expect(editing).toBeNull();
    } finally {
      await apiClearCellType(page, ROW, COL).catch(() => {});
      await setCellValue(page, 0, 0, "").catch(() => {});
    }
  });

  test("unknown type ids degrade to plain, editable cells with the tag preserved", async ({
    appPage: page,
    grid,
  }) => {
    const ROW = 20;
    const COL = 0; // A21

    try {
      await setCellValue(page, ROW, COL, "hello");
      await apiSetCellType(page, ROW, COL, "nope.unknown");
      await page.waitForTimeout(200);

      // Value stays visible (fallback renders the raw value + corner badge).
      expect(await getCellDisplay(page, ROW, COL)).toBe("hello");

      // The cell is fully editable — no interception from the dormant tag.
      await grid.setCellValue("A21", "world");
      await page.waitForTimeout(300);
      expect(await getCellDisplay(page, ROW, COL)).toBe("world");

      // The assignment survives, ready to reactivate if the type registers.
      expect((await getBackendCellType(page, ROW, COL))?.typeId).toBe("nope.unknown");
    } finally {
      await apiClearCellType(page, ROW, COL).catch(() => {});
      await setCellValue(page, ROW, COL, "").catch(() => {});
    }
  });
});
