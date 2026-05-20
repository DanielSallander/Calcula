/**
 * Data validation E2E tests (Phase 13).
 *
 * Tests data validation rules via Tauri API.
 * Serde uses camelCase for enum variants and field names.
 * Uses cells in column V (col 21), rows 1-5.
 */
import { test, expect } from "../fixtures";

test.describe("List validation", () => {
  test("set list validation with dropdown", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_data_validation", {
        startRow: 0, startCol: 21, endRow: 0, endCol: 21,
        validation: {
          rule: { list: { source: { values: ["Apple", "Banana", "Cherry"] }, inCellDropdown: true } },
          errorAlert: { title: "Invalid", message: "Pick from list", style: "stop", showAlert: true },
          prompt: { title: "Choose", message: "Select a fruit", showPrompt: true },
          ignoreBlanks: true,
        },
      });
    });
    await grid.page.waitForTimeout(300);

    const val = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_data_validation", { row: 0, col: 21 });
    });
    expect(val).not.toBeNull();
  });

  test("dropdown returns list values", async ({ grid }) => {
    const values = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_validation_list_values", { row: 0, col: 21 });
    });
    expect(values).toContain("Apple");
    expect(values).toContain("Banana");
    expect(values).toContain("Cherry");
  });

  test("has in-cell dropdown", async ({ grid }) => {
    const hasDropdown = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("has_in_cell_dropdown", { row: 0, col: 21 });
    });
    expect(hasDropdown).toBe(true);
  });

  test("valid value passes validation", async ({ grid }) => {
    const result = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("validate_pending_value", {
        row: 0, col: 21, pendingValue: "Apple",
      });
    });
    expect(result.isValid).toBe(true);
  });

  test("invalid value fails validation", async ({ grid }) => {
    const result = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("validate_pending_value", {
        row: 0, col: 21, pendingValue: "Mango",
      });
    });
    expect(result.isValid).toBe(false);
  });
});

test.describe("Number range validation", () => {
  test("set whole number validation (1-100)", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_data_validation", {
        startRow: 1, startCol: 21, endRow: 1, endCol: 21,
        validation: {
          rule: { wholeNumber: { formula1: 1, formula2: 100, operator: "between" } },
          errorAlert: { title: "Error", message: "Enter 1-100", style: "stop", showAlert: true },
          prompt: { title: "", message: "", showPrompt: false },
          ignoreBlanks: true,
        },
      });
    });
    await grid.page.waitForTimeout(300);

    const valid = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("validate_pending_value", { row: 1, col: 21, pendingValue: "50" });
    });
    expect(valid.isValid).toBe(true);

    const invalid = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("validate_pending_value", { row: 1, col: 21, pendingValue: "200" });
    });
    expect(invalid.isValid).toBe(false);
  });
});

test.describe("Clear validation", () => {
  test("clear validation removes rules", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("clear_data_validation", {
        startRow: 0, startCol: 21, endRow: 1, endCol: 21,
      });
    });
    await grid.page.waitForTimeout(300);

    const val = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_data_validation", { row: 0, col: 21 });
    });
    expect(val).toBeNull();
  });
});
