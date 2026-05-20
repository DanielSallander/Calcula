/**
 * Freeze panes E2E tests (Phase 10).
 *
 * Tests freeze/unfreeze via Tauri API commands.
 * Note: Visual verification of frozen panes requires scrolling, which
 * is complex to test via CDP. These tests verify the API state.
 */
import { test, expect } from "../fixtures";

test.describe("Freeze panes", () => {
  test("freeze top row", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_freeze_panes", {
        freezeRow: 1, freezeCol: null,
      });
    });
    await grid.page.waitForTimeout(300);

    const config = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_freeze_panes");
    });
    expect(config.freezeRow).toBe(1);
    expect(config.freezeCol).toBeNull();
  });

  test("freeze first column", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_freeze_panes", {
        freezeRow: null, freezeCol: 1,
      });
    });
    await grid.page.waitForTimeout(300);

    const config = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_freeze_panes");
    });
    expect(config.freezeRow).toBeNull();
    expect(config.freezeCol).toBe(1);
  });

  test("freeze at arbitrary cell (row 3, col 2)", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_freeze_panes", {
        freezeRow: 3, freezeCol: 2,
      });
    });
    await grid.page.waitForTimeout(300);

    const config = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_freeze_panes");
    });
    expect(config.freezeRow).toBe(3);
    expect(config.freezeCol).toBe(2);
  });

  test("unfreeze panes", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("set_freeze_panes", {
        freezeRow: null, freezeCol: null,
      });
    });
    await grid.page.waitForTimeout(300);

    const config = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_freeze_panes");
    });
    expect(config.freezeRow).toBeNull();
    expect(config.freezeCol).toBeNull();
  });
});
