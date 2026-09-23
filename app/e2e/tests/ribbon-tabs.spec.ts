/**
 * Ribbon & Home Tab E2E tests.
 *
 * Tests ribbon tab navigation, Home tab formatting buttons,
 * and ribbon minimize/expand behavior.
 *
 * Uses cells in columns W-X, rows 1-10 to avoid collision.
 *
 * UNDO STATE IS PART OF EVERY RIBBON GOLDEN NOW. The Home tab's Undo and Redo
 * buttons follow real undo/redo availability (they are greyed out on an empty
 * stack, as Excel greys them), so a capture taken after a spec that ran
 * `new_file` photographs two greyed buttons and one taken mid-suite photographs
 * two live ones. That is a property of the shared app, not of the ribbon, so
 * `beforeEach` puts the stack in a KNOWN state instead of leaving the goldens to
 * whatever ran before them.
 */
import { test, expect } from "../fixtures";
import {
  takeRibbonScreenshot,
  takeCheckpoint,
  softly,
} from "../helpers/screenshots";

/**
 * Guarantee at least one undo entry, so Undo renders enabled in every capture
 * below and Redo renders disabled.
 *
 * One write to a scratch cell this spec already owns (X10 is inside its
 * declared W-X / rows 1-10 block). It is deliberately NOT undone afterwards: an
 * undo would push the entry onto the REDO stack and light the other button up,
 * which is the same non-determinism from the other side.
 */
async function pinUndoState(grid: { setCellValueDirect(ref: string, value: string): Promise<void> }): Promise<void> {
  await grid.setCellValueDirect("X10", "ribbon-undo-anchor");
}

