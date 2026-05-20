/**
 * Find & Replace E2E tests (Phase 7).
 *
 * Tests use the Tauri API directly (find_all, replace_all, replace_single)
 * since the Find dialog relies on keyboard shortcuts that WebView2 may intercept.
 *
 * Uses cells in rows 75+ to avoid collision with other phases.
 */
import { test, expect } from "../fixtures";

test.describe("Find", () => {
  test("find_all returns matching cells", async ({ grid }) => {
    await grid.setCellValue("A75", "apple");
    await grid.setCellValue("B75", "banana");
    await grid.setCellValue("C75", "apple pie");
    await grid.setCellValue("D75", "grape");

    const result = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("find_all", {
        query: "apple",
        caseSensitive: false,
        matchEntireCell: false,
        searchFormulas: false,
      });
    });

    expect(result.totalCount).toBeGreaterThanOrEqual(2);
    // Should find A75 and C75 (both contain "apple")
    const matchRows = result.matches.map((m: number[]) => m[0]);
    expect(matchRows).toContain(74); // 0-based row for row 75
  });

  test("case-sensitive find", async ({ grid }) => {
    await grid.setCellValue("A76", "Apple");
    await grid.setCellValue("B76", "apple");
    await grid.setCellValue("C76", "APPLE");

    const result = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("find_all", {
        query: "Apple",
        caseSensitive: true,
        matchEntireCell: false,
        searchFormulas: false,
      });
    });

    // Only "Apple" (A76) should match in case-sensitive mode
    const matchesInRow75 = result.matches.filter((m: number[]) => m[0] === 75);
    expect(matchesInRow75.length).toBe(1);
  });

  test("match entire cell find", async ({ grid }) => {
    await grid.setCellValue("A77", "test");
    await grid.setCellValue("B77", "testing");
    await grid.setCellValue("C77", "test");

    const result = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("find_all", {
        query: "test",
        caseSensitive: false,
        matchEntireCell: true,
        searchFormulas: false,
      });
    });

    // Only exact matches (A77, C77) — "testing" should not match
    const matchesInRow76 = result.matches.filter((m: number[]) => m[0] === 76);
    expect(matchesInRow76.length).toBe(2);
  });

  test("no matches returns empty", async ({ grid }) => {
    const result = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("find_all", {
        query: "xyznonexistent123",
        caseSensitive: false,
        matchEntireCell: false,
        searchFormulas: false,
      });
    });

    expect(result.totalCount).toBe(0);
    expect(result.matches.length).toBe(0);
  });
});

test.describe("Replace", () => {
  test("replace_all replaces all occurrences", async ({ grid }) => {
    await grid.setCellValue("A78", "old");
    await grid.setCellValue("B78", "old value");
    await grid.setCellValue("C78", "keep");

    const result = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("replace_all", {
        search: "old",
        replacement: "new",
        caseSensitive: false,
        matchEntireCell: false,
      });
    });
    await grid.page.waitForTimeout(300);

    expect(result.replacementCount).toBeGreaterThanOrEqual(2);

    // Verify replacements
    const a78 = await grid.getCellDisplayValue("A78");
    expect(a78).toBe("new");

    const b78 = await grid.getCellDisplayValue("B78");
    expect(b78).toBe("new value");

    // C78 should be unchanged
    const c78 = await grid.getCellDisplayValue("C78");
    expect(c78).toBe("keep");
  });

  test("replace_single replaces one cell", async ({ grid }) => {
    await grid.setCellValue("A79", "foo");
    await grid.setCellValue("B79", "foo");

    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("replace_single", {
        row: 78,
        col: 0,
        search: "foo",
        replacement: "bar",
        caseSensitive: false,
      });
    });
    await grid.page.waitForTimeout(300);

    // Only A79 should be replaced
    expect(await grid.getCellDisplayValue("A79")).toBe("bar");
    expect(await grid.getCellDisplayValue("B79")).toBe("foo");
  });
});
