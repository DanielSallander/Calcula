/**
 * §2z THROUGH THE REAL UI — a restored computed property is still a FORMULA.
 *
 * WHAT §2z WAS. `restore_slicers` put `slicer_state.computed_properties` back
 * and never rebuilt `computed_prop_dependencies` / `computed_prop_dependents`.
 * Re-evaluation is driven ENTIRELY by that reverse index — it looks the changed
 * cells up there and re-evaluates nothing it does not find. So after a reload
 * the property was present in the store, listed in the dialog with its formula,
 * and inert: nothing errored, nothing was marked stale, and the only symptom
 * was a formula that had quietly stopped being one.
 *
 * The register's own measurement is the shape of this spec: *add a computed
 * property `headerText "=DA1"`; edit DA1 — the header follows. Save, File > New,
 * reopen — the property is restored intact, and editing DA1 never updates the
 * header again.*
 *
 * WHY THIS SPEC EXISTS. The four Rust tests call `restore_slicers` directly on a
 * hand-built `Workbook` and drive `re_evaluate_slicer_computed_properties` with
 * a literal seed list. Neither end of the real path is in that: the actual
 * `.cala` round trip, and the actual cell edit — which reaches the re-evaluation
 * only by going through the commit path, the MUTATION_REFRESH fan-out and the
 * Slicer extension's `slicers:refresh` listener. This drives both.
 *
 * THE RENDERED CLAIM IS MADE TWICE. `get_slicers_for_sheet` is the command the
 * extension's own store loads from and the canvas renderer reads
 * (`slicerRenderer.ts` paints `slicer.headerText ?? slicer.name`), so it is the
 * rendered value. The PIXELS of the slicer's header bar are then asserted to
 * have changed as well, because a store that updated behind a canvas that did
 * not repaint is a different defect wearing the same clothes.
 *
 * VACUOUS-PASS DISCIPLINE. Before the reload, the same edit is proved to move
 * the header — otherwise "it follows after a reload" could pass on a build where
 * it never followed at all and the value merely happened to match. And every
 * "it now reads X" is preceded by "it did not already read X".
 *
 * WHY A JOURNEY. It saves, calls File > New and reopens.
 *
 * GRID REAL ESTATE. The table lives in EG..EH rows 1..3; the formula's source
 * cell is DA1, the register's own coordinate. Every test starts from File > New.
 *
 * LOCALE. sv-SE. `=DA1` needs no list separator.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef, type GridHelper } from "../helpers/grid";
import { waitForGridStable } from "../helpers/screenshots";

const FILE = path.join(os.tmpdir(), "calcula-computed-property-restore.cala");

/** The cell the computed property's formula names. */
const SOURCE = "DA1";
/** Where the slicer sits, in grid-canvas pixels. */
const SLICER = { x: 500, y: 40, width: 180, height: 160 };

const HEADER_INITIAL = "HEADER-INITIAL";
const HEADER_LIVE = "HEADER-MOVED-LIVE";
const HEADER_AFTER_RELOAD = "HEADER-MOVED-AFTER-RELOAD";

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
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
}

async function callModule<T = unknown>(
  page: Page,
  modulePath: string,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  return page.evaluate(
    async ({ modulePath, fn, args }) => {
      const m = (await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL(modulePath, document.baseURI).href)) as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      if (typeof m[fn] !== "function") {
        throw new Error(`${modulePath} exports no function "${fn}"`);
      }
      return (await m[fn](...(args as unknown[]))) as unknown;
    },
    { modulePath, fn, args },
  ) as Promise<T>;
}

async function newFile(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(1000);
}

async function openAt(page: Page, target: string): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "openFileAtPath", [target]);
  await page.waitForTimeout(2500);
}

async function setCell(page: Page, ref: string, value: string): Promise<void> {
  const { row, col } = parseCellRef(ref);
  await invoke(page, "update_cell", { row, col, value });
  await page.waitForTimeout(150);
}

/** Type into a cell through the REAL inline editor — the path that fans out. */
async function typeInto(grid: GridHelper, ref: string, value: string): Promise<void> {
  await grid.navigateTo(ref);
  await grid.typeIntoCell(value);
  await grid.page.waitForTimeout(900);
}

interface SlicerRow {
  id: string;
  name: string;
  headerText: string | null;
}

/**
 * The slicers of the active sheet, read through the very command the Slicer
 * extension's store loads from — so this is what the canvas renderer paints.
 * THROWS when there is not exactly one: a spec that silently read the wrong
 * slicer (or none) would report an absence as a pass.
 */