test.describe("Ribbon tab navigation", () => {
  test.beforeEach(async ({ grid }) => {
    await pinUndoState(grid);
  });

  test("Home tab is visible and active by default", async ({
    appPage,
    grid,
  }) => {
    // The ribbon should have tab buttons rendered
    const tabButtons = appPage.locator("button").filter({ hasText: /Home/i });
    const homeTabCount = await tabButtons.count();
    expect(homeTabCount).toBeGreaterThan(0);

    await softly(takeRibbonScreenshot(appPage, "home-tab-default"));
  });

  test("switching between ribbon tabs", async ({ appPage, grid }) => {
    // Find and list all tab buttons in the ribbon header area
    // Tab buttons are children of the flex row above ribbon content
    const allButtons = appPage.locator("button");
    const buttonCount = await allButtons.count();

    // Collect tab names from the ribbon header
    const tabNames: string[] = [];
    for (let i = 0; i < buttonCount; i++) {
      const btn = allButtons.nth(i);
      const text = await btn.textContent();
      const parent = btn.locator("..");
      // Tab buttons are in the ribbon tab header area
      if (
        text &&
        ["Home", "Insert", "Page Layout", "Formulas", "Data", "View"].includes(
          text.trim()
        )
      ) {
        tabNames.push(text.trim());
      }
    }

    // Should have at least Home and one other tab
    expect(tabNames.length).toBeGreaterThanOrEqual(1);

    // If there's more than one tab, click through them
    if (tabNames.length >= 2) {
      // Click the second tab
      const secondTab = appPage
        .locator("button")
        .filter({ hasText: tabNames[1] })
        .first();
      await secondTab.click();
      await appPage.waitForTimeout(300);

      await softly(
        takeRibbonScreenshot(appPage, `ribbon-tab-${tabNames[1].toLowerCase().replace(/\s/g, "-")}`)
      );

      // Click back to Home
      const homeTab = appPage
        .locator("button")
        .filter({ hasText: "Home" })
        .first();
      await homeTab.click();
      await appPage.waitForTimeout(300);

      await softly(takeRibbonScreenshot(appPage, "ribbon-tab-home-restored"));
    }
  });

  test("ribbon contains formatting buttons on Home tab", async ({
    appPage,
    grid,
  }) => {
    // Ensure Home tab is active
    const homeTab = appPage
      .locator("button")
      .filter({ hasText: "Home" })
      .first();
    if ((await homeTab.count()) > 0) {
      await homeTab.click();
      await appPage.waitForTimeout(300);
    }

    // Check for core formatting buttons by data-testid
    const boldBtn = appPage.locator('[data-testid="fmt-bold"]');
    const italicBtn = appPage.locator('[data-testid="fmt-italic"]');
    const underlineBtn = appPage.locator('[data-testid="fmt-underline"]');

    expect(await boldBtn.count()).toBeGreaterThan(0);
    expect(await italicBtn.count()).toBeGreaterThan(0);
    expect(await underlineBtn.count()).toBeGreaterThan(0);

    // Verify copy/paste buttons exist
    const copyBtn = appPage.locator('[data-testid="fmt-copy"]');
    const pasteBtn = appPage.locator('[data-testid="fmt-paste"]');
    expect(await copyBtn.count()).toBeGreaterThan(0);
    expect(await pasteBtn.count()).toBeGreaterThan(0);

    await softly(takeRibbonScreenshot(appPage, "home-tab-buttons"));
  });

  test("ribbon minimize and expand via Ctrl+F1", async ({
    appPage,
    grid,
  }) => {
    // PIN THE SELECTION **AND WHAT IS IN IT**. The window-framed capture below
    // contains the Name Box, the FORMULA BAR and the status bar, all three of
    // which render the current selection — so without this the golden carries
    // whatever cell the previous ~450 tests left selected, which is the
    // `clickCell` drift this suite has already documented.
    //
    // Pinning only the selection is not enough, and recording it proved that:
    // the first attempt navigated to W1, and W1 is written to `"Bold"` by the
    // LAST test in this very file. In a single ordered run that test has not
    // run yet, so W1 is empty and the golden looked stable; re-record the file
    // twice, or run this test alone after a full pass, and the formula bar
    // reads "Bold" instead. A golden that depends on the file having been run
    // exactly once is the residue trap §3ar refused to walk into, one level in.
    //
    // X9 is inside this spec's declared W-X / rows 1-10 block and is touched by
    // nothing else, and it is given a KNOWN value rather than assumed empty —
    // "nothing ever writes here" is an assumption, "this is what is here" is not.
    await grid.setCellValueDirect("X9", "ribbon-pin");
    await grid.navigateTo("X9");

    // Take baseline screenshot
    await softly(takeRibbonScreenshot(appPage, "ribbon-before-minimize"));

    // Get initial ribbon content height
    const ribbonContent = appPage.locator("[data-ribbon-content]").first();
    const initiallyVisible =
      (await ribbonContent.count()) > 0 &&
      (await ribbonContent.isVisible());

    // Press Ctrl+F1 to minimize
    await appPage.keyboard.press("Control+F1");
    await appPage.waitForTimeout(500);

    try {
      // The ribbon content should be hidden now
      if (initiallyVisible) {
        const contentAfterMinimize = appPage.locator("[data-ribbon-content]").first();
        const minimizedDisplay = await contentAfterMinimize.evaluate(
          (el) => window.getComputedStyle(el).display
        );
        expect(minimizedDisplay).toBe("none");

        // THE GRID IS MASKED OUT OF THIS FRAME, and that is the whole point.
        //
        // This is the one capture in the file that is not a ribbon-element
        // shot: the golden is 1280x800 (the window) where every other one is
        // 1280x136 (the ribbon). §3ar REFUSED to re-record it for that reason —
        // its diff was grid CONTENT left behind by whichever of the ~450
        // preceding tests ran last, so recording it would have frozen one run's
        // residue into the baseline. D5 later cropped GRID captures to the
        // canvas layer, which does nothing here, because `takeCheckpoint`
        // without a target photographs the window. Measured, not assumed: the
        // committed baseline really is 1280x800.
        //
        // Masking the grid area removes the residue by CONSTRUCTION while
        // keeping what the full-window frame was for — that collapsing the
        // ribbon moves the grid area UP and makes it taller, which a
        // ribbon-only capture cannot show. The mask is a solid rectangle, so
        // the grid's geometry is still in frame and its contents are not.
        await softly(
          takeCheckpoint(appPage, "ribbon-minimized", {
            mask: [appPage.locator("[data-grid-area]")],
          })
        );
      }
    } finally {
      // Always re-expand, even if the assertion/screenshot above threw.
      // The app instance is shared across all tests, so leaving the ribbon
      // minimized here would cascade failures into every subsequent test.
      await appPage.keyboard.press("Control+F1");
      await appPage.waitForTimeout(500);
    }

    // Ribbon content should be visible again
    if (initiallyVisible) {
      const contentAfterExpand = appPage.locator("[data-ribbon-content]").first();
      const expandedDisplay = await contentAfterExpand.evaluate(
        (el) => window.getComputedStyle(el).display
      );
      expect(expandedDisplay).not.toBe("none");

      await softly(takeRibbonScreenshot(appPage, "ribbon-after-expand"));
    }
  });

  test("formatting buttons reflect active cell state", async ({
    appPage,
    grid,
  }) => {
    // Set up a bold cell and a plain cell
    await grid.setCellValueDirect("W1", "Bold");
    await grid.clickCell("W1");
    await grid.toggleBold();
    await grid.page.waitForTimeout(200);

    await grid.setCellValueDirect("W2", "Plain");
    await grid.page.waitForTimeout(200);

    // Click the bold cell - bold button should reflect active state
    await grid.clickCell("W1");
    await grid.page.waitForTimeout(300);
    expect(await grid.isFormatActive("bold")).toBe(true);

    // Click the plain cell - bold button should not be active
    await grid.clickCell("W2");
    await grid.page.waitForTimeout(300);
    expect(await grid.isFormatActive("bold")).toBe(false);

    await softly(takeRibbonScreenshot(appPage, "ribbon-format-state"));
  });
});

