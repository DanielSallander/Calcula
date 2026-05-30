/**
 * Hyperlinks E2E tests.
 *
 * Tests hyperlink CRUD operations via Tauri API commands.
 * Uses cells in columns Y-Z, rows 1-10 to avoid conflicts with other tests.
 */
import { test, expect } from "../fixtures";
import {
  takeGridScreenshot,
  softly,
} from "../helpers/screenshots";

test.describe("Hyperlinks", () => {
  test("add a URL hyperlink to a cell", async ({ appPage, grid }) => {
    await grid.setCellValueDirect("Y1", "Visit Site");
    await grid.page.waitForTimeout(200);

    // Add hyperlink via Tauri API
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("add_hyperlink", {
        params: {
          row: 0,
          col: 24,
          linkType: "url",
          target: "https://example.com",
          displayText: "Visit Site",
          tooltip: "Go to example.com",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    expect(result.success).toBe(true);
    expect(result.hyperlink).toBeDefined();
    expect(result.hyperlink.target).toBe("https://example.com");

    // Verify hyperlink can be retrieved
    const hyperlink: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_hyperlink", { row: 0, col: 24 });
    });

    expect(hyperlink).not.toBeNull();
    expect(hyperlink.linkType).toBe("url");
    expect(hyperlink.target).toBe("https://example.com");

    await grid.navigateTo("Y1");
    await softly(takeGridScreenshot(appPage, "hyperlinks-url-added"));
  });

  test("add an internal reference hyperlink", async ({ grid }) => {
    await grid.setCellValueDirect("Y2", "Go to A1");
    await grid.page.waitForTimeout(200);

    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("add_hyperlink", {
        params: {
          row: 1,
          col: 24,
          linkType: "internalReference",
          target: "Sheet1!A1",
          displayText: "Go to A1",
          cellReference: "A1",
          sheetName: "Sheet1",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    expect(result.success).toBe(true);
    expect(result.hyperlink.linkType).toBe("internalReference");
  });

  test("update a hyperlink", async ({ grid }) => {
    // First add a hyperlink
    await grid.setCellValueDirect("Y3", "Link");
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("add_hyperlink", {
        params: {
          row: 2,
          col: 24,
          linkType: "url",
          target: "https://old-url.com",
          displayText: "Link",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    // Update the hyperlink
    const updateResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("update_hyperlink", {
        params: {
          row: 2,
          col: 24,
          target: "https://new-url.com",
          displayText: "Updated Link",
          tooltip: "New tooltip",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    expect(updateResult.success).toBe(true);

    // Verify the update
    const hyperlink: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_hyperlink", { row: 2, col: 24 });
    });

    expect(hyperlink.target).toBe("https://new-url.com");
  });

  test("remove a hyperlink", async ({ grid }) => {
    // Add a hyperlink
    await grid.setCellValueDirect("Y4", "Remove Me");
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("add_hyperlink", {
        params: {
          row: 3,
          col: 24,
          linkType: "url",
          target: "https://to-remove.com",
          displayText: "Remove Me",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    // Remove the hyperlink
    const removeResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("remove_hyperlink", { row: 3, col: 24 });
    });
    await grid.page.waitForTimeout(300);

    expect(removeResult.success).toBe(true);

    // Verify it's gone
    const hyperlink: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_hyperlink", { row: 3, col: 24 });
    });

    expect(hyperlink).toBeNull();
  });

  test("hyperlink indicators are reported for cells with links", async ({
    appPage,
    grid,
  }) => {
    // Add a couple of hyperlinks
    await grid.setCellValueDirect("Y5", "Link A");
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("add_hyperlink", {
        params: {
          row: 4,
          col: 24,
          linkType: "url",
          target: "https://a.com",
          displayText: "Link A",
        },
      });
    });
    await grid.page.waitForTimeout(200);

    await grid.setCellValueDirect("Y6", "Link B");
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("add_hyperlink", {
        params: {
          row: 5,
          col: 24,
          linkType: "email",
          target: "mailto:test@example.com",
          displayText: "Link B",
        },
      });
    });
    await grid.page.waitForTimeout(200);

    // Get hyperlink indicators
    const indicators: any[] = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_hyperlink_indicators", {});
    });

    expect(indicators.length).toBeGreaterThanOrEqual(2);
    const foundA = indicators.find(
      (ind: any) => ind.row === 4 && ind.col === 24
    );
    const foundB = indicators.find(
      (ind: any) => ind.row === 5 && ind.col === 24
    );
    expect(foundA).toBeDefined();
    expect(foundB).toBeDefined();

    await grid.navigateTo("Y5");
    await softly(takeGridScreenshot(appPage, "hyperlinks-indicators-visible"));
  });
});
