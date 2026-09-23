/**
 * CHART DESIGN RIBBON — the Calcula Clusters rebuild of the contextual tab,
 * proved in the running app.
 *
 * The tab went from fourteen hand-rolled sections (native <select>s, a checkbox
 * grid, a position:fixed JSON overlay) to six clusters built only from
 * @api/layout primitives: Type, Elements, [Layout — axis charts only], Style,
 * Data, Actions. jsdom renders every one of them (chartDesignSections.test.tsx)
 * but cannot see three things this file checks live:
 *
 *   1. that the SHELL actually lays the six clusters out in the 100px band, in
 *      order, each with its caption as the cell's last element — or as a
 *      launcher whose caption still names it;
 *   2. that the popovers portal, open and close on Escape against the real
 *      document (the band clips overflow, so an in-band dropdown is invisible);
 *   3. that a type switch that keeps the section set (bar -> line) re-renders
 *      the SAME tab and cells instead of remounting them — the flash the old
 *      band showed on nearly every type change.
 *
 * THE WIDTH CLAIM IS PROVED THE D6 WAY. The harness is one CDP-attached app
 * window at 1280 and cannot resize it. So the cluster widths the renderer
 * MEASURED here are fed to the renderer's own `computeWidthDemotions` at other
 * band widths: the answer is the renderer's answer, from real pixels, at a
 * width the window cannot take.
 *
 * DATA lives in BD1:BE7 (cols 55-56). Nothing else in the tree writes there.
 * The test creates and deletes its own chart, and leaves no task pane open.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { softly, takeRibbonScreenshot } from "../helpers/screenshots";

/* eslint-disable @typescript-eslint/naming-convention */
type AppWindow = Window & {
  __calcImport: (url: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __CALCULA_CHARTS__?: {
    selectChart: (id: string) => void;
    deselectChart?: () => void;
    deleteChart?: (id: string) => boolean;
  };
  __CALCULA_PANEL_REGISTRY__?: {
    getPanel: (id: string) => { sections: Array<{ id: string; label: string; collapsePriority?: number; ribbonPresentation?: string }> } | undefined;
  };
};
/* eslint-enable @typescript-eslint/naming-convention */

const CHART_STORE = "/extensions/Charts/lib/chartStore.ts";
const SECTION_RENDERERS = "/src/shell/components/SectionRenderers.tsx";
const SECTION_FIT = "/src/shell/components/useSectionFit.ts";
const SECTION_CHROME = "/src/shell/components/SectionChrome.tsx";

const PANEL_ID = "chart-design";
const AXIS_CLUSTERS = ["Type", "Elements", "Layout", "Style", "Data", "Actions"];
const RADIAL_CLUSTERS = ["Type", "Elements", "Style", "Data", "Actions"];

const CAT_COL = "BD";
const VAL_COL = "BE";
const CAT_COL_INDEX = 55;
const VAL_COL_INDEX = 56;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
const UNITS = [12, 30, 22, 41, 18, 27];

async function installAppImport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as AppWindow;
    if (w.__appImport) return;
    w.__appImport = async (modulePath: string) => {
      const entries = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((n) => {
          try {
            return new URL(n).pathname === modulePath;
          } catch {
            return false;
          }
        });
      entries.sort();
      const url = entries.length > 0 ? entries[entries.length - 1] : new URL(modulePath, document.baseURI).href;
      return w.__calcImport(url);
    };
  });
}

async function seedData(grid: { setCellValueDirect: (ref: string, value: string) => Promise<void> }): Promise<void> {
  await grid.setCellValueDirect(`${CAT_COL}1`, "Month");
  await grid.setCellValueDirect(`${VAL_COL}1`, "Units");
  for (let i = 0; i < MONTHS.length; i++) {
    await grid.setCellValueDirect(`${CAT_COL}${i + 2}`, MONTHS[i]);
    await grid.setCellValueDirect(`${VAL_COL}${i + 2}`, String(UNITS[i]));
  }
}

async function makeChart(page: Page, mark: string): Promise<string> {
  return page.evaluate(
    async ({ mark, mod, data }) => {
      const store = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        createChart: (spec: unknown, placement: Record<string, unknown>) => { chartId: string };
        syncChartRegions: () => void;
      };
      const created = store.createChart(
        {
          mark,
          data,
          hasHeaders: true,
          seriesOrientation: "columns",
          categoryIndex: 0,
          series: [{ sourceIndex: 1, name: "Units", color: "#4472C4" }],
        },
        { sheetIndex: 0, x: 80, y: 60, width: 420, height: 260, name: "Clusters proof" },
      );
      store.syncChartRegions();
      return created.chartId;
    },
    {
      mark,
      mod: CHART_STORE,
      data: { sheetIndex: 0, startRow: 0, startCol: CAT_COL_INDEX, endRow: MONTHS.length, endCol: VAL_COL_INDEX },
    },
  );
}

