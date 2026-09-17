/**
 * INSIGHT OVERLAYS ON A BI PIVOT — the member-based route (IO-6), proved LIVE
 * on a real model with a real strategy.
 *
 * docs/design/insight-overlays.md §5e. The ask this milestone began with was
 * "the pivot cell holding the highest revenue, marked, judged by the strategy".
 * IO-4 could only mark a pivot's cells NEUTRALLY, from the numbers it shows;
 * IO-6 takes the MODEL's facts (`insights_analyze_model`, coloured by the
 * strategy's declared directions) and lands them on the cells whose header
 * labels the facts name. Every unit test of that route runs over hand-built
 * views; this journey drives the whole chain in the running app:
 *
 *   CSV files → a real BI connection with the sales-star model and its strategy
 *   → a BI pivot (months × categories) → the grid menu → Rust model facts →
 *   `pivotCuesFor` → cell cues → the over-selection decoration → pixels.
 *
 * THE FIXTURE PLANTS THE ANSWER. `tests/fixtures/model/sales_star.json` is the
 * insights engine's own fixture: in its final month (2025-12) the Gadgets
 * category's revenue collapses while every other category keeps its trend
 * (`planted` in the file). Revenue is `higherIsBetter` in the strategy, so the
 * honest overlay marks the Gadgets × 2025-12 cell BAD and the month's total
 * BAD — and nothing is inferred from a fall: the colour is the strategy's.
 *
 * EVERY "IT IS THERE" HAS A POSITIVE CONTROL. The cue's cell is computed from
 * the pivot VIEW (the row whose label is 2025-12, the column whose header is
 * Gadgets) and from the region's origin, never from the cue itself; the cell's
 * pixels must change between off and on; and a filter change that hides the
 * category to the LEFT of Gadgets must move the cue one column left — the
 * follow-the-data proof, on a pivot.
 *
 * The model is built from CSV files in a temp folder (the model-transform
 * journey's recipe): a `csv` source keeps its directory in `database`, needs
 * no credentials, and gives BOUND tables with real rows. The time axis is
 * `Date[Month]` ("2025-12" strings), so a fact's period label IS the pivot's
 * header label with no date formatting in between.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import { readGridGeometry, cellRangeRectFrom } from "../helpers/grid";
import { takeRegionScreenshot, waitForGridStable } from "../helpers/screenshots";

/* eslint-disable @typescript-eslint/naming-convention */
type AppWindow = Window & {
  __calcImport: (url: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
};
/* eslint-enable @typescript-eslint/naming-convention */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, "../../../tests/fixtures/model");
const CELL_CUES = "/src/api/cellCues.ts";
const PIVOT_API = "/src/api/pivot.ts";
const GRID_OVERLAYS = "/src/api/gridOverlays.ts";
const SHEET_OVERLAY = "/extensions/Insights/lib/sheetOverlay.ts";
const GRID_MENU = '[role="menu"][aria-label="Context menu"]';
const SOURCE_ID = "star_csv";
const LAST_MONTH = "2025-12";
/** The six months the pivot shows; the other eighteen are hidden so it fits on screen. */
const SHOWN_MONTHS = ["2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12"];

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

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

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a),
    { c: cmd, a: args },
  ) as Promise<T>;
}

async function fileApi<T = unknown>(page: Page, fn: string, arg?: string): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const mod = (await (window as unknown as AppWindow).__calcImport(new URL("/src/core/lib/file-api.ts", document.baseURI).href)) as Record<
        string,
        (a?: unknown) => Promise<unknown>
      >;
      return (await mod[fn](arg)) as unknown;
    },
    { fn, arg },
  ) as Promise<T>;
}

function colLetters(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const ref = (row: number, col: number): string => `${colLetters(col)}${row + 1}`;

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function rangeClip(page: Page, from: string, to: string, pad = 2): Promise<Clip> {
  const geo = await readGridGeometry(page);
  const rect = cellRangeRectFrom(from, to, geo);
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("grid canvas has no bounding box");
  return { x: box.x + rect.x - pad, y: box.y + rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
}

async function pixels(page: Page, clip: Clip): Promise<number[]> {
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
    if (!ctx) throw new Error("no 2d context for pixel decode");
    ctx.drawImage(bitmap, 0, 0);
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  }, png.toString("base64"));
}

