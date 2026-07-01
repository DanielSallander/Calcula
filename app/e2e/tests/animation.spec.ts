import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Read a cell's current DISPLAY value straight from the backend (get_cell), so
 * we assert on the source of truth without clicking cells (avoids selection
 * drift) and without dependent-display staleness.
 */
async function cellDisplay(page: Page, row: number, col: number): Promise<string> {
  return page.evaluate(
    async ({ r, c }) => {
      const t = (window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } } }).__TAURI__;
      const cell = (await t.core.invoke("get_cell", { row: r, col: c })) as { display?: string } | null;
      return String(cell?.display ?? "");
    },
    { r: row, c: col },
  );
}

/** Invoke a backend command through the e2e-enabled window.__TAURI__ bridge. */
async function invoke(page: Page, cmd: string, args: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ c, a }) => {
      const t = (window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } } }).__TAURI__;
      return t.core.invoke(c, a);
    },
    { c: cmd, a: args },
  );
}

type GridLike = { page: Page; openMenu: (m: string) => Promise<void>; clickMenuItem: (i: string) => Promise<void> };

/** Open the Animation panel (View ▸ Animation Timeline), then the create dialog (+ New). */
async function openNewAnimationDialog(grid: GridLike): Promise<void> {
  await grid.openMenu("View");
  await grid.clickMenuItem("Animation Timeline");
  const newBtn = grid.page.locator('[data-testid="anim-new"]');
  await newBtn.waitFor({ state: "visible", timeout: 8000 });
  await newBtn.click();
  await expect(grid.page.locator('[data-testid="anim-driver-type"]')).toBeVisible({ timeout: 8000 });
}

/** Open the panel and configure a clock-cell driver via the quick-config. */
async function configureClockDriver(grid: GridLike, cell: string, from: string, to: string, step: string, expectFrame: string): Promise<void> {
  await grid.openMenu("View");
  await grid.clickMenuItem("Animation Timeline");
  await expect(grid.page.locator('[data-testid="anim-driver-cell"]')).toBeVisible({ timeout: 8000 });
  await grid.page.locator('[data-testid="anim-driver-cell"]').fill(cell);
  await grid.page.locator('[data-testid="anim-from"]').fill(from);
  await grid.page.locator('[data-testid="anim-to"]').fill(to);
  await grid.page.locator('[data-testid="anim-step"]').fill(step);
  await grid.page.locator('[data-testid="anim-set-driver"]').click();
  await expect(grid.page.locator('[data-testid="anim-frame"]')).toHaveText(expectFrame, { timeout: 5000 });
}

