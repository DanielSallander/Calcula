/**
 * Text alignment and cell options E2E tests.
 *
 * Tests alignment buttons, wrap text, indent, and text colors
 * via ribbon buttons and Tauri API.
 *
 * Uses cells in rows 1-10, columns AM-AQ.
 */
import { test, expect } from "../fixtures";

test.describe("Text alignment", () => {
  test("align left", async ({ grid }) => {
    await grid.setCellValueDirect("AM1", "Left");
    await grid.clickCell("AM1");
    await grid.clickFormatButton("alignLeft");

    const align = await grid.getCellStyleStringProp("AM1", "textAlign");
    expect(align).toBe("left");
  });

  test("align center", async ({ grid }) => {
    await grid.setCellValueDirect("AM2", "Center");
    await grid.clickCell("AM2");
    await grid.clickFormatButton("alignCenter");

    const align = await grid.getCellStyleStringProp("AM2", "textAlign");
    expect(align).toBe("center");
  });

  test("align right", async ({ grid }) => {
    await grid.setCellValueDirect("AM3", "Right");
    await grid.clickCell("AM3");
    await grid.clickFormatButton("alignRight");

    const align = await grid.getCellStyleStringProp("AM3", "textAlign");
    expect(align).toBe("right");
  });

  test("toggle alignment off reverts to general", async ({ grid }) => {
    await grid.setCellValueDirect("AM4", "General");
    await grid.clickCell("AM4");
    await grid.clickFormatButton("alignCenter");
    await grid.clickFormatButton("alignCenter"); // toggle off

    const align = await grid.getCellStyleStringProp("AM4", "textAlign");
    expect(align).toBe("general");
  });
});

test.describe("Wrap text", () => {
  test("toggle wrap text on", async ({ grid }) => {
    await grid.setCellValueDirect("AN1", "Wrap me please this is a long text");
    await grid.clickCell("AN1");
    await grid.clickFormatButton("wrapText");

    const wrap = await grid.getCellStyleProp("AN1", "wrapText");
    expect(wrap).toBe(true);
  });

  test("toggle wrap text off", async ({ grid }) => {
    await grid.clickCell("AN1");
    await grid.clickFormatButton("wrapText");

    const wrap = await grid.getCellStyleProp("AN1", "wrapText");
    expect(wrap).toBe(false);
  });
});

test.describe("Indent", () => {
  test("increase indent via Tauri API", async ({ grid }) => {
    await grid.setCellValueDirect("AO1", "Indented");
    // Apply indent directly via Tauri API (ribbon button may be in collapsed group)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("apply_formatting", {
        params: { rows: [0], cols: [40], indent: 1 },
      });
    });
    await grid.page.waitForTimeout(300);

    const indent = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const cell = await tauri.core.invoke("get_cell", { row: 0, col: 40 });
      if (!cell) return 0;
      const style = await tauri.core.invoke("get_style", { index: cell.styleIndex });
      return style?.indent ?? 0;
    });
    expect(indent).toBe(1);
  });

  test("decrease indent via Tauri API", async ({ grid }) => {
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("apply_formatting", {
        params: { rows: [0], cols: [40], indent: 0 },
      });
    });
    await grid.page.waitForTimeout(300);

    const indent = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const cell = await tauri.core.invoke("get_cell", { row: 0, col: 40 });
      if (!cell) return 0;
      const style = await tauri.core.invoke("get_style", { index: cell.styleIndex });
      return style?.indent ?? 0;
    });
    expect(indent).toBe(0);
  });
});

test.describe("Cell colors", () => {
  test("apply text color via Tauri API", async ({ grid }) => {
    await grid.setCellValueDirect("AP1", "Red Text");
    // Apply formatting directly via Tauri API
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("apply_formatting", {
        params: {
          rows: [0], cols: [41],
          textColor: "#ff0000",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    const color = await grid.getCellStyleStringProp("AP1", "textColor");
    expect(color.toLowerCase()).toBe("#ff0000");
  });

  test("apply background color via Tauri API", async ({ grid }) => {
    await grid.setCellValueDirect("AQ1", "Yellow BG");
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("apply_formatting", {
        params: {
          rows: [0], cols: [42],
          backgroundColor: "#ffff00",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    const color = await grid.getCellStyleStringProp("AQ1", "backgroundColor");
    expect(color.toLowerCase()).toBe("#ffff00");
  });
});