async function selectChart(page: Page, chartId: string): Promise<void> {
  await page.evaluate((id: string) => (window as unknown as AppWindow).__CALCULA_CHARTS__?.selectChart(id), chartId);
}

/**
 * Delete through the product's own path (`performChartDelete`), which
 * deselects the chart AND emits the selection change. Calling the raw
 * `deselectChart` hook first skipped that emit — the chart was no longer
 * current by the time the delete looked — and left the Name Box showing the
 * deleted chart's name in every later spec.
 */
async function removeChart(page: Page, chartId: string): Promise<void> {
  await page.evaluate((id: string) => {
    (window as unknown as AppWindow).__CALCULA_CHARTS__?.deleteChart?.(id);
  }, chartId);
  await page.waitForTimeout(300);
}

/** The tab strip's "Chart Design" button: a <button> whose text is exactly the label. */
function chartDesignTab(page: Page) {
  return page
    .locator("[data-ribbon-content]")
    .locator("xpath=..")
    .locator("div")
    .first()
    .locator("button")
    .filter({ hasText: /^Chart Design$/ });
}

/** Captions of the band's cells, in order (the caption is each cell's last child). */
async function clusterCaptions(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-ribbon-content] [data-section-cell]")).map(
      (cell) => (cell.lastElementChild?.textContent ?? "").trim(),
    ),
  );
}

async function openChartDesign(page: Page, chartId: string): Promise<void> {
  await selectChart(page, chartId);
  const tab = chartDesignTab(page);
  await expect(tab, "selecting a chart must register the Chart Design tab").toHaveCount(1, { timeout: 10_000 });
  await tab.click();
  await expect
    .poll(() => clusterCaptions(page), { timeout: 10_000, message: "the Chart Design band never rendered its clusters" })
    .toContain("Type");
}