async function theSlicer(page: Page): Promise<SlicerRow> {
  const rows = await invoke<SlicerRow[]>(page, "get_slicers_for_sheet", { sheetIndex: 0 });
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one slicer on sheet 0, found ${rows.length}: ` +
        JSON.stringify(rows.map((r) => r.name)),
    );
  }
  return rows[0];
}

/** The computed properties the dialog would list for a slicer. */
async function computedProps(
  page: Page,
  slicerId: string,
): Promise<Array<{ attribute: string; formula: string; currentValue?: string }>> {
  const res = await invoke<{
    properties: Array<{ attribute: string; formula: string; currentValue?: string }>;
  }>(page, "get_slicer_computed_properties", { slicerId });
  return res.properties;
}

// ---------------------------------------------------------------------------
// Pixels — the slicer's own header bar.
// ---------------------------------------------------------------------------

/**
 * The slicer's header bar, in canvas pixels.
 *
 * SCROLL IS NORMALISED FIRST, and that is not a detail. `slicer.x/y` are sheet
 * coordinates, so the clip below is only over the slicer while the grid is
 * parked at the origin — and the edits this spec makes are to `DA1`, which
 * scrolls the viewport 100 columns away. The first version of this helper did
 * not do it, and it failed BOTH ways in one run: the pre-reload comparison
 * "passed" because the whole viewport had scrolled between the two captures
 * (nothing to do with the header), and the post-reload one "failed" because both
 * captures photographed the same empty patch of grid. A pixel oracle that moves
 * with the camera measures the camera.
 */
async function captureHeaderBar(grid: GridHelper): Promise<number[]> {
  const page = grid.page;
  await grid.navigateTo("A1");
  await waitForGridStable(page);
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("the grid canvas has no bounding box");
  const clip = {
    x: box.x + SLICER.x,
    y: box.y + SLICER.y,
    width: SLICER.width,
    height: 32,
  };
  const png = await page.screenshot({ clip });
  return page.evaluate(async (b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context for the pixel decode");
    ctx.drawImage(bitmap, 0, 0);
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  }, png.toString("base64"));
}

function diffCount(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`capture sizes differ (${a.length} vs ${b.length}) — the clip moved`);
  }
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > 8 ||
      Math.abs(a[i + 1] - b[i + 1]) > 8 ||
      Math.abs(a[i + 2] - b[i + 2]) > 8
    ) {
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Fixture — a real Table and a real slicer over it, built the way the app does.
// Setup, never the thing under test.
// ---------------------------------------------------------------------------

/**
 * The slicer is created through the extension's OWN store function
 * (`createSlicerAsync`, exposed on `window.__CALCULA_SLICER__` for exactly this
 * purpose), not through the raw `create_slicer` command. The store function is
 * what loads the items, publishes the grid overlay region and asks for a redraw
 * — a raw command creates a slicer the canvas has never heard of, and then the
 * pixel assertions below would be photographing an empty patch of grid.
 */
async function buildSlicerOverATable(page: Page): Promise<string> {
  for (const [ref, value] of [
    ["EG1", "Region"],
    ["EH1", "Amount"],
    ["EG2", "North"],
    ["EH2", "100"],
    ["EG3", "South"],
    ["EH3", "250"],
  ] as Array<[string, string]>) {
    await setCell(page, ref, value);
  }
  const table = await invoke<{ success: boolean; table?: { id: string } }>(page, "create_table", {
    params: {
      name: "ComputedPropProbe",
      startRow: 0,
      startCol: 136,
      endRow: 2,
      endCol: 137,
      hasHeaders: true,
      styleName: null,
    },
  });
  if (!table.success || !table.table) {
    throw new Error(`the fixture table was not created: ${JSON.stringify(table)}`);
  }
  const created = await page.evaluate(
    async ({ params }) => {
      const api = (
        window as unknown as {
          __CALCULA_SLICER__?: { createSlicerAsync: (p: unknown) => Promise<{ id: string } | null> };
        }
      ).__CALCULA_SLICER__;
      if (!api) {
        throw new Error(
          "window.__CALCULA_SLICER__ is missing — the Slicer extension did not " +
            "activate, so nothing below would be measuring a slicer",
        );
      }
      return api.createSlicerAsync(params);
    },
    {
      params: {
        name: "Region",
        sheetIndex: 0,
        x: SLICER.x,
        y: SLICER.y,
        width: SLICER.width,
        height: SLICER.height,
        sourceType: "table",
        cacheSourceId: table.table.id,
        fieldName: "Region",
        connectedSources: [],
        columns: 1,
      },
    },
  );
  if (!created) throw new Error("createSlicerAsync returned null — no slicer was created");
  await page.waitForTimeout(800);
  return created.id;
}

// ===========================================================================

test.describe.serial("§2z — a reopened workbook's computed property still re-evaluates", () => {
  test.beforeAll(() => {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  });

  test("add a computed property, save, File > New, reopen — editing the source cell still moves the header", async ({
    grid,
  }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    // ---- Fixture: a table, a slicer over it, and the source cell.
    await newFile(page);
    await setCell(page, SOURCE, HEADER_INITIAL);
    const slicerId = await buildSlicerOverATable(page);
    await waitForGridStable(page);

    // ---- Add the computed property. This is the feature's own command — the
    // one the Computed Properties dialog calls.
    const added = await invoke<{ success: boolean }>(page, "add_slicer_computed_property", {
      slicerId,
      attribute: "headerText",
      formula: `=${SOURCE}`,
    });
    expect(added.success, "the computed property was not added").toBe(true);
    await page.waitForTimeout(600);

    // ---- PRECONDITION: it took effect at all.
    expect(
      (await theSlicer(page)).headerText,
      "the computed property did not even take its FIRST value, so nothing below " +
        "would be measuring re-evaluation",
    ).toBe(HEADER_INITIAL);

    // =====================================================================
    // (1) BEFORE THE RELOAD — the property really is a live formula.
    //
    // This is the vacuity guard for the whole spec: without it, "the header
    // follows after a reload" could pass on a build where it never followed.
    // =====================================================================
    await waitForGridStable(page);
    const beforeLive = await captureHeaderBar(grid);
    await typeInto(grid, SOURCE, HEADER_LIVE);
    await waitForGridStable(page);

    expect(
      (await theSlicer(page)).headerText,
      "in a LIVE session, editing the cell the formula names did not move the header",
    ).toBe(HEADER_LIVE);
    const afterLive = await captureHeaderBar(grid);
    const liveInk = diffCount(beforeLive, afterLive);
    expect(
      liveInk,
      "the slicer's header bar did not repaint when its computed value changed — " +
        "the store moved behind a canvas that did not, which is a different defect " +
        "with the same symptom",
    ).toBeGreaterThan(20);

    // =====================================================================
    // (2) SAVE, FILE > NEW, REOPEN — the register's own sequence.
    // =====================================================================
    await invoke(page, "save_file", { path: FILE });
    await expect
      .poll(() => fs.existsSync(FILE), { timeout: 20_000, intervals: [200] })
      .toBe(true);

    await newFile(page);
    expect(
      await invoke<unknown[]>(page, "get_slicers_for_sheet", { sheetIndex: 0 }),
      "File > New left the previous document's slicer behind",
    ).toHaveLength(0);

    await openAt(page, FILE);
    await waitForGridStable(page);

    // ---- THE HALF THAT ALWAYS WORKED. The property comes back intact, which
    // is exactly why the defect was invisible: the dialog showed the formula.
    const reopened = await theSlicer(page);
    const props = await computedProps(page, reopened.id);
    expect(
      props.map((p) => [p.attribute, p.formula]),
      "the computed property itself was not restored, so the interesting " +
        "assertion below would be about a property that is simply absent",
    ).toEqual([["headerText", `=${SOURCE}`]]);
    expect(
      reopened.headerText,
      "precondition: the reopened slicer must carry the value it was saved with",
    ).toBe(HEADER_LIVE);

    // =====================================================================
    // (3) THE DEFECT: edit the source cell again, after the reload.
    // =====================================================================
    const beforeReloaded = await captureHeaderBar(grid);
    await typeInto(grid, SOURCE, HEADER_AFTER_RELOAD);
    await waitForGridStable(page);

    expect(
      (await theSlicer(page)).headerText,
      "after a reload the computed property is RESTORED AND DEAD: the property is " +
        "there, the formula is there, and the cell it names can never move it " +
        "again. Nothing errors and nothing is marked stale — the only symptom is " +
        "a formula that has quietly stopped being one",
    ).toBe(HEADER_AFTER_RELOAD);

    const afterReloaded = await captureHeaderBar(grid);
    expect(
      diffCount(beforeReloaded, afterReloaded),
      "the reopened slicer's header bar never repainted, so whatever the store " +
        "says, the user is still looking at the old value",
    ).toBeGreaterThan(20);

    // ---- AND THE CACHED VALUE THE DIALOG SHOWS AGREES, so the dialog and the
    // canvas cannot tell the user two different things.
    expect(
      (await computedProps(page, reopened.id))[0]?.currentValue,
      "the Computed Properties dialog still shows the pre-reload value",
    ).toBe(HEADER_AFTER_RELOAD);
  });
});
