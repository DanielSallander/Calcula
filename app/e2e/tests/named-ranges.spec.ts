/**
 * Named ranges E2E tests (Phase 16).
 *
 * Tests creating and using named ranges via Tauri API.
 */
import { test, expect } from "../fixtures";

test.describe("Named ranges", () => {
  test("create named range via name box", async ({ grid }) => {
    // Set up some data
    await grid.setCellValueDirect("T1", "100");
    await grid.setCellValueDirect("T2", "200");
    await grid.setCellValueDirect("T3", "300");

    // Select the range and name it via the Name Box
    await grid.selectRange("T1", "T3");
    await grid.nameBox.click();
    await grid.nameBox.fill("MyRange");
    await grid.page.keyboard.press("Enter");
    await grid.page.waitForTimeout(500);

    // Use the named range in a formula
    await grid.setCellValueDirect("U1", "=SUM(MyRange)");
    const result = await grid.getCellDisplayValue("U1");
    expect(result).toBe("600");
  });

  /**
   * D2 — a typed formula KEEPS ITS NAME, so repointing the name moves it.
   *
   * `update_cell` used to expand the name at ENTRY and store the expansion, so
   * `=RATE` landed in the cell as `$D$5`: the name was not in the document, and
   * repointing it moved nothing. This asserts the two halves of the fix on the
   * running app — the STORED formula still says the name, and changing what the
   * name points at changes the displayed value with no F9 and no Apply Names.
   *
   * sv-SE locale: no ',' in any formula here.
   */
  test("repointing a name moves the formulas that read it", async ({ grid, appPage: page }) => {
    const NAME = "E2E_RATE_LIVE";
    const invoke = async <T>(cmd: string, args: unknown = {}): Promise<T> =>
      page.evaluate(
        async ({ c, a }) => {
          const t = (
            window as unknown as {
              __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
            }
          ).__TAURI__;
          return t.core.invoke(c, a);
        },
        { c: cmd, a: args },
      ) as Promise<T>;

    try {
      await grid.setCellValueDirect("W1", "10");
      await grid.setCellValueDirect("W2", "30");

      const created = await invoke<{ success: boolean; error?: string }>("create_named_range", {
        name: NAME,
        sheetIndex: null,
        refersTo: "=$W$1",
        comment: null,
        folder: null,
      });
      expect(created.success, `create_named_range failed: ${created.error ?? ""}`).toBe(true);

      await grid.setCellValueDirect("X1", `=${NAME}*2`);
      await page.waitForTimeout(300);
      expect(await grid.getCellDisplayValue("X1")).toBe("20");

      // THE STORED FORM IS THE NAME. Reading it back through the same command
      // the formula bar uses.
      const cells = await invoke<Array<{ formula: string | null }>>("get_viewport_cells", {
        startRow: 0,
        startCol: 23,
        endRow: 0,
        endCol: 23,
      });
      expect(
        cells[0]?.formula,
        "the document must hold the NAME, not the reference it expands to",
      ).toBe(`=${NAME}*2`);

      // THE REPOINT. No F9, no Apply Names — the name change is the recalculation
      // trigger, through the shared cascade.
      const updated = await invoke<{ success: boolean; error?: string }>("update_named_range", {
        name: NAME,
        sheetIndex: null,
        refersTo: "=$W$2",
        comment: null,
        folder: null,
      });
      expect(updated.success, `update_named_range failed: ${updated.error ?? ""}`).toBe(true);
      await page.waitForTimeout(600);
      expect(
        await grid.getCellDisplayValue("X1"),
        "repointing the name must move every formula that reads it",
      ).toBe("60");

      // AND DELETING IT LEAVES EXCEL'S #NAME?, with the formula text intact.
      await invoke("delete_named_range", { name: NAME });
      await page.waitForTimeout(600);
      expect(await grid.getCellDisplayValue("X1")).toContain("NAME");
    } finally {
      await invoke("delete_named_range", { name: NAME }).catch(() => {});
    }
  });

  test("navigate to named range via name box", async ({ grid }) => {
    // Type the named range in the Name Box
    await grid.nameBox.click();
    await grid.nameBox.fill("MyRange");
    await grid.page.keyboard.press("Enter");
    await grid.page.waitForTimeout(300);

    // Should navigate to the range
    const nameBoxValue = await grid.getNameBoxValue();
    expect(nameBoxValue).toContain("MyRange");
  });
});
