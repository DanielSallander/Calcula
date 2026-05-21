/**
 * Undo/Redo E2E tests via Tauri API.
 *
 * WebView2 intercepts Ctrl+Z/Y, so we use the Tauri undo/redo commands
 * directly to test the undo stack.
 */
import { test, expect } from "../fixtures";

test.describe("Undo/Redo via Tauri API", () => {
  test("undo reverts cell edit", async ({ grid }) => {
    // Clear the cell first
    await grid.setCellValueDirect("AU1", "");
    await grid.page.waitForTimeout(200);

    // Edit the cell
    await grid.setCellValueDirect("AU1", "BeforeUndo");
    await grid.page.waitForTimeout(200);

    // Undo
    const result = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("undo");
    });
    await grid.page.waitForTimeout(300);

    // Cell should be reverted
    const display = await grid.getCellDisplayValue("AU1");
    expect(display).not.toBe("BeforeUndo");
  });

  test("redo re-applies undone edit", async ({ grid }) => {
    // After the undo above, redo should bring back the value
    const result = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("redo");
    });
    await grid.page.waitForTimeout(300);

    const display = await grid.getCellDisplayValue("AU1");
    expect(display).toBe("BeforeUndo");
  });

  test("undo formatting change", async ({ grid }) => {
    await grid.setCellValueDirect("AU2", "FormatUndo");
    await grid.clickCell("AU2");
    await grid.toggleBold();
    expect(await grid.getCellStyleProp("AU2", "bold")).toBe(true);

    // Undo the bold
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("undo");
    });
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellStyleProp("AU2", "bold")).toBe(false);
  });

  test("multiple undos work in sequence", async ({ grid }) => {
    await grid.setCellValueDirect("AU3", "Step1");
    await grid.page.waitForTimeout(100);
    await grid.setCellValueDirect("AU3", "Step2");
    await grid.page.waitForTimeout(100);
    await grid.setCellValueDirect("AU3", "Step3");
    await grid.page.waitForTimeout(100);

    // Undo twice
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("undo");
      await tauri.core.invoke("undo");
    });
    await grid.page.waitForTimeout(300);

    const display = await grid.getCellDisplayValue("AU3");
    expect(display).toBe("Step1");
  });
});