test.describe("Chart Design ribbon (Calcula Clusters)", () => {
  test("a bar chart shows the six clusters, no native select, no fixed overlay; popovers portal and close", async ({
    appPage,
    grid,
  }) => {
    await installAppImport(appPage);
    await seedData(grid);
    const chartId = await makeChart(appPage, "bar");
    try {
      await openChartDesign(appPage, chartId);

      // 1. The six clusters, in order. A cluster the 1280 band cannot fit is a
      //    launcher, and its caption STILL names it (the caption is the cell's
      //    last element in both forms), so the order check covers both.
      await expect.poll(() => clusterCaptions(appPage)).toEqual(AXIS_CLUSTERS);
      const launchers = await appPage
        .locator("[data-ribbon-content] [data-testid^='section-launcher-chart-design.']")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      console.log(`[chart-design] launchers at this width: ${JSON.stringify(launchers)}`);
      // Type and Elements are the last to fold: at the harness width they are inline.
      await expect(appPage.getByTestId("chart-type-bar")).toBeVisible();
      await expect(appPage.getByTestId("chart-elem-legend")).toBeVisible();

      // 2. No native <select> and no position:fixed layer INSIDE the band.
      const bandProblems = await appPage.evaluate(() => {
        const band = document.querySelector("[data-ribbon-content]");
        if (!band) return ["no band"];
        const out: string[] = [];
        if (band.querySelector("select")) out.push("a native <select> in the band");
        for (const el of Array.from(band.querySelectorAll<HTMLElement>("*"))) {
          if (getComputedStyle(el).position === "fixed") out.push(`position:fixed on <${el.tagName.toLowerCase()}>`);
        }
        return out;
      });
      expect(bandProblems).toEqual([]);

      // The band keeps its 100px height with six clusters in it: nothing in a
      // cluster grew the band (the fill rule keeps content to 61px).
      const bandBox = await appPage.locator("[data-ribbon-content]").first().boundingBox();
      expect(bandBox, "the band has no box").not.toBeNull();
      expect(Math.round(bandBox!.height)).toBeGreaterThanOrEqual(99);
      expect(Math.round(bandBox!.height)).toBeLessThanOrEqual(101);

      await softly(takeRibbonScreenshot(appPage, "chart-design-bar"));

      // 3. The Legend chevron opens a portalled popover; Escape closes it.
      const legendOptions = appPage.getByTestId("chart-elem-legend-options");
      await legendOptions.click();
      const legendMenu = appPage.getByTestId("chart-legend-right");
      await expect(legendMenu, "the Legend options menu never opened").toBeVisible();
      const portalled = await legendMenu.evaluate(
        (el) => !document.querySelector("[data-ribbon-content]")?.contains(el),
      );
      expect(portalled, "the Legend menu must render in a body portal, not inside the clipped band").toBe(true);
      await appPage.keyboard.press("Escape");
      await expect(legendMenu).toBeHidden();

      // The More tile opens the full gallery (18 types) in a card popover.
      await appPage.getByTestId("chart-type-more").click();
      await expect(appPage.getByTestId("chart-type-gallery-pie")).toBeVisible();
      await appPage.keyboard.press("Escape");
      await expect(appPage.getByTestId("chart-type-gallery-pie")).toBeHidden();

      // 4. The JSON action opens the chart-json TASK PANE (the old 420x400
      //    position:fixed overlay is gone), and closing it leaves nothing open.
      const jsonToggle = appPage.getByTestId("chart-json-toggle");
      if ((await jsonToggle.count()) === 0) {
        // Actions folded into a launcher at this width: open it first.
        await appPage.getByTestId("section-launcher-chart-design.actions").click();
      }
      await appPage.getByTestId("chart-json-toggle").click();
      await expect(appPage.getByTestId("chart-json-pane")).toBeVisible({ timeout: 10_000 });
      // Close the pane from its own header. The header's Close control is
      // rendered even while the pane is hidden, so take the VISIBLE one — a
      // bare .first() can resolve to a hidden copy and silently not click.
      await appPage.keyboard.press("Escape");
      await appPage.locator('button[title="Close Task Pane"]:visible').first().click();
      // A closed task pane SLIDES OFF-SCREEN (right: -width) and stays mounted,
      // and Playwright counts an off-screen element as visible — so "closed"
      // is asserted as "its box lies right of the viewport", not toBeHidden.
      await expect
        .poll(
          async () =>
            appPage.getByTestId("chart-json-pane").evaluate((el) => {
              const r = el.getBoundingClientRect();
              return r.width === 0 || r.left >= window.innerWidth - 1;
            }),
          { timeout: 5000, message: "the Chart JSON pane is still on screen after Close Task Pane" },
        )
        .toBe(true);
    } finally {
      await removeChart(appPage, chartId);
    }
    await expect(chartDesignTab(appPage)).toHaveCount(0);
  });

  test("bar -> line keeps the same tab and cells (no remount); bar -> pie drops only Layout", async ({ appPage, grid }) => {
    await installAppImport(appPage);
    await seedData(grid);
    const chartId = await makeChart(appPage, "bar");
    try {
      await openChartDesign(appPage, chartId);
      await expect.poll(() => clusterCaptions(appPage)).toEqual(AXIS_CLUSTERS);

      // Tag the live DOM. A remount replaces the nodes and the tag is gone.
      await appPage.evaluate(() => {
        const tab = Array.from(document.querySelectorAll("button")).find(
          (b) => b.textContent === "Chart Design",
        );
        if (tab) (tab as HTMLElement).dataset.e2eSame = "tab";
        const first = document.querySelector<HTMLElement>("[data-ribbon-content] [data-section-cell]");
        if (first) first.dataset.e2eSame = "cell";
      });

      await appPage.getByTestId("chart-type-line").click();
      await expect(appPage.getByTestId("chart-type-line")).toHaveAttribute("aria-checked", "true");
      await expect.poll(() => clusterCaptions(appPage)).toEqual(AXIS_CLUSTERS);
      const survived = await appPage.evaluate(() => ({
        tab: document.querySelector('button[data-e2e-same="tab"]') !== null,
        cell: document.querySelector('[data-ribbon-content] [data-section-cell][data-e2e-same="cell"]') !== null,
      }));
      expect(survived, "an axis -> axis type switch must not remount the tab or its cells").toEqual({
        tab: true,
        cell: true,
      });

      // Axis -> radial: Layout is the ONE conditional cluster.
      await appPage.getByTestId("chart-type-pie").click();
      await expect.poll(() => clusterCaptions(appPage)).toEqual(RADIAL_CLUSTERS);
      await expect(appPage.getByTestId("chart-elem-gridlines")).toHaveCount(0);
      await softly(takeRibbonScreenshot(appPage, "chart-design-pie"));
    } finally {
      await removeChart(appPage, chartId);
    }
  });

  test("measured widths: clusters fold in priority order (Layout first, Type never) and all six fit at 1600", async ({
    appPage,
    grid,
  }) => {
    await installAppImport(appPage);
    await seedData(grid);
    const chartId = await makeChart(appPage, "bar");
    try {
      await openChartDesign(appPage, chartId);
      await expect.poll(() => clusterCaptions(appPage)).toEqual(AXIS_CLUSTERS);
      await appPage.waitForTimeout(500);

      const result = await appPage.evaluate(
        async ({ renderers, fit, chrome, panelId }) => {
          const w = window as unknown as AppWindow;
          const r = (await w.__appImport!(renderers)) as {
            peekSectionWidths: (id: string) => {
              inline: Record<string, number>;
              launcher: Record<string, number>;
              natural: Record<string, number>;
              bandWidth: number;
            };
          };
          const f = (await w.__appImport!(fit)) as {
            computeWidthDemotions: (
              s: Array<{ id: string; width: number; launcherWidth?: number; collapsePriority: number; alreadyLauncher: boolean }>,
              containerWidth: number,
            ) => Set<string>;
          };
          const c = (await w.__appImport!(chrome)) as { cellChromeWidth: (first: boolean, last: boolean) => number };
          const panel = w.__CALCULA_PANEL_REGISTRY__?.getPanel(panelId);
          if (!panel) return { error: "no chart-design panel registered" };
          const peek = r.peekSectionWidths(panelId);
          const n = panel.sections.length;
          const inputs = panel.sections.map((s, i) => {
            const natural = peek.natural[s.id];
            const inline = peek.inline[s.id];
            const width = Math.max(inline ?? 0, natural !== undefined ? natural + c.cellChromeWidth(i === 0, i === n - 1) : 0);
            return {
              id: s.id,
              width,
              launcherWidth: peek.launcher[s.id],
              collapsePriority: s.collapsePriority ?? 1000 - i,
              alreadyLauncher: s.ribbonPresentation === "launcher",
            };
          });
          const unmeasured = inputs.filter((x) => x.width <= 0).map((x) => x.id);
          const demotedAt = (px: number) => Array.from(f.computeWidthDemotions(inputs, px)).sort();
          return {
            widths: Object.fromEntries(inputs.map((x) => [x.id, Math.round(x.width)])),
            total: Math.round(inputs.reduce((sum, x) => sum + x.width, 0)),
            bandWidth: Math.round(peek.bandWidth),
            unmeasured,
            at1280: demotedAt(peek.bandWidth > 0 ? peek.bandWidth : 1264),
            at1366: demotedAt(1350),
            at1440: demotedAt(1424),
            at1600: demotedAt(1584),
          };
        },
        { renderers: SECTION_RENDERERS, fit: SECTION_FIT, chrome: SECTION_CHROME, panelId: PANEL_ID },
      );
      console.log(`[chart-design] measured cluster widths: ${JSON.stringify(result)}`);
      expect("error" in result ? result.error : null).toBeNull();
      if ("error" in result) return;

      expect(result.unmeasured, "every cluster must have been measured inline at least once").toEqual([]);
      // The fold order is Layout first, then Actions (collapsePriority 3, 5).
      // Type and Elements never fold at any of these widths.
      for (const set of [result.at1280, result.at1366, result.at1440, result.at1600]) {
        expect(set).not.toContain("chart-design.type");
        expect(set).not.toContain("chart-design.elements");
      }
      // Whatever folds at a given width is a PREFIX of the priority order —
      // never Actions while Layout is inline, never Data while Actions is.
      // (Each width is the window width minus the band's 8px side padding.)
      const FOLD_ORDER = ["chart-design.layout", "chart-design.actions", "chart-design.data", "chart-design.style"];
      for (const set of [result.at1280, result.at1366, result.at1440, result.at1600]) {
        expect([...set].sort(), `fold set ${JSON.stringify(set)} is not a prefix of the priority order`).toEqual(
          FOLD_ORDER.slice(0, set.length).sort(),
        );
      }
      // The width budget in docs/design/ribbon-design-system.md: the whole tab
      // fits a 1600px window.
      expect(result.at1600, "at 1600 every cluster must be inline").toEqual([]);
    } finally {
      await removeChart(appPage, chartId);
    }
  });
});