test.describe("Animation extension", () => {
  test("clock-cell driver steps write transiently, recalc dependents, and stop restores", async ({ grid }) => {
    const page = grid.page;

    // 1. Model: A1 = 7 (the driver cell), B1 = A1*2 (a dependent formula).
    await grid.setCellValueDirect("A1", "7");
    await grid.setCellValueDirect("B1", "=A1*2");
    expect(await cellDisplay(page, 0, 0)).toBe("7");
    expect(await cellDisplay(page, 0, 1)).toBe("14");

    // 2. Open the Animation panel via View ▸ Animation Timeline.
    await grid.openMenu("View");
    await grid.clickMenuItem("Animation Timeline");
    await expect(page.locator('[data-testid="anim-driver-cell"]')).toBeVisible({ timeout: 8000 });

    // 3. Configure a clock-cell driver via the quick-config: A1 swept 0 → 10 by 1.
    await page.locator('[data-testid="anim-driver-cell"]').fill("A1");
    await page.locator('[data-testid="anim-from"]').fill("0");
    await page.locator('[data-testid="anim-to"]').fill("10");
    await page.locator('[data-testid="anim-step"]').fill("1");
    await page.locator('[data-testid="anim-set-driver"]').click();
    await expect(page.locator('[data-testid="anim-frame"]')).toHaveText("1 / 11", { timeout: 5000 });

    // 4. Stepping writes the driver value transiently AND recalculates the dependent.
    await page.locator('button[title="Step forward"]').click();
    await expect.poll(() => cellDisplay(page, 0, 0), { timeout: 5000 }).toBe("1");
    expect(await cellDisplay(page, 0, 1)).toBe("2"); // B1 = A1*2 = 2

    await page.locator('button[title="Step forward"]').click();
    await expect.poll(() => cellDisplay(page, 0, 0), { timeout: 5000 }).toBe("2");
    expect(await cellDisplay(page, 0, 1)).toBe("4");

    // 5. Play advances the model to the end of the range.
    await page.locator('button[title="Play"]').click();
    await expect.poll(() => cellDisplay(page, 0, 0), { timeout: 8000 }).toBe("10");

    // 6. Stop RESTORES the model to its original values — the transient guarantee.
    await page.locator('button[title="Stop (reset)"]').click();
    await expect.poll(() => cellDisplay(page, 0, 0), { timeout: 5000 }).toBe("7");
    expect(await cellDisplay(page, 0, 1)).toBe("14");
  });

  test("scenario driver tweens between Scenario Manager keyframes and stop restores", async ({ grid }) => {
    const page = grid.page;

    // Model + two scenarios that change A1 (Low=10, High=90).
    await grid.setCellValueDirect("A1", "50");
    await grid.setCellValueDirect("B1", "=A1*2");
    await invoke(page, "scenario_add", {
      params: { name: "AnimLow", changingCells: [{ row: 0, col: 0, value: "10" }], comment: "", sheetIndex: 0 },
    });
    await invoke(page, "scenario_add", {
      params: { name: "AnimHigh", changingCells: [{ row: 0, col: 0, value: "90" }], comment: "", sheetIndex: 0 },
    });

    await openNewAnimationDialog(grid);
    await page.locator('[data-testid="anim-driver-type"]').selectOption("scenario");

    // Keyframe scenarios load asynchronously (listScenarios → scenario_list).
    await page.locator("label").filter({ hasText: "AnimLow" }).getByRole("checkbox").check({ timeout: 8000 });
    await page.locator("label").filter({ hasText: "AnimHigh" }).getByRole("checkbox").check();

    await page.locator('input[placeholder="Revenue ramp"]').fill("ScenarioAnim");
    await page.locator('[data-testid="anim-create-btn"]').click();

    // Linear tween across 2 keyframes -> multiple frames.
    await expect(page.locator('[data-testid="anim-frame"]')).toHaveText(/^1 \/ \d+$/, { timeout: 5000 });

    // Step writes a tweened value into A1 (no longer the original 50).
    await page.locator('button[title="Step forward"]').click();
    await expect.poll(() => cellDisplay(page, 0, 0), { timeout: 5000 }).not.toBe("50");

    // Stop restores A1 (and its dependent B1) to the original model.
    await page.locator('button[title="Stop (reset)"]').click();
    await expect.poll(() => cellDisplay(page, 0, 0), { timeout: 5000 }).toBe("50");
    expect(await cellDisplay(page, 0, 1)).toBe("100");
  });

  test("chart-param driver derives its frame count from the param's stepper bind", async ({ grid }) => {
    const page = grid.page;

    // Seed a small data range and a chart with a stepper-bound param (0..100 step 25 = 5 frames).
    for (const [ref, v] of [["Z1", "Month"], ["AA1", "Sales"], ["Z2", "Jan"], ["AA2", "100"], ["Z3", "Feb"], ["AA3", "200"], ["Z4", "Mar"], ["AA4", "150"]] as const) {
      await grid.setCellValueDirect(ref, v);
    }
    const chartId = await page.evaluate(async () => {
      const t = (window as unknown as { __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } } }).__TAURI__;
      const id = crypto.randomUUID();
      // The chart store persists the WHOLE ChartDefinition as specJson (toEntry does
      // JSON.stringify(chart)), and fromEntry parses it straight back. So the entry
      // must be a full ChartDefinition with the chart spec nested under `.spec` —
      // otherwise listAnimatableCharts sees no `spec.params` and the chart is skipped.
      const chartDef = {
        chartId: id,
        name: "Anim Chart",
        sheetIndex: 0,
        x: 320,
        y: 40,
        width: 400,
        height: 300,
        spec: {
          mark: "bar",
          data: { sheetIndex: 0, startRow: 0, startCol: 25, endRow: 3, endCol: 26 },
          hasHeaders: true,
          seriesOrientation: "columns",
          categoryIndex: 0,
          series: [{ sourceIndex: 1, name: "Sales", color: "#4472C4" }],
          title: "Anim Chart",
          params: [{ name: "Threshold", value: 100, bind: { input: "stepper", min: 0, max: 100, step: 25 } }],
        },
      };
      await t.core.invoke("save_chart", { entry: { id, sheetIndex: 0, specJson: JSON.stringify(chartDef) } });
      // Make the Charts frontend store reload so listAnimatableCharts sees the new chart.
      window.dispatchEvent(new Event("charts:refresh"));
      return id;
    });
    await page.waitForTimeout(700); // let reloadCharts settle

    await openNewAnimationDialog(grid);
    await page.locator('[data-testid="anim-driver-type"]').selectOption("chartParam");
    // selectOption waits for the option to be present (chart appears after the store reload).
    await page.locator('[data-testid="anim-chart"]').selectOption(chartId, { timeout: 8000 });
    await page.locator('[data-testid="anim-param"]').selectOption("Threshold");
    await page.locator('input[placeholder="Revenue ramp"]').fill("ChartAnim");
    await page.locator('[data-testid="anim-create-btn"]').click();

    // Stepper 0..100 step 25 -> values [0,25,50,75,100] -> 5 frames.
    await expect(page.locator('[data-testid="anim-frame"]')).toHaveText("1 / 5", { timeout: 5000 });
    await page.locator('button[title="Step forward"]').click();
    await expect(page.locator('[data-testid="anim-frame"]')).toHaveText("2 / 5", { timeout: 5000 });
    await page.locator('button[title="Play"]').click();
    await expect(page.locator('[data-testid="anim-frame"]')).toHaveText("5 / 5", { timeout: 8000 });
    await page.locator('button[title="Stop (reset)"]').click();
  });

  test("Monte Carlo driver accumulates trials into the live histogram", async ({ grid }) => {
    const page = grid.page;

    // A volatile outcome cell (RANDBETWEEN re-rolls every recalc). sv-SE arg separator is ';'.
    await grid.setCellValueDirect("B10", "=RANDBETWEEN(1;6)");

    await openNewAnimationDialog(grid);
    await page.locator('[data-testid="anim-driver-type"]').selectOption("monteCarlo");
    await page.locator('[data-testid="anim-outcome-cell"]').fill("B10");
    await page.locator('[data-testid="anim-trials"]').fill("40");
    await page.locator('[data-testid="anim-bins"]').fill("6");
    await page.locator('input[placeholder="Revenue ramp"]').fill("MonteCarloAnim");
    await page.locator('[data-testid="anim-create-btn"]').click();

    // The histogram view is present (mcActive) once the driver loads — before any
    // trial runs it shows the "Press Play" prompt (unique to MonteCarloView).
    await expect(page.getByText("Press Play to run trials.")).toBeVisible({ timeout: 5000 });

    // Play accumulates trials; the count appears after the first trial and grows.
    // (Monte Carlo is non-deterministic by design — assert the count, not the values.)
    await page.locator('button[title="Play"]').click();
    const countEl = page.locator('[data-testid="anim-mc-trials-count"]');
    await expect(countEl).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => Number(await countEl.textContent()), { timeout: 10000 }).toBeGreaterThan(1);

    await page.locator('button[title="Stop (reset)"]').click();
  });

  test("Export GIF backend encodes and writes a valid GIF to disk", async ({ grid }) => {
    // The native "Save As" dialog can't be JS-stubbed in a running Tauri app — its
    // IPC entry point (window.__TAURI_INTERNALS__.invoke) is a locked, non-writable /
    // non-configurable property (Tauri v2 security). So, exactly like encryption.spec.ts
    // does for file dialogs, drive the export's backend command directly with an
    // explicit path. This verifies the real `export_gif` command over IPC end to end:
    // RGBA frames -> Rust `gif`-crate encode -> a valid animated GIF's bytes on disk.
    const page = grid.page;
    const gifPath = path.join(os.tmpdir(), `calcula-e2e-anim-gif-${process.pid}.gif`);
    try {
      fs.rmSync(gifPath, { force: true });
      const W = 4;
      const H = 4;
      const solid = (r: number, g: number, b: number): number[] => {
        const px: number[] = [];
        for (let i = 0; i < W * H; i++) px.push(r, g, b, 255);
        return px;
      };
      await invoke(page, "export_gif", {
        req: {
          path: gifPath,
          width: W,
          height: H,
          frames: [
            { rgba: solid(220, 30, 30), delayCs: 10 },
            { rgba: solid(30, 30, 220), delayCs: 10 },
          ],
          repeat: true,
        },
      });

      expect(fs.existsSync(gifPath)).toBe(true);
      const buf = fs.readFileSync(gifPath);
      expect(buf.length).toBeGreaterThan(0);
      expect(buf.subarray(0, 6).toString("ascii")).toBe("GIF89a"); // animated-GIF magic
    } finally {
      fs.rmSync(gifPath, { force: true });
    }
  });

  test("Export controls are enabled once an animation is loaded", async ({ grid }) => {
    // The full click-through export can't run in e2e (the native save dialog blocks and
    // its IPC can't be stubbed — see the GIF-backend test), so assert the export UI is
    // correctly wired instead: with a driver loaded, both export buttons are enabled.
    // The WebM button being enabled also confirms MediaRecorder + canvas.captureStream
    // are available in WebView2 (isWebmRecordingSupported() is true).
    const page = grid.page;
    await grid.setCellValueDirect("A1", "0");
    await grid.setCellValueDirect("B1", "=A1*2");
    await configureClockDriver(grid, "A1", "0", "10", "1", "1 / 11");

    await expect(page.getByRole("button", { name: "Export GIF" })).toBeEnabled({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "Export WebM" })).toBeEnabled({ timeout: 5000 });
  });
});