/**
 * The Calcula Clusters goldens for tabs other than Home.
 *
 * Page Layout is a standing tab. Table Design is CONTEXTUAL: it exists only
 * while the cursor is inside a table, so the test makes one inside this spec's
 * own W-X block (W4:X7), captures, and deletes it through the store — the
 * route the product's own Delete Table takes. The table NAME is masked: names
 * count up across the whole suite ("Table7" after seven tables anywhere), so it
 * is session residue, not chrome.
 */
/** Captions of the band's cells, in order (the caption is each cell's last
 *  child, for an inline cluster AND for one folded into a launcher). */
async function bandCaptions(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-ribbon-content] [data-section-cell]")).map(
      (cell) => (cell.lastElementChild?.textContent ?? "").trim(),
    ),
  );
}

/* eslint-disable @typescript-eslint/naming-convention -- the dev-server import hook the app installs */
type ImportWindow = Window & { __calcImport: (url: string) => Promise<unknown> };
/* eslint-enable @typescript-eslint/naming-convention */

test.describe("Ribbon tabs beyond Home (Calcula Clusters)", () => {
  test.beforeEach(async ({ grid }) => {
    await pinUndoState(grid);
  });

  test("Page Layout band", async ({ appPage }) => {
    const tab = appPage
      .locator("[data-ribbon-content]")
      .locator("xpath=..")
      .locator("div")
      .first()
      .locator("button")
      .filter({ hasText: /^Page Layout$/ });
    test.skip((await tab.count()) === 0, "no Page Layout tab is registered in this build");
    await tab.click();
    await appPage.waitForTimeout(300);
    await softly(takeRibbonScreenshot(appPage, "page-layout"));
    await appPage
      .locator("[data-ribbon-content]")
      .locator("xpath=..")
      .locator("div")
      .first()
      .locator("button")
      .filter({ hasText: /^Home$/ })
      .click();
  });

  test("Table Design band (contextual)", async ({ appPage, grid }) => {
    const rows: Array<[string, string]> = [
      ["Region", "Sales"],
      ["North", "120"],
      ["South", "80"],
      ["West", "95"],
    ];
    for (let i = 0; i < rows.length; i++) {
      await grid.setCellValueDirect(`W${4 + i}`, rows[i][0]);
      await grid.setCellValueDirect(`X${4 + i}`, rows[i][1]);
    }
    const tableId = await appPage.evaluate(async () => {
      const store = (await (window as unknown as ImportWindow).__calcImport(
        new URL("/extensions/Table/lib/tableStore.ts", document.baseURI).href,
      )) as {
        createTableAsync: (o: Record<string, unknown>) => Promise<{ id: number | string } | null>;
      };
      const t = await store.createTableAsync({
        sheetIndex: 0,
        startRow: 3,
        startCol: 22,
        endRow: 6,
        endCol: 23,
        hasHeaders: true,
      });
      if (t) window.dispatchEvent(new CustomEvent("app:table-created", { detail: { tableId: t.id } }));
      return t ? String(t.id) : null;
    });
    expect(tableId, "the table must have been created").not.toBeNull();
    try {
      await appPage.waitForTimeout(800);
      await grid.clickCell("W5");
      const tab = appPage
        .locator("[data-ribbon-content]")
        .locator("xpath=..")
        .locator("div")
        .first()
        .locator("button")
        .filter({ hasText: /^Table Design$/ });
      await expect(tab, "a cursor inside a table registers Table Design").toHaveCount(1, { timeout: 8000 });
      await tab.click();
      // Wait for the band by its captions, not by one control: at the 1280
      // harness width the low-priority clusters (Properties first) fold into
      // launchers, and their controls are then not in the band at all.
      await expect
        .poll(() => bandCaptions(appPage), { timeout: 8000 })
        .toEqual(expect.arrayContaining(["Properties", "Table Style Options", "Table Styles"]));
      // No native <select> survived in the band.
      expect(await appPage.locator("[data-ribbon-content] select").count()).toBe(0);
      await softly(
        takeRibbonScreenshot(appPage, "table-design", {
          mask: [appPage.getByTestId("table-design-name")],
        }),
      );
    } finally {
      await appPage.evaluate(async (id) => {
        const store = (await (window as unknown as ImportWindow).__calcImport(
          new URL("/extensions/Table/lib/tableStore.ts", document.baseURI).href,
        )) as { deleteTableAsync: (id: unknown) => Promise<boolean> };
        // The same call, with the same string id, BUG-0051's journey makes.
        if (id !== null) await store.deleteTableAsync(id);
      }, tableId);
      for (let i = 0; i < rows.length; i++) {
        await grid.setCellValueDirect(`W${4 + i}`, "");
        await grid.setCellValueDirect(`X${4 + i}`, "");
      }
      await appPage.waitForTimeout(500);
    }
  });

  // The Sparkline tab gained its accent colour and was rebuilt on the
  // primitives (type pill, marker checkboxes, style strip, colour swatches)
  // without ever being looked at live. Its data lives in BG1:BJ1 with the
  // sparkline in BK1 (cols 58-62), a block nothing else in the tree writes.
  test("Sparkline band (contextual)", async ({ appPage, grid }) => {
    const values = ["10", "25", "15", "30"];
    const dataCols = ["BG", "BH", "BI", "BJ"];
    for (let i = 0; i < values.length; i++) {
      await grid.setCellValueDirect(`${dataCols[i]}1`, values[i]);
    }
    const groupId = await appPage.evaluate(() => {
      const api = (window as unknown as Record<string, {
        createSparklineGroup: (
          location: Record<string, number>,
          source: Record<string, number>,
          kind: string,
        ) => { valid: boolean; group?: { id: number } };
      } | undefined>)["__CALCULA_SPARKLINES__"];
      if (!api) return null;
      const result = api.createSparklineGroup(
        { startRow: 0, startCol: 62, endRow: 0, endCol: 62 },
        { startRow: 0, startCol: 58, endRow: 0, endCol: 61 },
        "line",
      );
      return result.group?.id ?? null;
    });
    expect(groupId, "the Sparklines extension must expose its create API").not.toBeNull();
    try {
      await grid.navigateTo("BK1");
      const tab = appPage
        .locator("[data-ribbon-content]")
        .locator("xpath=..")
        .locator("div")
        .first()
        .locator("button")
        .filter({ hasText: /^Sparkline$/ });
      await expect(tab, "a cursor on a sparkline cell registers the Sparkline tab").toHaveCount(1, {
        timeout: 8000,
      });
      await tab.click();
      await expect
        .poll(() => bandCaptions(appPage), { timeout: 8000 })
        .toEqual(expect.arrayContaining(["Sparkline", "Type", "Show", "Style", "Axis", "Group"]));
      expect(await appPage.locator("[data-ribbon-content] select").count()).toBe(0);
      await softly(takeRibbonScreenshot(appPage, "sparkline-design"));
    } finally {
      await appPage.evaluate((id) => {
        const api = (window as unknown as Record<string, {
          removeSparklineGroup: (id: number) => boolean;
        } | undefined>)["__CALCULA_SPARKLINES__"];
        if (api && id !== null) api.removeSparklineGroup(id);
      }, groupId);
      for (const col of dataCols) await grid.setCellValueDirect(`${col}1`, "");
      await grid.navigateTo("A1");
      await appPage.waitForTimeout(500);
    }
  });
});
