/**
 * Print E2E tests (Phase 17).
 *
 * Tests page setup, print area, and page breaks via Tauri API.
 */
import { test, expect } from "../fixtures";

test.describe("Page setup", () => {
  test("get default page setup", async ({ grid }) => {
    const setup = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_page_setup");
    });
    expect(setup).toBeDefined();
    // Should have standard page properties
    expect(setup).toHaveProperty("orientation");
    expect(setup).toHaveProperty("paperSize");
  });

  test("set page orientation to landscape", async ({ grid }) => {
    // Get current setup first
    const setup = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_page_setup");
    });

    // Change to landscape
    setup.orientation = "landscape";
    await grid.page.evaluate(async (s: any) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_page_setup", { setup: s });
    }, setup);
    await grid.page.waitForTimeout(300);

    // Verify
    const updated = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_page_setup");
    });
    expect(updated.orientation).toBe("landscape");

    // Reset to portrait
    updated.orientation = "portrait";
    await grid.page.evaluate(async (s: any) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_page_setup", { setup: s });
    }, updated);
  });
});

test.describe("Print area", () => {
  test("set print area", async ({ grid }) => {
    const result = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("set_print_area", {
        startRow: 0, startCol: 0, endRow: 9, endCol: 4,
      });
    });
    expect(result).toBeDefined();
  });

  test("clear print area", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("clear_print_area");
    });
    // No error means success
  });
});

test.describe("Page breaks", () => {
  test("insert and remove row page break", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("insert_row_page_break", { row: 10 });
    });
    // No error means success

    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("remove_row_page_break", { row: 10 });
    });
  });

  test("reset all page breaks", async ({ grid }) => {
    // Insert a few breaks then reset
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("insert_row_page_break", { row: 5 });
      await tauri.core.invoke("insert_row_page_break", { row: 15 });
    });

    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("reset_all_page_breaks");
    });
    // No error means success
  });
});
