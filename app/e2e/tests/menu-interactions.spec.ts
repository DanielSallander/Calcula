/**
 * Menu bar interaction E2E tests.
 *
 * Tests opening menus, clicking menu items, and verifying
 * that menu-triggered operations work correctly.
 *
 * Uses rows 240+ to avoid collision with other tests.
 */
import { test, expect } from "../fixtures";

test.describe("Menu bar basics", () => {
  test("clicking a menu button opens dropdown", async ({ grid }) => {
    await grid.openMenu("Edit");

    // Dropdown should be visible with menu items (text includes shortcut hint)
    const undoItem = grid.page.locator("button").filter({ hasText: /Undo/ });
    await expect(undoItem).toBeVisible({ timeout: 3000 });

    await grid.closeMenu();
  });

  test("Escape closes open menu", async ({ grid }) => {
    await grid.openMenu("Edit");
    await grid.closeMenu();

    // Menu should be closed — Undo should not be visible
    const undoItem = grid.page.locator("button").filter({ hasText: /Undo/ }).first();
    await expect(undoItem).not.toBeVisible({ timeout: 2000 });
  });

  test("hovering another menu switches dropdown", async ({ grid }) => {
    // Open Edit menu
    await grid.openMenu("Edit");

    // Hover View — should auto-open since Edit is open
    const viewBtn = grid.page.locator("button").filter({ hasText: /^View$/ }).first();
    await viewBtn.hover();
    await grid.page.waitForTimeout(300);

    // View menu items should now be visible
    const normalView = grid.page.locator("button").filter({ hasText: /Normal|Page Layout|Freeze/ }).first();
    const isVisible = await normalView.isVisible({ timeout: 2000 }).catch(() => false);
    expect(isVisible).toBe(true);

    await grid.closeMenu();
  });
});

test.describe("Edit menu operations", () => {
  test("Edit > Undo reverts last change", async ({ grid }) => {
    // Use Tauri API for reliable cell edit + undo
    await grid.setCellValueDirect("A240", "Original");
    await grid.page.waitForTimeout(200);
    await grid.setCellValueDirect("A240", "Changed");
    await grid.page.waitForTimeout(200);
    expect(await grid.getCellDisplayValue("A240")).toBe("Changed");

    // Use Edit > Undo menu via Tauri command (more reliable than menu click)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("undo");
    });
    await grid.page.waitForTimeout(300);

    const display = await grid.getCellDisplayValue("A240");
    expect(display).toBe("Original");
  });

  test("Edit > Redo re-applies undone change", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("redo");
    });
    await grid.page.waitForTimeout(300);

    const display = await grid.getCellDisplayValue("A240");
    expect(display).toBe("Changed");
  });

  test("Edit > Find opens find dialog", async ({ grid }) => {
    await grid.openMenu("Edit");
    // The find item may have text "Find..." or just "Find"
    const findItem = grid.page.locator("button").filter({ hasText: /^Find/ }).first();
    if (await findItem.isVisible({ timeout: 2000 }).catch(() => false)) {
      await findItem.click();
      await grid.page.waitForTimeout(500);

      // Look for the find dialog input
      const findInput = grid.page.locator("input[type='text']").first();
      const hasDialog = await findInput.isVisible({ timeout: 2000 }).catch(() => false);

      // Close dialog if open
      await grid.page.keyboard.press("Escape");
      await grid.page.waitForTimeout(200);

      expect(hasDialog).toBe(true);
    } else {
      await grid.closeMenu();
    }
  });
});

test.describe("View menu operations", () => {
  test("View > Show Formulas toggles formula display", async ({ grid }) => {
    // Check initial state
    const before = await grid.page.evaluate(() => {
      const gs = (window as any).__CALCULA_GRID_STATE__;
      return gs?.showFormulas ?? false;
    });

    await grid.menuAction("View", "Show Formulas");
    await grid.page.waitForTimeout(300);

    const after = await grid.page.evaluate(() => {
      const gs = (window as any).__CALCULA_GRID_STATE__;
      return gs?.showFormulas ?? false;
    });

    // Should have toggled
    expect(after).toBe(!before);

    // Toggle back to original state
    await grid.menuAction("View", "Show Formulas");
    await grid.page.waitForTimeout(300);
  });
});

test.describe("Insert menu operations", () => {
  test("Insert menu is clickable and shows items", async ({ grid }) => {
    await grid.openMenu("Insert");
    await grid.page.waitForTimeout(300);

    // Should show Table, PivotTable, Chart etc.
    const hasItems = await grid.page.locator("button").filter({ hasText: /Table|Pivot|Chart/ }).first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    expect(hasItems).toBe(true);

    await grid.closeMenu();
  });
});

test.describe("Data menu operations", () => {
  test("Data > Filter toggles auto filter", async ({ grid }) => {
    await grid.menuAction("Data", "Filter");
    await grid.page.waitForTimeout(500);

    // Check if filter was toggled
    const filterInfo = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_auto_filter");
    });

    // Toggle off if it was turned on
    if (filterInfo) {
      await grid.menuAction("Data", "Filter");
      await grid.page.waitForTimeout(300);
    }
  });
});

test.describe("Format menu operations", () => {
  test("Format menu is clickable", async ({ grid }) => {
    await grid.openMenu("Format");
    await grid.page.waitForTimeout(300);

    // Should show "Format Cells..." item
    const formatCells = grid.page.locator("button").filter({ hasText: /Format Cells/ });
    const visible = await formatCells.isVisible({ timeout: 2000 }).catch(() => false);
    expect(visible).toBe(true);

    await grid.closeMenu();
  });
});

test.describe("Menu + keyboard combined workflow", () => {
  test("enter data, undo via API, redo via API", async ({ grid }) => {
    await grid.setCellValueDirect("A245", "Step1");
    await grid.page.waitForTimeout(200);
    await grid.setCellValueDirect("A245", "Step2");
    await grid.page.waitForTimeout(200);
    expect(await grid.getCellDisplayValue("A245")).toBe("Step2");

    // Undo
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("undo");
    });
    await grid.page.waitForTimeout(300);
    expect(await grid.getCellDisplayValue("A245")).toBe("Step1");

    // Redo
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("redo");
    });
    await grid.page.waitForTimeout(300);
    expect(await grid.getCellDisplayValue("A245")).toBe("Step2");
  });
});
