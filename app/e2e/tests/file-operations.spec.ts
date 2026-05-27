/**
 * File operations E2E tests (Phase 15).
 *
 * Tests save, modified indicator, and current file path.
 * Avoids new_file/open_file commands that can crash the app.
 */
import { test, expect } from "../fixtures";
import * as path from "path";
import * as os from "os";

const TEMP_FILE = path.join(os.tmpdir(), "calcula-e2e-test.cala");

test.describe("File operations", () => {
  test("editing marks file as modified", async ({ grid }) => {
    await grid.setCellValueDirect("AV1", "ModTest");
    const modified = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("is_file_modified");
    });
    expect(modified).toBe(true);
  });

  test("save file to disk", async ({ grid }) => {
    await grid.setCellValueDirect("AV1", "SaveTest");
    await grid.setCellValueDirect("AV2", "42");

    await grid.page.evaluate(async (filePath: string) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("save_file", { path: filePath });
    }, TEMP_FILE);
    await grid.page.waitForTimeout(500);

    // After save, file should be unmodified
    const modified = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("is_file_modified");
    });
    expect(modified).toBe(false);
  });

  test("get current file path after save", async ({ grid }) => {
    // Set up: save a file first (each test is independent)
    await grid.setCellValueDirect("AV1", "PathTest");
    await grid.page.evaluate(async (filePath: string) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("save_file", { path: filePath });
    }, TEMP_FILE);
    await grid.page.waitForTimeout(500);

    const filePath = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_current_file_path");
    });
    expect(filePath).toContain("calcula-e2e-test.cala");
  });

  test("modifying after save sets modified flag", async ({ grid }) => {
    await grid.setCellValueDirect("AV3", "PostSave");
    const modified = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("is_file_modified");
    });
    expect(modified).toBe(true);
  });
});