function diffCount(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`capture sizes differ (${a.length} vs ${b.length}) — the clip moved`);
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The fixture, as CSV files plus a model that binds them
// ---------------------------------------------------------------------------

interface StarBundle {
  model: {
    tables: Array<{ name: string; columns: Array<{ name: string; data_type: unknown }>; [k: string]: unknown }>;
    [k: string]: unknown;
  };
  data: Record<string, { columns: string[]; rows: unknown[][] }>;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Write one CSV per table and return the model with a `csv` source bound to them. */
function writeStarAsCsv(dir: string): Record<string, unknown> {
  const bundle = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "sales_star.json"), "utf8")) as StarBundle;
  for (const [table, { columns, rows }] of Object.entries(bundle.data)) {
    const lines = [columns.join(","), ...rows.map((r) => r.map(csvCell).join(","))];
    fs.writeFileSync(path.join(dir, `${table}.csv`), lines.join("\n") + "\n", "utf8");
  }
  const model = { ...bundle.model };
  // DataFusion infers whole-number CSV columns as Int64; declare them that way
  // so the fetched batches match the model's types.
  model.tables = bundle.model.tables.map((t) => ({
    ...t,
    columns: t.columns.map((c) => (c.data_type === "Int32" ? { ...c, data_type: "Int64" } : c)),
    source_binding: { source_id: SOURCE_ID, schema: "csv", table: t.name },
  }));
  model.sources = [
    {
      id: SOURCE_ID,
      kind: "csv",
      connection: { database: dir, default_schema: "csv" },
      preferred_auth: "integrated",
      display_name: "Sales star (CSV)",
    },
  ];
  return model;
}

/** The fixture's strategy, with the time axis on the month LABEL column. */
function starStrategy(): Record<string, unknown> {
  const doc = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "sales_star_strategy.json"), "utf8")) as { model: Record<string, unknown> };
  doc.model = { ...doc.model, defaultTimeAxis: "Date[Month]" };
  return doc;
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

interface ViewCell {
  cellType: string;
  value: unknown;
}
interface View {
  pivotId: string;
  isWindowed?: boolean;
  rows: Array<{ rowType: string; cells: ViewCell[] }>;
}
interface CellCue {
  factId: string;
  polarity: string;
  description: string;
  sheetIndex: number;
  row: number;
  col: number;
}

