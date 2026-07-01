import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * Read a cell's current DISPLAY value straight from the backend (get_cell), so
 * we assert on the source of truth without clicking cells (avoids selection
 * drift) and without dependent-display staleness.
 */
async function cellDisplay(page: Page, row: number, col: number): Promise<string> {
  return page.evaluate(
    async ({ r, c }) => {
      const t = (window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } } }).__TAURI__;
      const cell = (await t.core.invoke("get_cell", { row: r, col: c })) as { display?: string } | null;
      return String(cell?.display ?? "");
    },
    { r: row, c: col },
  );
}

test.describe("Animation extension", () => {
  test("clock-cell driver steps write transiently, recalc dependents, and stop restores", async ({ grid }) => {
    const page = grid.page;

    // 1. Model: A1 = 7 (the driver cell), B1 = A1*2 (a dependent formula).
    await grid.setCellValueDirect("A1", "7");
    await grid.setCellValueDirect("B1", "=A1*2");
    expect(await cellDisplay(page, 0, 0)).toBe("7");
    expect(await cellDisplay(page, 0, 1)).toBe("14");

    // 2. Open the Animation panel via View ▸ Animation Timeline.
    await grid.openMenu("View");
    await grid.clickMenuItem("Animation Timeline");
    await expect(page.locator('[data-testid="anim-driver-cell"]')).toBeVisible({ timeout: 8000 });

    // 3. Configure a clock-cell driver: sweep A1 from 0 → 10 by 1 (11 frames).
    await page.locator('[data-testid="anim-driver-cell"]').fill("A1");
    await page.locator('[data-testid="anim-from"]').fill("0");
    await page.locator('[data-testid="anim-to"]').fill("10");
    await page.locator('[data-testid="anim-step"]').fill("1");
    await page.locator('[data-testid="anim-set-driver"]').click();
    await expect(page.locator('[data-testid="anim-frame"]')).toHaveText("1 / 11", { timeout: 5000 });

    // 4. Stepping writes the driver value transiently AND recalculates the dependent.
    await page.locator('button[title="Step forward"]').click();
    await expect.poll(() => cellDisplay(page, 0, 0), { timeout: 5000 }).toBe("1");
    expect(await cellDisplay(page, 0, 1)).toBe("2"); // B1 = A1*2 = 2

    await page.locator('button[title="Step forward"]').click();
    await expect.poll(() => cellDisplay(page, 0, 0), { timeout: 5000 }).toBe("2");
    expect(await cellDisplay(page, 0, 1)).toBe("4");

    // 5. Play advances the model to the end of the range.
    await page.locator('button[title="Play"]').click();
    await expect.poll(() => cellDisplay(page, 0, 0), { timeout: 8000 }).toBe("10");

    // 6. Stop RESTORES the model to its original values — the transient guarantee.
    await page.locator('button[title="Stop (reset)"]').click();
    await expect.poll(() => cellDisplay(page, 0, 0), { timeout: 5000 }).toBe("7");
    expect(await cellDisplay(page, 0, 1)).toBe("14");
  });
});