test.describe("Insight overlays on a BI pivot, live", () => {
  test.setTimeout(240_000);
  let csvDir = "";
  let connectionId = "";
  let pivotId = "";

  test.afterEach(async ({ appPage }) => {
    try {
      if (pivotId) {
        await appPage.evaluate(async ({ id, mod }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { pivot: { delete: (id: string) => Promise<void> } };
          await m.pivot.delete(id);
        }, { id: pivotId, mod: PIVOT_API });
      }
      if (connectionId) await invoke(appPage, "bi_delete_connection", { connectionId });
    } finally {
      if (csvDir) fs.rmSync(csvDir, { recursive: true, force: true });
    }
  });

  test("a model's facts land on the pivot cells the headers name, coloured by the strategy, and follow a filter change", async ({ appPage, grid }) => {
    await installAppImport(appPage);
    await fileApi(appPage, "newFile");
    await appPage.waitForTimeout(500);

    // --- The model: real rows through a CSV source, with the strategy --------
    csvDir = fs.mkdtempSync(path.join(os.tmpdir(), "calcula-overlay-pivot-"));
    const model = writeStarAsCsv(csvDir);
    const info = await invoke<{ id: string }>(appPage, "bi_create_connection", {
      request: { name: "Sales star (overlay journey)", description: null, connectionString: "", modelJson: { formatVersion: 1, model } },
    });
    connectionId = info.id;
    expect(connectionId, "bi_create_connection returned an id").toBeTruthy();
    await invoke(appPage, "bi_model_connect_source", { connectionId, sourceId: SOURCE_ID, connectionString: "", remember: false });

    const strategy = await invoke<{ written: boolean; findings: Array<{ severity: string; code: string; path: string; message: string }> }>(
      appPage,
      "bi_model_strategy",
      { connectionId, op: "set", payload: starStrategy() },
    );
    console.log(`[overlay-pivot] strategy set: written=${strategy.written} findings=${JSON.stringify(strategy.findings.filter((f) => f.severity !== "info"))}`);
    expect(strategy.written, `the fixture's strategy must be accepted: ${JSON.stringify(strategy.findings)}`).toBe(true);

    // --- The pivot: months down, categories across, Revenue ------------------
    const created = await appPage.evaluate(
      async ({ connectionId, mod }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          pivot: {
            createFromBiModel: (r: unknown) => Promise<{ pivotId: string }>;
            updateBiFields: (r: unknown) => Promise<View>;
          };
        };
        const v = await m.pivot.createFromBiModel({ destinationCell: "B2", connectionId, name: "OverlayPivot" });
        const view = await m.pivot.updateBiFields({
          pivotId: v.pivotId,
          rowFields: [{ table: "Date", column: "Month" }],
          columnFields: [{ table: "Product", column: "Category" }],
          valueFields: [{ measureName: "Revenue" }],
          filterFields: [],
        });
        return { pivotId: v.pivotId, rows: view.rows.length, windowed: view.isWindowed === true };
      },
      { connectionId, mod: PIVOT_API },
    );
    pivotId = created.pivotId;
    console.log(`[overlay-pivot] pivot ${pivotId}: ${created.rows} view rows, windowed=${created.windowed}`);
    await appPage.waitForTimeout(1000);

    // The filter dropdown's gesture: a manual item selection on a field.
    // (`hiddenItems` on a BI field ref is not the filter path — measured on
    // this spec's first run, where every month stayed visible.)
    const filterField = async (fieldName: string, selectedItems: string[]): Promise<void> => {
      const applied = await appPage.evaluate(
        async ({ id, mod, fieldName, selectedItems }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
            pivot: {
              getAtCell: (r: number, c: number) => Promise<{ sourceFields: Array<{ index: number; name: string }> } | null>;
              applyFilter: (r: unknown) => Promise<View>;
            };
          };
          const info = await m.pivot.getAtCell(1, 1);
          // Source fields carry the bare column name ("Month"), not "Date.Month".
          const field = info?.sourceFields.find((f) => f.name === fieldName || f.name === fieldName.split(".").pop());
          if (!field) return `no source field "${fieldName}" among ${JSON.stringify(info?.sourceFields.map((f) => f.name))}`;
          const view = await m.pivot.applyFilter({ pivotId: id, fieldIndex: field.index, filters: { manualFilter: { selectedItems } } });
          return `${view.rows.length} rows`;
        },
        { id: pivotId, mod: PIVOT_API, fieldName, selectedItems },
      );
      console.log(`[overlay-pivot] filter ${fieldName} to ${selectedItems.length} items: ${applied}`);
      expect(applied, `the filter on ${fieldName} must apply`).toMatch(/rows$/);
    };
    await filterField("Date.Month", SHOWN_MONTHS);
    await appPage.waitForTimeout(1000);
    await waitForGridStable(appPage);

    // Where things are, from the VIEW and the REGION — never from a cue.
    const locate = async () => {
      const view = await appPage.evaluate(
        async ({ id, mod }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { pivot: { getView: (id: string) => Promise<View> } };
          const v = await m.pivot.getView(id);
          return { rows: v.rows.map((r) => ({ rowType: r.rowType, cells: r.cells.map((c) => ({ cellType: c.cellType, value: c.value })) })) };
        },
        { id: pivotId, mod: PIVOT_API },
      );
      const region = await appPage.evaluate(
        async ({ id, mod }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
            getGridRegions: () => Array<{ type: string; data?: { pivotId?: string }; startRow: number; startCol: number; endRow: number; endCol: number }>;
          };
          const r = m.getGridRegions().find((x) => x.type === "pivot" && x.data?.pivotId === id);
          return r ? { startRow: r.startRow, startCol: r.startCol, endRow: r.endRow, endCol: r.endCol } : null;
        },
        { id: pivotId, mod: GRID_OVERLAYS },
      );
      expect(region, "the pivot must publish a grid region").not.toBeNull();
      const headerRow = view.rows.find((r) => r.rowType === "ColumnHeader");
      const gadgetsCol = headerRow?.cells.findIndex((c) => c.value === "Gadgets") ?? -1;
      const totalCol = headerRow?.cells.findIndex((c) => c.cellType === "GrandTotalColumn" || c.value === "Grand Total") ?? -1;
      const decRow = view.rows.findIndex((r) => r.cells[0]?.value === LAST_MONTH);
      const layout = view.rows.map((r) => r.cells.map((c) => String(c.value ?? "")).join(" | "));
      console.log(`[overlay-pivot] view:\n  ${layout.join("\n  ")}`);
      expect(gadgetsCol, `a Gadgets column: ${layout[0]}`).toBeGreaterThan(0);
      expect(decRow, `a ${LAST_MONTH} row`).toBeGreaterThan(0);
      return {
        region: region!,
        gadgets: { row: region!.startRow + decRow, col: region!.startCol + gadgetsCol },
        total: { row: region!.startRow + decRow, col: region!.startCol + totalCol },
        rows: view.rows.length,
        cols: headerRow?.cells.length ?? 0,
      };
    };
    let where = await locate();
    const gadgetsRef = ref(where.gadgets.row, where.gadgets.col);
    console.log(`[overlay-pivot] Gadgets × ${LAST_MONTH} is ${gadgetsRef}; the month's total is ${ref(where.total.row, where.total.col)}`);

    // Capture the whole pivot before and after, and the Gadgets cell on its own.
    const pivotFrom = ref(where.region.startRow, where.region.startCol);
    const pivotTo = ref(where.region.endRow, where.region.endCol);
    await grid.navigateTo("A1");
    await appPage.waitForTimeout(300);
    const pivotClip = await rangeClip(appPage, pivotFrom, pivotTo);
    const cellClip = await rangeClip(appPage, gadgetsRef, gadgetsRef, 0);
    const off = await pixels(appPage, pivotClip);
    const cellOff = await pixels(appPage, cellClip);

    // --- DIAGNOSTICS FIRST: the model's facts, and the mapper over the view --
    // Two direct calls, so a failure further down names its stage: what Rust
    // computed (fact kinds, measures, labels), and what the mapper made of it
    // against this view (cues and DROP REASONS). Printed, never asserted.
    const bundle = await invoke<{ insights: Array<{ id: string; kind: string; text: string; provenance: Array<{ attribute: string; value: string }> }>; factsJson: string; notes: string[] }>(
      appPage,
      "insights_analyze_model",
      { request: { connectionId } },
    );
    const factsDoc = JSON.parse(bundle.factsJson) as { facts: Array<{ id: string; kind: Record<string, unknown> }> };
    console.log(`[overlay-pivot] model facts (${factsDoc.facts.length}): ${JSON.stringify(factsDoc.facts.map((f) => {
      const k = f.kind;
      const inner = k.inner as Record<string, unknown> | undefined;
      return [f.id, k.measure ?? (inner?.subject as { name?: string } | undefined)?.name, k.lastLabel ?? k.periodLabel ?? inner?.atLabel ?? inner?.bestLabel ?? null, k.favourability ?? null];
    }))}`);
    console.log(`[overlay-pivot] provenance: ${JSON.stringify(bundle.insights.map((i) => [i.id, i.provenance.find((p) => p.attribute === "direction")?.value ?? null]))}`);
    console.log(`[overlay-pivot] notes: ${JSON.stringify(bundle.notes)}`);
    // The defect this journey found on its first run: the fixture's derived
    // measures (Margin, MarginPct) carry no home table, the planner refuses
    // their series query, and the WHOLE analysis used to abort with it —
    // Revenue's facts included. Now the refusal is a note and the run goes on.
    const refused = bundle.notes.filter((n) => /was not analysed: /.test(n));
    expect(refused, "a refused measure is SAID in the notes, not fatal").not.toEqual([]);
    expect(factsDoc.facts.some((f) => String((f.kind.measure ?? "") as string) === "Revenue" || f.id.includes("m/Revenue")), "…and the other measures' facts survive it").toBe(true);
    const mapped = await appPage.evaluate(
      async ({ id, bundle, pivotMod, cuesMod }) => {
        const p = (await (window as unknown as AppWindow).__appImport!(pivotMod)) as {
          pivot: { getView: (id: string) => Promise<unknown>; getHierarchies: (id: string) => Promise<{ dataHierarchies: Array<{ name: string }> }> };
        };
        const m = (await (window as unknown as AppWindow).__appImport!(cuesMod)) as {
          pivotCuesFor: (b: unknown, v: unknown, f: string[]) => { cues: unknown[]; dropped: unknown[] };
        };
        const [view, h] = await Promise.all([p.pivot.getView(id), p.pivot.getHierarchies(id)]);
        const names = h.dataHierarchies.map((d) => d.name);
        const v = view as { rowFieldSummaries: unknown; columnFieldSummaries: unknown };
        return { names, rowFields: v.rowFieldSummaries, colFields: v.columnFieldSummaries, ...m.pivotCuesFor(bundle, view, names) };
      },
      { id: pivotId, bundle, pivotMod: PIVOT_API, cuesMod: "/src/api/pivotCues.ts" },
    );
    console.log(`[overlay-pivot] value fields=${JSON.stringify(mapped.names)} rowFields=${JSON.stringify(mapped.rowFields)} colFields=${JSON.stringify(mapped.colFields)}`);
    console.log(`[overlay-pivot] mapper: cues=${JSON.stringify(mapped.cues)} dropped=${JSON.stringify(mapped.dropped)}`);
    const direct = await appPage.evaluate(
      async ({ id, mod }) => {
        const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
          showSheetOverlay: (o: unknown) => Promise<unknown>;
          hideSheetOverlay: (o: unknown) => void;
        };
        const r = await m.showSheetOverlay({ kind: "pivot", pivotId: id });
        m.hideSheetOverlay({ kind: "pivot", pivotId: id });
        return JSON.stringify(r);
      },
      { id: pivotId, mod: SHEET_OVERLAY },
    );
    console.log(`[overlay-pivot] direct showSheetOverlay: ${direct.slice(0, 1500)}`);

    // --- ON, through the grid context menu inside the pivot -----------------
    const point = { x: cellClip.x + cellClip.width / 2, y: cellClip.y + cellClip.height / 2 };
    await appPage.mouse.move(point.x, point.y);
    await appPage.waitForTimeout(150);
    await appPage.mouse.click(point.x, point.y, { button: "right" });
    const menu = appPage.locator(GRID_MENU);
    await expect(menu, "the grid context menu must open inside the pivot").toBeVisible({ timeout: 5_000 });
    const show = menu.locator('[role="menuitem"]').filter({ hasText: /^Show points of interest$/ });
    await expect(show, "a click inside a pivot must be offered points of interest").toHaveCount(1);
    await show.click();

    const readCues = async () =>
      appPage.evaluate(
        async ({ mod }) => {
          const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
            listCellCueOwners: () => string[];
            getCellCues: (o: string) => CellCue[];
          };
          const owners = m.listCellCueOwners();
          return { owners, cues: owners.flatMap((o) => m.getCellCues(o)) };
        },
        { mod: CELL_CUES },
      );
    let cues = { owners: [] as string[], cues: [] as CellCue[] };
    for (let i = 0; i < 40; i++) {
      await appPage.waitForTimeout(500);
      cues = await readCues();
      if (cues.cues.length > 0) break;
    }
    await waitForGridStable(appPage);
    const toasts = await appPage.evaluate(() => [...document.querySelectorAll("[data-toast]")].map((t) => t.textContent ?? ""));
    console.log(`[overlay-pivot] owners=${JSON.stringify(cues.owners)} toasts=${JSON.stringify(toasts)}`);
    console.log(`[overlay-pivot] cues: ${JSON.stringify(cues.cues.map((c) => [c.description, c.polarity, ref(c.row, c.col)]))}`);
    expect(cues.owners, "one owner: the pivot").toEqual([`pivot:${pivotId}`]);

    const notice = await appPage.evaluate(
      async ({ id, mod }) => ((await (window as unknown as AppWindow).__appImport!(mod)) as { sheetOverlayNotice: (o: string) => string | null }).sheetOverlayNotice(`pivot:${id}`),
      { id: pivotId, mod: SHEET_OVERLAY },
    );
    console.log(`[overlay-pivot] notice: ${notice}`);
    expect(notice, "the notice must say the cues came from the MODEL, not from the displayed numbers").toContain("from the model");
    expect(notice, "a declared direction reached the cues").toContain("declared directions");

    // The planted fact: Gadgets collapsed in the last month; Revenue is higherIsBetter → BAD.
    const gadgets = cues.cues.find((c) => c.description === "Gadgets: Revenue down");
    expect(gadgets, `the contribution fact must name Gadgets; got ${JSON.stringify(cues.cues.map((c) => c.description))}`).toBeTruthy();
    expect([gadgets!.row, gadgets!.col, gadgets!.sheetIndex], "…on the Gadgets × 2025-12 cell, located from the view, not from the cue").toEqual([where.gadgets.row, where.gadgets.col, 0]);
    expect(gadgets!.polarity, "coloured by the strategy (higherIsBetter, a fall): bad").toBe("bad");
    const change = cues.cues.find((c) => /^Revenue down/.test(c.description));
    expect(change, "the change fact must land on the month's total").toBeTruthy();
    expect([change!.row, change!.col], "…in the Grand Total column of the 2025-12 row").toEqual([where.total.row, where.total.col]);
    expect(change!.polarity).toBe("bad");
    for (const c of cues.cues) {
      expect(c.row >= where.region.startRow && c.row <= where.region.endRow && c.col >= where.region.startCol && c.col <= where.region.endCol, `every cue lies inside the pivot: ${JSON.stringify(c)}`).toBe(true);
    }

    const cellOn = await pixels(appPage, cellClip);
    expect(diffCount(cellOff, cellOn), "POSITIVE CONTROL: the Gadgets cell's pixels must change").toBeGreaterThan(10);
    const on = await pixels(appPage, pivotClip);
    expect(diffCount(off, on)).toBeGreaterThan(10);
    await appPage.mouse.move(4, 4);
    await appPage.waitForTimeout(300);
    await takeRegionScreenshot(appPage, "insight-overlay-pivot-model", pivotClip);

    // --- FOLLOW THE DATA: hide the category to the LEFT of Gadgets -----------
    // Doodads sorts before Gadgets, so hiding it moves the Gadgets column one
    // step left; the cue must move with it (re-resolved by label, never kept
    // by position). The pivot's region event is counted and the console's
    // warnings collected, so a cue that stays put is diagnosable: no event,
    // or a recompute that was refused.
    const warnings: string[] = [];
    appPage.on("console", (msg) => {
      if (msg.type() === "warning" || msg.type() === "error") warnings.push(msg.text());
    });
    await appPage.evaluate(async () => {
      const ev = (await (window as unknown as AppWindow).__appImport!("/src/api/events.ts")) as { onAppEvent: (n: string, cb: () => void) => () => void };
      const w = window as unknown as { __overlayPivotEvents?: number };
      w.__overlayPivotEvents = 0;
      ev.onAppEvent("app:pivot-regions-updated", () => { w.__overlayPivotEvents = (w.__overlayPivotEvents ?? 0) + 1; });
    });
    await filterField("Product.Category", ["Gadgets", "Gizmos", "Trinkets", "Widgets"]);
    let moved: CellCue | undefined;
    for (let i = 0; i < 30; i++) {
      await appPage.waitForTimeout(500);
      moved = (await readCues()).cues.find((c) => c.description === "Gadgets: Revenue down");
      if (moved && moved.col === where.gadgets.col - 1) break;
    }
    await waitForGridStable(appPage);
    where = await locate();
    const regionEvents = await appPage.evaluate(() => (window as unknown as { __overlayPivotEvents?: number }).__overlayPivotEvents ?? -1);
    console.log(`[overlay-pivot] after hiding Doodads: Gadgets cue at ${moved ? ref(moved.row, moved.col) : "none"}; view says ${gadgetsRef} → ${ref(where.gadgets.row, where.gadgets.col)}; region events=${regionEvents}; warnings=${JSON.stringify(warnings.filter((w) => w.includes("Insights")))}`);
    expect(where.gadgets.col, "POSITIVE CONTROL: the view's Gadgets column moved left").toBe(colOf(gadgetsRef) - 1);
    expect(moved && [moved.row, moved.col], "the cue followed the member to its new column").toEqual([where.gadgets.row, where.gadgets.col]);

    // --- HIDE, through the same menu, whose label has flipped ---------------
    const newCell = await rangeClip(appPage, ref(where.gadgets.row, where.gadgets.col), ref(where.gadgets.row, where.gadgets.col), 0);
    await appPage.mouse.click(newCell.x + newCell.width / 2, newCell.y + newCell.height / 2, { button: "right" });
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await menu.locator('[role="menuitem"]').filter({ hasText: /^Hide points of interest$/ }).click();
    await appPage.waitForTimeout(600);
    expect((await readCues()).owners).toEqual([]);
  });
});

/** The zero-based column index of a cell reference's letters. */
function colOf(cellRef: string): number {
  const letters = /^[A-Z]+/.exec(cellRef)?.[0] ?? "";
  let idx = 0;
  for (const ch of letters) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
}
