/**
 * FIX-ALL WAVE, AREA "life" -- extension lifecycle, menus and the doors a
 * floating-grid selection must not reach, PROVED LIVE.
 *
 * Six fix waves changed how built-in extensions give back what they register
 * (W20/W21, X18-X20, Y14/Y15, Z5), how contextual tabs behave while a
 * selection owner claims the selection (W22), what a model-pivot dialog names
 * as its destination (W23) and what the prefill/act-at-cell doors do while a
 * floating grid's cell holds the selection (W24, X3). Unit gates were green;
 * nothing had been seen in the running app. This spec is the live proof.
 *
 * HOW A BUILT-IN IS TAKEN DOWN. Built-ins cannot be disabled in the
 * Extensions panel (ExtensionManager refuses), so the checks run through the
 * DEV/E2E-only door wave E added, `window.__CALCULA_EXTENSION_LIFECYCLE__`
 * (`deactivate` / `activate` / `builtIns`). Every test that takes one down
 * puts it back in `finally`.
 *
 * WHAT IS READ. The registries themselves (the app's OWN module instances of
 * `@api/ui`, `@api/extensions`, `@api/commands` -- see helpers/life-lifecycle)
 * AND the rendered menu bar / context menus / ribbon tab strip / dialogs, and
 * the backend where a door acts on the document. Every refusal is paired with
 * a positive control that performs the same gesture where it must act.
 *
 * SHARED APP. Each test starts and ends with the app's own File > New
 * (`newFile` from file-api, never a raw `new_file`: BUG-0205).
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import type { GridHelper } from "../helpers/grid";
import { resetToNewWorkbook } from "../helpers/screenshots";
import {
  allKeys,
  appNewFile,
  builtIns,
  callModule,
  clickFrCell,
  clickMenuPath,
  closeDialogs,
  createFr,
  deleteFr,
  dismissToasts,
  duplicates,
  eventually,
  gridContextMenuLabels,
  gridSelection,
  hasItem,
  installAppImport,
  invoke,
  labelsIn,
  lifecycle,
  menuIds,
  multisetMinus,
  reactivateAll,
  renderedMenuBar,
  renderedMenuItems,
  ribbonTabs,
  selectionOwned,
  snapshot,
  statusOf,
  toastTexts,
  type LifeWindow,
  type RegistrySnapshot,
} from "../helpers/life-lifecycle";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A floating grid on Sheet1, clear of every seeded patch (A1:E6).
const FR_X = 420;
const FR_Y = 180;

const CHART_STORE = "/extensions/Charts/lib/chartStore.ts";
const TRACING_STORE = "/extensions/Tracing/lib/tracingStore.ts";
const CELL_TYPES = "/src/api/cellTypes.ts";
const PIVOT_API = "/extensions/Pivot/lib/pivot-api.ts";
const QA_KEY = "calcula:quickAccess:pinnedIds";

// ---------------------------------------------------------------------------
// Small plumbing
// ---------------------------------------------------------------------------

async function writeCells(page: Page, cells: Array<[number, number, string]>): Promise<void> {
  for (const [row, col, value] of cells) await invoke(page, "update_cell", { row, col, value });
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(250);
}

async function cellDisplay(page: Page, row: number, col: number): Promise<string> {
  const c = await invoke<{ display?: string } | null>(page, "get_cell", { row, col });
  return String(c?.display ?? "");
}

function count(list: string[] | null, label: string): number {
  return (list ?? []).filter((l) => l === label).length;
}

/** Registry and rendered-menu counts of every label, for messages. */
function fmt(v: unknown): string {
  return JSON.stringify(v);
}

/** After activate, the registries settle (a shell component re-mounts, effects run): poll to equality. */
async function expectRestored(page: Page, before: RegistrySnapshot, label: string): Promise<void> {
  const beforeKeys = allKeys(before);
  const dupBefore = new Set(duplicates(beforeKeys));
  let last: string[] = [];
  try {
    await eventually(
      async () => {
        last = allKeys(await snapshot(page));
        return last;
      },
      (k) => multisetMinus(beforeKeys, k).length === 0 && multisetMinus(k, beforeKeys).length === 0,
      `${label}: registries not restored`,
      6000,
    );
  } catch {
    // fall through to the precise assertions below
  }
  expect.soft(multisetMinus(beforeKeys, last), `${label}: missing after re-activation`).toEqual([]);
  expect.soft(multisetMinus(last, beforeKeys), `${label}: extra (duplicated or leaked) after re-activation`).toEqual([]);
  expect.soft(duplicates(last).filter((k) => !dupBefore.has(k)), `${label}: new duplicate ids`).toEqual([]);
}

async function takeDown(page: Page, id: string): Promise<void> {
  const err = await lifecycle(page, "deactivate", id);
  expect(err, `deactivate ${id} was refused`).toBeNull();
  expect(await statusOf(page, id), `${id} is not inactive after deactivate`).toBe("inactive");
  await page.waitForTimeout(200);
}

async function bringUp(page: Page, id: string): Promise<void> {
  const err = await lifecycle(page, "activate", id);
  expect(err, `activate ${id} was refused or failed`).toBeNull();
  expect(await statusOf(page, id), `${id} is not active after activate`).toBe("active");
  await page.waitForTimeout(250);
}

async function extCommandExists(page: Page, id: string): Promise<boolean> {
  return page.evaluate((id) => !!(window as unknown as LifeWindow).__CALCULA_EXTENSION_REGISTRY__?.getCommand(id), id);
}

/** A cell-type Button at (row, col) bound to an extension-registry command (the Button... dialog's own call). */
async function buttonBoundTo(page: Page, row: number, col: number, commandId: string): Promise<void> {
  await callModule(page, CELL_TYPES, "setCellTypeRange", [
    row,
    col,
    row,
    col,
    "calcula.button",
    { label: "LifeButton", action: { kind: "command", commandId } },
  ]);
  await page.waitForTimeout(300);
}

/** Click the button cell (after moving away, so the click is a fresh press) and collect the toasts it raised. */
async function pressButton(page: Page, grid: GridHelper, ref: string): Promise<string[]> {
  await grid.clickCell("H12");
  await dismissToasts(page);
  await grid.clickCell(ref);
  await page.waitForTimeout(900);
  return toastTexts(page);
}

/** Seed A1:C5 (a header row and four numeric rows) on the active sheet. */
async function seedTable(page: Page): Promise<void> {
  await writeCells(page, [
    [0, 0, "Region"], [0, 1, "Units"], [0, 2, "Price"],
    [1, 0, "North"], [1, 1, "10"], [1, 2, "3"],
    [2, 0, "South"], [2, 1, "40"], [2, 2, "5"],
    [3, 0, "East"], [3, 1, "20"], [3, 2, "7"],
    [4, 0, "West"], [4, 1, "30"], [4, 2, "9"],
  ]);
}

/** A floating grid at (FR_X, FR_Y), one of its cells clicked: the selection is OWNED. */
async function holdFloatingCell(page: Page): Promise<string> {
  const fr = await createFr(page, FR_X, FR_Y, "LifeFloat");
  await page.waitForTimeout(400);
  await clickFrCell(page, FR_X, FR_Y, 0, 0);
  await eventually(() => selectionOwned(page), (v) => v === true, "a floating-grid cell click did not take the selection");
  return fr.id;
}

/**
 * Click the floating grid's cell again. A new range is ONE cell (1 x 1), so its
 * A1 is the only cell there is; a press that only selected the frame is
 * followed by a second one.
 */
async function reclaimFloatingCell(page: Page): Promise<void> {
  await clickFrCell(page, FR_X, FR_Y, 0, 0);
  if (!(await selectionOwned(page))) {
    await page.waitForTimeout(300);
    await clickFrCell(page, FR_X, FR_Y, 0, 0);
  }
  await eventually(() => selectionOwned(page), (v) => v === true, "a floating-grid cell click did not take the selection");
}

// ===========================================================================
// Y15 -- the dev lifecycle door itself
// ===========================================================================

test.describe("extension lifecycle through the dev hook (Y15)", () => {
  test("Y15 builtIns lists every built-in active; activate refuses an active or unknown id; a deactivate/activate round trip works", async ({
    appPage: page,
  }) => {
    test.setTimeout(60_000);
    try {
      await appNewFile(page);
      const list = await builtIns(page);
      expect(list.length, "builtIns() lists the loaded built-ins").toBeGreaterThan(60);
      expect(list.filter((e) => e.status !== "active"), "every built-in is active at rest").toEqual([]);
      for (const id of ["calcula.sorting", "calcula.builtin.standard-menus", "calcula.reports", "calcula.tracing"]) {
        expect(list.map((e) => e.id), `builtIns() lists ${id}`).toContain(id);
      }

      // Refusals.
      expect(await lifecycle(page, "activate", "calcula.sorting"), "activate of an active built-in").toMatch(/already active/i);
      expect(await lifecycle(page, "activate", "calcula.no-such-extension"), "activate of an unknown id").toMatch(/not a loaded built-in/i);
      expect(await lifecycle(page, "deactivate", "calcula.no-such-extension"), "deactivate of an unknown id").toMatch(/not a loaded built-in/i);

      // Positive control: the same door DOES take a built-in down and back.
      await takeDown(page, "calcula.sorting");
      expect(await lifecycle(page, "deactivate", "calcula.sorting"), "a second deactivate is refused").toMatch(/not active/i);
      await bringUp(page, "calcula.sorting");
      expect(await lifecycle(page, "activate", "calcula.sorting"), "and is then active again").toMatch(/already active/i);
    } finally {
      await reactivateAll(page, ["calcula.sorting"]);
      await appNewFile(page);
    }
  });

  test("Y15 re-activation gets the extension's own context: AutoRecover re-reads its backend settings and File > AutoRecover shows them", async ({
    appPage: page,
  }) => {
    test.setTimeout(90_000);
    const ID = "calcula.auto-recover";
    const original = await invoke<{ enabled: boolean; intervalMs: number }>(page, "get_auto_recover_settings");
    const readChecks = () =>
      page.evaluate(async () => {
        const ui = (await (window as unknown as LifeWindow).__appImport!("/src/api/ui.ts")) as {
          getMenus: () => Array<{ id: string; items: Array<{ id: string; checked?: boolean; children?: Array<{ id: string; checked?: boolean }> }> }>;
        };
        const file = ui.getMenus().find((m) => m.id === "file");
        const toggle = file?.items.find((i) => i.id === "file:autoRecover:toggle");
        const interval = file?.items.find((i) => i.id === "file:autoRecover:interval");
        return {
          toggle: toggle ? !!toggle.checked : null,
          checkedIntervals: (interval?.children ?? []).filter((c) => c.checked).map((c) => c.id),
        };
      });
    try {
      await appNewFile(page);
      await installAppImport(page);
      const before = await readChecks();
      expect(before.toggle, "File > AutoRecover shows the backend's enabled flag").toBe(original.enabled);
      expect(before.checkedIntervals, "File > AutoRecover Interval ticks the backend's interval").toEqual([
        `file:autoRecover:interval:${original.intervalMs}`,
      ]);

      await takeDown(page, ID);
      expect((await readChecks()).toggle, "File > AutoRecover left with the extension").toBeNull();

      // Change the BACKEND setting while the extension is down: only an
      // activation whose context really reaches the backend can show it.
      const other = original.intervalMs === 600_000 ? 900_000 : 600_000;
      await invoke(page, "set_auto_recover_settings", { enabled: original.enabled, intervalMs: other });

      await bringUp(page, ID);
      const after = await readChecks();
      expect(after.toggle, "File > AutoRecover is back with the enabled flag").toBe(original.enabled);
      expect(after.checkedIntervals, "the re-activated extension read the NEW interval through context.invokeBackend").toEqual([
        `file:autoRecover:interval:${other}`,
      ]);
      const rendered = await renderedMenuItems(page, "File");
      expect(count(rendered, "AutoRecover"), `File shows AutoRecover once (${fmt(rendered)})`).toBe(1);
      expect(count(rendered, "AutoRecover Interval"), "File shows AutoRecover Interval once").toBe(1);
    } finally {
      await invoke(page, "set_auto_recover_settings", { enabled: original.enabled, intervalMs: original.intervalMs }).catch(() => {});
      // Re-read the restored setting into the extension.
      if ((await statusOf(page, ID)) === "active") {
        await lifecycle(page, "deactivate", ID);
      }
      await reactivateAll(page, [ID]);
      await appNewFile(page);
    }
  });
});

// ===========================================================================
// Y14 / Z5 -- every contributor takes back its own items, and only them
// ===========================================================================

interface MenuExpectation {
  /** Registry id of the menu. */
  menu: string;
  /** Its menu-bar label. */
  bar: string;
  /** Top-level labels the extension owns (gone while it is off, back once). */
  gone: string[];
  /** Top-level labels OTHER extensions own that must stay. */
  stay?: string[];
}

const ROUND_TRIPS: Array<{ id: string; menus: MenuExpectation[] }> = [
  { id: "calcula.sorting", menus: [{ menu: "data", bar: "Data", gone: ["Sort A to Z", "Sort Z to A", "Custom Sort..."], stay: ["Filter", "Advanced...", "Outline"] }] },
  { id: "calcula.remove-duplicates", menus: [{ menu: "data", bar: "Data", gone: ["Remove Duplicates..."], stay: ["Sort A to Z"] }] },
  { id: "calcula.text-to-columns", menus: [{ menu: "data", bar: "Data", gone: ["Text to Columns..."], stay: ["Sort A to Z"] }] },
  { id: "calcula.flash-fill", menus: [{ menu: "data", bar: "Data", gone: ["Flash Fill"], stay: ["Sort A to Z"] }] },
  { id: "calcula.advanced-filter", menus: [{ menu: "data", bar: "Data", gone: ["Advanced..."], stay: ["Filter"] }] },
  { id: "calcula.data-form", menus: [{ menu: "data", bar: "Data", gone: ["Data Form..."], stay: ["Sort A to Z"] }] },
  { id: "calcula.consolidate", menus: [{ menu: "data", bar: "Data", gone: ["Consolidate..."], stay: ["Sort A to Z"] }] },
  { id: "calcula.data-validation", menus: [{ menu: "data", bar: "Data", gone: ["Validation"], stay: ["Sort A to Z"] }] },
  { id: "calcula.custom-fill-lists", menus: [{ menu: "edit", bar: "Edit", gone: ["Custom Lists..."], stay: ["Undo", "Find..."] }] },
  { id: "calcula.select-visible-cells", menus: [{ menu: "edit", bar: "Edit", gone: ["Select Visible Cells"], stay: ["Undo"] }] },
  { id: "calcula.editing-options", menus: [{ menu: "edit", bar: "Edit", gone: ["Move Selection After Enter", "Move Direction"], stay: ["Undo"] }] },
  { id: "calcula.calculation-options", menus: [{ menu: "formulas", bar: "Formulas", gone: ["Calculation Options", "Calculate"], stay: ["Trace Precedents"] }] },
  { id: "calcula.evaluate-formula", menus: [{ menu: "formulas", bar: "Formulas", gone: ["Evaluate Formula..."], stay: ["Trace Precedents"] }] },
  { id: "calcula.custom-functions", menus: [{ menu: "formulas", bar: "Formulas", gone: ["Custom Functions..."], stay: ["Trace Precedents"] }] },
  { id: "calcula.watch-window", menus: [{ menu: "formulas", bar: "Formulas", gone: ["Watch Window"], stay: ["Trace Precedents"] }] },
  { id: "calcula.pivot", menus: [{ menu: "formulas", bar: "Formulas", gone: ["Generate GetPivotData"], stay: ["Trace Precedents"] }] },
  { id: "calcula.conditional-formatting", menus: [{ menu: "format", bar: "Format", gone: ["Conditional Formatting"], stay: ["Format Cells..."] }] },
  { id: "calcula.hyperlinks", menus: [{ menu: "insert", bar: "Insert", gone: ["Hyperlink...", "Follow Hyperlink"], stay: ["Table..."] }] },
  {
    id: "calcula.controls",
    menus: [
      { menu: "insert", bar: "Insert", gone: ["Controls", "Shapes", "Image"], stay: ["Table..."] },
      { menu: "developer", bar: "Developer", gone: ["Design Mode"], stay: ["AI Chat"] },
    ],
  },
  {
    id: "calcula.print",
    menus: [
      { menu: "file", bar: "File", gone: ["Print", "Export to PDF...", "Page Setup..."], stay: ["New", "Save"] },
      { menu: "view", bar: "View", gone: ["Page Breaks", "Print Area"], stay: ["Freeze Panes"] },
    ],
  },
  { id: "calcula.auto-recover", menus: [{ menu: "file", bar: "File", gone: ["AutoRecover", "AutoRecover Interval"], stay: ["New", "Save"] }] },
  {
    id: "calcula.review",
    menus: [
      {
        menu: "review",
        bar: "Review",
        gone: ["New Comment", "New Note", "Show All Comments", "Show All Notes", "Delete All Comments in Sheet", "Delete All Notes in Sheet"],
        stay: ["Protect Sheet...", "Protect Workbook...", "Cell Protection..."],
      },
    ],
  },
  {
    id: "calcula.json-view",
    menus: [
      { menu: "developer", bar: "Developer", gone: ["Workbook Explorer"], stay: ["AI Chat"] },
      { menu: "view", bar: "View", gone: ["JSON View"], stay: ["Freeze Panes"] },
    ],
  },
  { id: "calcula.ai-chat", menus: [{ menu: "developer", bar: "Developer", gone: ["MCP Server", "AI Chat"], stay: ["Macros…"] }] },
  { id: "calcula.model-editor", menus: [{ menu: "model", bar: "Model", gone: ["Model Editor...", "Import Model...", "Export Model..."], stay: ["Connections"] }] },
];

/** One extension's round trip, soft-asserted so one extension's failure cannot hide another's. */
async function roundTrip(page: Page, id: string, menus: MenuExpectation[]): Promise<void> {
  const before = await snapshot(page);
  // Positive control: what must go is THERE, once, before.
  for (const m of menus) {
    for (const l of m.gone) {
      expect.soft(count(labelsIn(before, m.menu), l), `[${id}] precondition: ${m.bar} > ${l} registered once`).toBe(1);
    }
  }
  const dErr = await lifecycle(page, "deactivate", id);
  expect.soft(dErr, `[${id}] deactivate refused`).toBeNull();
  expect.soft(await statusOf(page, id), `[${id}] not inactive`).toBe("inactive");
  await page.waitForTimeout(200);
  const during = await snapshot(page);
  for (const m of menus) {
    const reg = labelsIn(during, m.menu);
    const shown = await renderedMenuItems(page, m.bar);
    expect.soft(shown, `[${id}] the ${m.bar} menu is still on the bar`).not.toBeNull();
    for (const l of m.gone) {
      expect.soft(count(reg, l), `[${id}] ${m.bar} > ${l} left behind in the registry`).toBe(0);
      expect.soft(count(shown, l), `[${id}] ${m.bar} > ${l} still RENDERED (${fmt(shown)})`).toBe(0);
    }
    for (const l of m.stay ?? []) {
      expect.soft(count(reg, l), `[${id}] ${m.bar} > ${l} (another extension's) was taken`).toBeGreaterThan(0);
      expect.soft(count(shown, l), `[${id}] ${m.bar} > ${l} (another extension's) not rendered`).toBeGreaterThan(0);
    }
  }
  const aErr = await lifecycle(page, "activate", id);
  expect.soft(aErr, `[${id}] activate refused or failed`).toBeNull();
  expect.soft(await statusOf(page, id), `[${id}] not active again`).toBe("active");
  await expectRestored(page, before, id);
  const after = await snapshot(page);
  for (const m of menus) {
    const shown = await renderedMenuItems(page, m.bar);
    for (const l of m.gone) {
      expect.soft(count(labelsIn(after, m.menu), l), `[${id}] ${m.bar} > ${l} back exactly once (registry)`).toBe(1);
      expect.soft(count(shown, l), `[${id}] ${m.bar} > ${l} back exactly once (rendered ${fmt(shown)})`).toBe(1);
    }
  }
}

test.describe("menu contributors take back their own items (Y14, Z5)", () => {
  test("Y14 round trip: 25 built-ins take back their own menu items, others' stay, each comes back exactly once", async ({
    appPage: page,
  }) => {
    test.setTimeout(420_000);
    try {
      await appNewFile(page);
      for (const { id, menus } of ROUND_TRIPS) {
        await roundTrip(page, id, menus);
      }
    } finally {
      await reactivateAll(page, ROUND_TRIPS.map((r) => r.id));
      await closeDialogs(page);
      await appNewFile(page);
    }
  });

  test("Y14 right-click menus: Watch Window's Add Watch and Pivot's Drill-through behavior... leave and come back once", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(150_000);
    try {
      await appNewFile(page);
      await seedTable(page);
      // A real pivot on Sheet1 at E1, from A1:B5.
      const view = await callModule<{ pivotId: string }>(page, PIVOT_API, "createPivotTable", [
        { sourceRange: "Sheet1!A1:B5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0, hasHeaders: true, name: "LifePivot" },
      ]);
      await callModule(page, PIVOT_API, "updatePivotFields", [
        { pivotId: String(view.pivotId), rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [{ sourceIndex: 1, name: "Sum of Units", aggregation: "sum" }] },
      ]);
      await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
      await eventually(() => cellDisplay(page, 1, 4), (v) => v !== "", "the pivot never rendered at E2");

      const cellB2 = await grid.cellCenterScrollAware("B2");
      const pivotCell = await grid.cellCenterScrollAware("F2");
      const addWatch = /^Add Watch$/;
      const drill = /^Drill-through behavior\.\.\.$/i;
      const n = (items: string[][], re: RegExp) => items.filter((lines) => lines.some((l) => re.test(l))).length;

      // --- Watch Window -------------------------------------------------------
      await grid.clickCell("B2");
      expect(n(await gridContextMenuLabels(page, cellB2), addWatch), "precondition: Add Watch in the cell menu").toBe(1);
      await takeDown(page, "calcula.watch-window");
      expect(n(await gridContextMenuLabels(page, cellB2), addWatch), "Add Watch left behind after deactivate").toBe(0);
      await bringUp(page, "calcula.watch-window");
      expect(n(await gridContextMenuLabels(page, cellB2), addWatch), "Add Watch back exactly once").toBe(1);

      // --- Pivot ------------------------------------------------------------
      await grid.clickCell("F2");
      expect(n(await gridContextMenuLabels(page, pivotCell), drill), "precondition: Drill-through behavior... in the pivot menu").toBe(1);
      await takeDown(page, "calcula.pivot");
      expect(n(await gridContextMenuLabels(page, pivotCell), drill), "Drill-through behavior... left behind after deactivate").toBe(0);
      await bringUp(page, "calcula.pivot");
      await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
      await page.waitForTimeout(600);
      expect(n(await gridContextMenuLabels(page, pivotCell), drill), "Drill-through behavior... back exactly once").toBe(1);
    } finally {
      await reactivateAll(page, ["calcula.watch-window", "calcula.pivot"]);
      await closeDialogs(page);
      await appNewFile(page);
    }
  });

  test("Z5 Reports takes back Model > Report from Design Query... and Manage Reports... and nothing else; activate brings each back once", async ({
    appPage: page,
  }) => {
    test.setTimeout(90_000);
    const ID = "calcula.reports";
    try {
      await appNewFile(page);
      const before = await snapshot(page);
      const modelBefore = labelsIn(before, "model")!;
      expect(count(modelBefore, "Report from Design Query..."), "precondition").toBe(1);
      expect(count(modelBefore, "Manage Reports..."), "precondition").toBe(1);

      await takeDown(page, ID);
      const during = await snapshot(page);
      const modelDuring = labelsIn(during, "model");
      expect(modelDuring, "the shared Model menu stays").not.toBeNull();
      expect(modelDuring, "Model lost exactly Reports' two items").toEqual(
        modelBefore.filter((l) => l !== "Report from Design Query..." && l !== "Manage Reports..."),
      );
      const shown = await renderedMenuItems(page, "Model");
      expect(count(shown, "Report from Design Query..."), `rendered Model (${fmt(shown)})`).toBe(0);
      expect(count(shown, "Manage Reports..."), "rendered Model").toBe(0);
      for (const l of modelBefore.filter((x) => x !== "Report from Design Query..." && x !== "Manage Reports...")) {
        expect(count(shown, l), `every other Model item stays: ${l}`).toBe(1);
      }

      await bringUp(page, ID);
      await expectRestored(page, before, ID);
      const back = await renderedMenuItems(page, "Model");
      expect(count(back, "Report from Design Query..."), `back once (${fmt(back)})`).toBe(1);
      expect(count(back, "Manage Reports..."), "back once").toBe(1);
    } finally {
      await reactivateAll(page, [ID]);
      await appNewFile(page);
    }
  });
});

// ===========================================================================
// W20 -- whole menus go with their builder
// ===========================================================================

test.describe("menus built by an extension leave with it (W20)", () => {
  test("W20 Standard Menus: File, Edit, Format, View and Insert leave the bar and come back once; Edit > Format Painter once", async ({
    appPage: page,
  }) => {
    test.setTimeout(90_000);
    const ID = "calcula.builtin.standard-menus";
    const OWN = ["File", "Edit", "Format", "View", "Insert"];
    try {
      await appNewFile(page);
      const before = await snapshot(page);
      const barBefore = await renderedMenuBar(page);
      for (const l of OWN) expect(count(barBefore, l), `precondition: ${l} on the bar (${fmt(barBefore)})`).toBe(1);

      await takeDown(page, ID);
      await page.waitForTimeout(400);
      const barDuring = await renderedMenuBar(page);
      for (const l of OWN) expect(count(barDuring, l), `${l} still on the bar (${fmt(barDuring)})`).toBe(0);
      expect(barDuring, "the other menus (Data, Formulas, Review ...) stay").toEqual(barBefore.filter((l) => !OWN.includes(l)));
      const reg = menuIds(await snapshot(page));
      for (const id of ["file", "edit", "format", "view", "insert"]) expect(reg, `menu ${id} left in the registry`).not.toContain(id);

      await bringUp(page, ID);
      await expectRestored(page, before, ID);
      const barAfter = await renderedMenuBar(page);
      for (const l of OWN) expect(count(barAfter, l), `${l} back exactly once (${fmt(barAfter)})`).toBe(1);
      const edit = await renderedMenuItems(page, "Edit");
      expect(count(edit, "Format Painter"), `Edit > Format Painter exactly once (${fmt(edit)})`).toBe(1);
    } finally {
      await reactivateAll(page, [ID]);
      await appNewFile(page);
    }
  });

  test("W20 Tracing: the Formulas menu leaves the bar and comes back with Name Manager and Paste Names once each", async ({
    appPage: page,
  }) => {
    test.setTimeout(90_000);
    const ID = "calcula.tracing";
    try {
      await appNewFile(page);
      const before = await snapshot(page);
      expect(count(await renderedMenuBar(page), "Formulas"), "precondition").toBe(1);

      await takeDown(page, ID);
      const bar = await renderedMenuBar(page);
      expect(count(bar, "Formulas"), `Formulas still on the bar (${fmt(bar)})`).toBe(0);
      expect(menuIds(await snapshot(page)), "formulas left in the registry").not.toContain("formulas");

      await bringUp(page, ID);
      await expectRestored(page, before, ID);
      expect(count(await renderedMenuBar(page), "Formulas"), "Formulas back exactly once").toBe(1);
      const f = await renderedMenuItems(page, "Formulas");
      expect(count(f, "Name Manager"), `Name Manager once (${fmt(f)})`).toBe(1);
      expect(count(f, "Paste Names..."), "Paste Names... once").toBe(1);
      expect(count(f, "Trace Precedents"), "Tracing's own items back").toBe(1);
    } finally {
      await reactivateAll(page, [ID]);
      await appNewFile(page);
    }
  });
});

// ===========================================================================
// X18 -- shared submenus keep the other contributors' items
// ===========================================================================

test.describe("shared submenus (X18, wc-ext review finding 1)", () => {
  const WHATIF = ["calcula.goal-seek", "calcula.data-tables", "calcula.solver", "calcula.scenario-manager"];

  test("X18 What-If Analysis: Scenario Manager and Solver each take back only their child; all four off removes the submenu", async ({
    appPage: page,
  }) => {
    test.setTimeout(150_000);
    const ALL = ["Goal Seek...", "Scenario Manager...", "What-If Data Table...", "Solver..."];
    try {
      await appNewFile(page);
      const before = await snapshot(page);
      const sub0 = await renderedMenuItems(page, "Data", ["What-If Analysis"]);
      for (const l of ALL) expect(count(sub0, l), `precondition: ${l} (${fmt(sub0)})`).toBe(1);

      for (const [id, own] of [["calcula.scenario-manager", "Scenario Manager..."], ["calcula.solver", "Solver..."]] as const) {
        await takeDown(page, id);
        const sub = await renderedMenuItems(page, "Data", ["What-If Analysis"]);
        expect(count(sub, own), `${own} still shown after ${id} went (${fmt(sub)})`).toBe(0);
        for (const l of ALL.filter((x) => x !== own)) expect(count(sub, l), `${l} was taken with ${id}`).toBe(1);
        await bringUp(page, id);
        const back = await renderedMenuItems(page, "Data", ["What-If Analysis"]);
        for (const l of ALL) expect(count(back, l), `${l} after ${id} came back (${fmt(back)})`).toBe(1);
      }

      for (const id of WHATIF) await takeDown(page, id);
      const data = await renderedMenuItems(page, "Data");
      expect(count(data, "What-If Analysis"), `the emptied submenu is gone (${fmt(data)})`).toBe(0);
      expect(hasItem(await snapshot(page), "data", "data:whatIf"), "data:whatIf left in the registry").toBe(false);
      expect(count(data, "Sort A to Z"), "the Data menu itself stays").toBe(1);

      for (const id of WHATIF) await bringUp(page, id);
      await expectRestored(page, before, "What-If x4");
      const again = await renderedMenuItems(page, "Data", ["What-If Analysis"]);
      for (const l of ALL) expect(count(again, l), `${l} after all four came back (${fmt(again)})`).toBe(1);
    } finally {
      await reactivateAll(page, WHATIF);
      await appNewFile(page);
    }
  });

  test("X18 Outline: Grouping and Subtotals each take back only their own Outline items; both off removes Outline", async ({
    appPage: page,
  }) => {
    test.setTimeout(120_000);
    const GROUPING = ["Group", "Ungroup", "Show Level", "Clear Outline", "Group Settings..."];
    try {
      await appNewFile(page);
      const before = await snapshot(page);
      const o0 = await renderedMenuItems(page, "Data", ["Outline"]);
      for (const l of [...GROUPING, "Subtotals..."]) expect(count(o0, l), `precondition: ${l} (${fmt(o0)})`).toBe(1);

      await takeDown(page, "calcula.grouping");
      const o1 = await renderedMenuItems(page, "Data", ["Outline"]);
      expect(o1, "Outline shows only Subtotals... with Grouping off").toEqual(["Subtotals..."]);
      await bringUp(page, "calcula.grouping");
      const o2 = await renderedMenuItems(page, "Data", ["Outline"]);
      for (const l of [...GROUPING, "Subtotals..."]) expect(count(o2, l), `${l} once after Grouping came back (${fmt(o2)})`).toBe(1);

      await takeDown(page, "calcula.subtotals");
      const o3 = await renderedMenuItems(page, "Data", ["Outline"]);
      expect(count(o3, "Subtotals..."), `Subtotals... gone (${fmt(o3)})`).toBe(0);
      for (const l of GROUPING) expect(count(o3, l), `${l} kept with Subtotals off`).toBe(1);

      await takeDown(page, "calcula.grouping");
      const data = await renderedMenuItems(page, "Data");
      expect(count(data, "Outline"), `Outline gone with both off (${fmt(data)})`).toBe(0);

      await bringUp(page, "calcula.subtotals");
      await bringUp(page, "calcula.grouping");
      await expectRestored(page, before, "Outline");
      const o4 = await renderedMenuItems(page, "Data", ["Outline"]);
      for (const l of [...GROUPING, "Subtotals..."]) expect(count(o4, l), `${l} once at the end (${fmt(o4)})`).toBe(1);
    } finally {
      await reactivateAll(page, ["calcula.subtotals", "calcula.grouping"]);
      await appNewFile(page);
    }
  });
});

// ===========================================================================
// X19 -- menus shared or not, their owners take back what is theirs
// ===========================================================================

test.describe("menu owners (X19)", () => {
  test("X19 Data menu: AutoFilter takes back Filter / Clear Filter / Reapply only; Sort still sorts; Filter works again after re-activation", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(120_000);
    const ID = "calcula.auto-filter";
    const OWN = ["Filter", "Clear Filter", "Reapply"];
    try {
      await appNewFile(page);
      await writeCells(page, [[0, 0, "N"], [1, 0, "3"], [2, 0, "1"], [3, 0, "2"]]);
      const before = await snapshot(page);

      await takeDown(page, ID);
      const d = await renderedMenuItems(page, "Data");
      expect(d, "the Data menu stays").not.toBeNull();
      for (const l of OWN) expect(count(d, l), `${l} still shown (${fmt(d)})`).toBe(0);
      for (const l of ["Sort A to Z", "Outline", "What-If Analysis", "Notebook"]) expect(count(d, l), `${l} was taken`).toBe(1);

      // Sort still WORKS from the Data menu while AutoFilter is off.
      await grid.selectRange("A2", "A4");
      await clickMenuPath(page, ["Data", "Sort A to Z"]);
      await eventually(
        async () => [await cellDisplay(page, 1, 0), await cellDisplay(page, 2, 0), await cellDisplay(page, 3, 0)],
        (v) => v.join(",") === "1,2,3",
        "Data > Sort A to Z did not sort A2:A4 with AutoFilter off",
      );

      await bringUp(page, ID);
      await expectRestored(page, before, ID);
      const d2 = await renderedMenuItems(page, "Data");
      for (const l of OWN) expect(count(d2, l), `${l} back exactly once (${fmt(d2)})`).toBe(1);
      // ...and the re-activated Filter is LIVE.
      expect(await invoke(page, "get_auto_filter"), "precondition: no AutoFilter").toBeNull();
      await grid.clickCell("A1");
      await clickMenuPath(page, ["Data", "Filter"]);
      await eventually(() => invoke(page, "get_auto_filter"), (v) => v !== null, "Data > Filter created no AutoFilter after re-activation");
    } finally {
      await reactivateAll(page, [ID]);
      await appNewFile(page);
    }
  });

  test("X19 shared menus: Protection, Script Notebook, Model Menu and External Data leave what others still use; sheet-tab Insert / Rename / Delete still work", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    const IDS = ["calcula.protection", "calcula.script-notebook", "calcula.model-menu", "calcula.external-data"];
    try {
      await appNewFile(page);

      // --- Protection ---------------------------------------------------------
      {
        const before = await snapshot(page);
        await takeDown(page, "calcula.protection");
        const r = await renderedMenuItems(page, "Review");
        for (const l of ["New Comment", "New Note"]) expect(count(r, l), `Review keeps ${l} (${fmt(r)})`).toBe(1);
        for (const l of ["Protect Sheet...", "Protect Workbook...", "Cell Protection..."]) expect(count(r, l), `Review still shows ${l}`).toBe(0);
        const snap = await snapshot(page);
        for (const id of ["core:rename", "core:delete", "core:insertSheet"]) {
          expect(snap.sheetContext, `sheet-tab item ${id} lost with Protection`).toContain(id);
        }
        // They still WORK, through the tab's own right-click menu.
        const sheets = () => invoke<{ sheets: Array<{ name: string }>; activeIndex: number }>(page, "get_sheets");
        const tabMenuItem = (label: string) =>
          page
            .locator("button")
            .filter({ hasText: /^Insert Sheet$/ })
            .first()
            .locator("xpath=..")
            .locator("button")
            .filter({ hasText: new RegExp(`^${label}$`) })
            .first();
        await page.locator('button[data-sheet-tab="0"]').click({ button: "right" });
        await tabMenuItem("Insert Sheet").click();
        await eventually(async () => (await sheets()).sheets.length, (n) => n === 2, "tab menu > Insert Sheet added no sheet");
        await page.locator('button[data-sheet-tab="1"]').click({ button: "right" });
        await tabMenuItem("Rename").click();
        const prompt = page.locator("[data-calcula-prompt] input");
        await expect(prompt, "tab menu > Rename asked for no name").toHaveCount(1, { timeout: 5000 });
        await prompt.fill("LifeRenamed");
        await page.locator("[data-calcula-prompt] button").filter({ hasText: /^OK$/ }).click();
        await eventually(async () => (await sheets()).sheets[1]?.name, (n) => n === "LifeRenamed", "tab menu > Rename did not rename");
        await page.locator('button[data-sheet-tab="1"]').click({ button: "right" });
        await tabMenuItem("Delete").click();
        await page.getByText("Delete Sheet", { exact: true }).locator("xpath=..").locator("button").filter({ hasText: /^Delete$/ }).click();
        await eventually(async () => (await sheets()).sheets.length, (n) => n === 1, "tab menu > Delete removed no sheet");

        await bringUp(page, "calcula.protection");
        await expectRestored(page, before, "calcula.protection");
        const r2 = await renderedMenuItems(page, "Review");
        for (const l of ["Protect Sheet...", "Protect Workbook...", "Cell Protection...", "New Comment"]) {
          expect(count(r2, l), `${l} once after re-activation (${fmt(r2)})`).toBe(1);
        }
      }

      // --- Script Notebook ------------------------------------------------------
      {
        const before = await snapshot(page);
        await takeDown(page, "calcula.script-notebook");
        const dev = await renderedMenuItems(page, "Developer");
        for (const l of ["AI Chat", "Record Macro…", "Macros…"]) expect(count(dev, l), `Developer keeps ${l} (${fmt(dev)})`).toBe(1);
        expect(count(dev, "Notebook"), "Developer > Notebook left behind").toBe(0);
        expect(count(await renderedMenuItems(page, "Data"), "Notebook"), "Data > Notebook left behind").toBe(0);
        await bringUp(page, "calcula.script-notebook");
        await expectRestored(page, before, "calcula.script-notebook");
        expect(count(await renderedMenuItems(page, "Developer"), "Notebook"), "Developer > Notebook back once").toBe(1);
        expect(count(await renderedMenuItems(page, "Data"), "Notebook"), "Data > Notebook back once").toBe(1);
      }

      // --- Model Menu ----------------------------------------------------------
      {
        const before = await snapshot(page);
        const m0 = labelsIn(before, "model")!;
        await takeDown(page, "calcula.model-menu");
        const m1 = await renderedMenuItems(page, "Model");
        expect(m1, "the Model menu stays").not.toBeNull();
        expect([...(m1 ?? [])].sort(), "Model keeps every other extension's item").toEqual([...m0].sort());
        await bringUp(page, "calcula.model-menu");
        await expectRestored(page, before, "calcula.model-menu");
      }

      // --- External Data ---------------------------------------------------------
      {
        const before = await snapshot(page);
        await takeDown(page, "calcula.external-data");
        const e = await renderedMenuItems(page, "External Data");
        expect(e, "External Data stays while others' items are in it").not.toBeNull();
        for (const l of ["Get Data", "Refresh Data"]) expect(count(e, l), `External Data keeps ${l} (${fmt(e)})`).toBe(1);
        await bringUp(page, "calcula.external-data");
        await expectRestored(page, before, "calcula.external-data");
      }
    } finally {
      await reactivateAll(page, IDS);
      await closeDialogs(page);
      await appNewFile(page);
    }
  });

  test("X19 menus nobody else uses: Collaboration takes Collaboration, Writeback, Publish Model and Refresh Data; Quick Access keeps the stored pins", async ({
    appPage: page,
  }) => {
    test.setTimeout(150_000);
    const originalPins = await page.evaluate((k) => localStorage.getItem(k), QA_KEY);
    try {
      await appNewFile(page);

      // --- Collaboration ------------------------------------------------------
      {
        const before = await snapshot(page);
        await takeDown(page, "calcula.collaboration");
        const bar = await renderedMenuBar(page);
        expect(count(bar, "Collaboration"), `Collaboration still on the bar (${fmt(bar)})`).toBe(0);
        expect(count(bar, "Writeback"), "Writeback still on the bar").toBe(0);
        expect(count(await renderedMenuItems(page, "Model"), "Publish Model as Application..."), "Model > Publish Model left behind").toBe(0);
        const ext = await renderedMenuItems(page, "External Data");
        expect(count(ext, "Refresh Data"), `External Data > Refresh Data left behind (${fmt(ext)})`).toBe(0);
        expect(count(ext, "Get Data"), "External Data itself stays with Get Data").toBe(1);
        await bringUp(page, "calcula.collaboration");
        await expectRestored(page, before, "calcula.collaboration");
        const bar2 = await renderedMenuBar(page);
        expect(count(bar2, "Collaboration"), "Collaboration back once").toBe(1);
        expect(count(bar2, "Writeback"), "Writeback back once").toBe(1);
        expect(count(await renderedMenuItems(page, "Model"), "Publish Model as Application..."), "Publish Model back once").toBe(1);
        expect(count(await renderedMenuItems(page, "External Data"), "Refresh Data"), "Refresh Data back once").toBe(1);
      }

      // --- Quick Access: pin two through More..., the stored pins survive ------
      {
        await page.evaluate((k) => localStorage.removeItem(k), QA_KEY);
        await lifecycle(page, "deactivate", "calcula.quick-access");
        await bringUp(page, "calcula.quick-access");
        const pin = async (query: string) => {
          const bar = await renderedMenuBar(page);
          expect(count(bar, "Quick Access"), "precondition: Quick Access on the bar").toBe(1);
          const btn = page.locator("[data-life-menubar] > div > button").filter({ hasText: /^Quick Access$/ });
          await btn.click();
          await page.waitForTimeout(250);
          const more = btn.locator("xpath=../*[2]").locator("xpath=./div/button").filter({ hasText: /More\.\.\./ }).first();
          await more.hover();
          const search = page.locator('input[placeholder="Search commands..."]');
          await expect(search, "More... opened no command palette").toHaveCount(1, { timeout: 5000 });
          await search.fill(query);
          await page.waitForTimeout(250);
          await page.locator('button[title="Pin to Quick Access"]').first().click();
          await page.waitForTimeout(300);
          // The palette swallows Escape (its search box stops the key): close
          // the menu the way a user would, with its own bar button.
          await btn.click();
          await page.waitForTimeout(250);
          await expect(search, "the Quick Access menu did not close").toHaveCount(0);
        };
        await pin("Sort A to Z");
        await pin("Sort Z to A");
        const stored = await page.evaluate((k) => localStorage.getItem(k), QA_KEY);
        expect(JSON.parse(stored ?? "[]"), "two pins stored").toHaveLength(2);
        const qa0 = await renderedMenuItems(page, "Quick Access");
        expect(count(qa0, "Sort A to Z"), `pinned (${fmt(qa0)})`).toBe(1);
        expect(count(qa0, "Sort Z to A"), "pinned").toBe(1);

        await takeDown(page, "calcula.quick-access");
        expect(count(await renderedMenuBar(page), "Quick Access"), "the Quick Access menu left the bar").toBe(0);
        expect(menuIds(await snapshot(page)), "quickAccess left in the registry").not.toContain("quickAccess");
        expect(await page.evaluate((k) => localStorage.getItem(k), QA_KEY), "deactivate overwrote the stored pins").toBe(stored);

        // In place of the reload: the next activation loads from the same store.
        await bringUp(page, "calcula.quick-access");
        const qa1 = await renderedMenuItems(page, "Quick Access");
        expect(count(qa1, "Sort A to Z"), `the pins came back (${fmt(qa1)})`).toBe(1);
        expect(count(qa1, "Sort Z to A"), "the pins came back").toBe(1);
      }
    } finally {
      await reactivateAll(page, ["calcula.collaboration"]);
      await page.evaluate(
        ({ k, v }) => {
          if (v === null) localStorage.removeItem(k);
          else localStorage.setItem(k, v);
        },
        { k: QA_KEY, v: originalPins },
      );
      if ((await statusOf(page, "calcula.quick-access")) === "active") await lifecycle(page, "deactivate", "calcula.quick-access");
      await reactivateAll(page, ["calcula.quick-access"]);
      await closeDialogs(page);
      await appNewFile(page);
    }
  });
});

// ===========================================================================
// X20 / W21 -- commands go with their extension
// ===========================================================================

test.describe("commands and items after deactivate (X20, W21)", () => {
  test("X20 Standard Cell Types, Checkbox and Charts take back their commands; a shadow registration outlives the owner's teardown", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(150_000);
    const IDS = ["calcula.cell-types-standard", "calcula.checkbox", "calcula.charts"];
    try {
      await appNewFile(page);

      // --- Standard Cell Types --------------------------------------------------
      expect(await extCommandExists(page, "cellTypes.insertCheckbox"), "precondition").toBe(true);
      expect(count(await renderedMenuItems(page, "Insert"), "Cell Type"), "precondition").toBe(1);
      await takeDown(page, "calcula.cell-types-standard");
      expect(await extCommandExists(page, "cellTypes.insertCheckbox"), "cellTypes.insertCheckbox left behind").toBe(false);
      expect(count(await renderedMenuItems(page, "Insert"), "Cell Type"), "Insert > Cell Type left behind").toBe(0);
      await bringUp(page, "calcula.cell-types-standard");
      expect(await extCommandExists(page, "cellTypes.insertCheckbox"), "command back").toBe(true);
      expect(count(await renderedMenuItems(page, "Insert"), "Cell Type"), "Insert > Cell Type back once").toBe(1);

      // --- Checkbox: a Button bound to checkbox.toggle --------------------------
      await buttonBoundTo(page, 0, 0, "checkbox.toggle");
      const NOT_REG = 'Button command "checkbox.toggle" is not registered';
      expect(await extCommandExists(page, "checkbox.toggle"), "precondition").toBe(true);
      expect((await pressButton(page, grid, "A1")).filter((t) => t.includes(NOT_REG)), "while Checkbox is active the button runs").toEqual([]);
      await takeDown(page, "calcula.checkbox");
      expect(await extCommandExists(page, "checkbox.toggle"), "checkbox.toggle left behind").toBe(false);
      const refused = (await pressButton(page, grid, "A1")).filter((t) => t.includes(NOT_REG));
      expect(refused, "the bound button reports the missing command, once").toEqual([NOT_REG]);
      await bringUp(page, "calcula.checkbox");
      expect(await extCommandExists(page, "checkbox.toggle"), "checkbox.toggle back").toBe(true);
      expect((await pressButton(page, grid, "A1")).filter((t) => t.includes(NOT_REG)), "after re-activation the button runs again").toEqual([]);

      // --- Charts + ownership --------------------------------------------------------
      const probe = () =>
        page.evaluate(() => {
          const w = window as unknown as LifeWindow & { __lifeOwn?: unknown; __lifeShadow?: unknown };
          const c = w.__CALCULA_EXTENSION_REGISTRY__!.getCommand("chart.filter.set");
          return c === undefined ? "undefined" : c === w.__lifeShadow ? "shadow" : c === w.__lifeOwn ? "own" : "other";
        });
      await page.evaluate(() => {
        const w = window as unknown as LifeWindow & { __lifeOwn?: unknown; __lifeShadow?: unknown };
        w.__lifeOwn = w.__CALCULA_EXTENSION_REGISTRY__!.getCommand("chart.filter.set");
        w.__lifeShadow = { id: "chart.filter.set", name: "life-shadow", execute() {} };
      });
      expect(await probe(), "precondition: Charts owns chart.filter.set").toBe("own");
      const ins0 = await renderedMenuItems(page, "Insert");
      expect(count(ins0, "Custom Chart Marks..."), "precondition").toBe(1);
      expect(count(ins0, "Custom Chart Transforms..."), "precondition").toBe(1);

      await page.evaluate(() => {
        const w = window as unknown as LifeWindow & { __lifeShadow?: unknown };
        w.__CALCULA_EXTENSION_REGISTRY__!.registerCommand(w.__lifeShadow);
      });
      expect(await probe(), "a registration over it is on top").toBe("shadow");
      await page.evaluate(() => {
        const w = window as unknown as LifeWindow & { __lifeShadow?: unknown };
        w.__CALCULA_EXTENSION_REGISTRY__!.unregisterCommand(w.__lifeShadow);
      });
      expect(await probe(), "taking the shadow back re-exposes Charts' own").toBe("own");

      await page.evaluate(() => {
        const w = window as unknown as LifeWindow & { __lifeShadow?: unknown };
        w.__CALCULA_EXTENSION_REGISTRY__!.registerCommand(w.__lifeShadow);
      });
      await takeDown(page, "calcula.charts");
      expect(await probe(), "Charts' teardown removed ANOTHER extension's registration").toBe("shadow");
      const ins1 = await renderedMenuItems(page, "Insert");
      expect(count(ins1, "Custom Chart Marks..."), `Insert > Custom Chart Marks... left behind (${fmt(ins1)})`).toBe(0);
      expect(count(ins1, "Custom Chart Transforms..."), "Insert > Custom Chart Transforms... left behind").toBe(0);
      await page.evaluate(() => {
        const w = window as unknown as LifeWindow & { __lifeShadow?: unknown };
        w.__CALCULA_EXTENSION_REGISTRY__!.unregisterCommand(w.__lifeShadow);
      });
      expect(await probe(), "with Charts off and the shadow gone, the command is gone").toBe("undefined");

      await bringUp(page, "calcula.charts");
      expect(await probe(), "Charts' re-activation registers its own command again").toBe("other");
      expect(await extCommandExists(page, "chart.filter.set"), "chart.filter.set back").toBe(true);
      const ins2 = await renderedMenuItems(page, "Insert");
      expect(count(ins2, "Custom Chart Marks..."), `back once (${fmt(ins2)})`).toBe(1);
      expect(count(ins2, "Custom Chart Transforms..."), "back once").toBe(1);
    } finally {
      await page.evaluate(() => {
        const w = window as unknown as LifeWindow & { __lifeShadow?: unknown };
        try {
          if (w.__lifeShadow) w.__CALCULA_EXTENSION_REGISTRY__!.unregisterCommand(w.__lifeShadow);
        } catch {
          /* already gone */
        }
      });
      await reactivateAll(page, IDS);
      await appNewFile(page);
    }
  });

  test("W21 Scriptable Objects, Sparklines, Defined Names, BI and Test Runner take back their items and commands", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(180_000);
    const IDS = ["calcula.scriptable-objects", "calcula.sparklines", "calcula.defined-names", "calcula.business-intelligence", "calcula.dev.test-runner"];
    try {
      await appNewFile(page);

      // --- Scriptable Objects + a button bound to cellBehaviors.toggleHighlight ---
      {
        const before = await snapshot(page);
        const DEV = ["Object Scripts...", "Script Templates...", "Script Libraries..."];
        await buttonBoundTo(page, 0, 0, "cellBehaviors.toggleHighlight");
        const NOT_REG = 'Button command "cellBehaviors.toggleHighlight" is not registered';
        expect((await pressButton(page, grid, "A1")).filter((t) => t.includes(NOT_REG)), "while active the button runs").toEqual([]);
        await takeDown(page, "calcula.scriptable-objects");
        const dev = await renderedMenuItems(page, "Developer");
        for (const l of DEV) expect(count(dev, l), `Developer > ${l} left behind (${fmt(dev)})`).toBe(0);
        expect(count(await renderedMenuItems(page, "Insert"), "Form..."), "Insert > Form... left behind").toBe(0);
        expect(await extCommandExists(page, "cellBehaviors.toggleHighlight"), "cellBehaviors.toggleHighlight left behind").toBe(false);
        expect((await pressButton(page, grid, "A1")).filter((t) => t.includes(NOT_REG)), "the bound button now does nothing but say so").toEqual([NOT_REG]);
        await bringUp(page, "calcula.scriptable-objects");
        await expectRestored(page, before, "calcula.scriptable-objects");
        const dev2 = await renderedMenuItems(page, "Developer");
        for (const l of DEV) expect(count(dev2, l), `Developer > ${l} back once (${fmt(dev2)})`).toBe(1);
        expect(count(await renderedMenuItems(page, "Insert"), "Form..."), "Insert > Form... back once").toBe(1);
        expect((await pressButton(page, grid, "A1")).filter((t) => t.includes(NOT_REG)), "the button runs again").toEqual([]);
        // Put the highlight toggle back where it was (it ran twice: on, off).
      }

      // --- Sparklines, Defined Names, BI, Test Runner ---------------------------------
      const cases: Array<{ id: string; bar: string; gone: string[]; cmds?: string[]; coreCmdPrefix?: string }> = [
        { id: "calcula.sparklines", bar: "Insert", gone: ["Sparklines"], cmds: ["sparklines.create"] },
        { id: "calcula.defined-names", bar: "Formulas", gone: ["Name Manager", "Paste Names...", "Apply Names..."] },
        { id: "calcula.business-intelligence", bar: "Model", gone: ["Connections", "New Model Connection...", "PivotTable from Model..."] },
        { id: "calcula.dev.test-runner", bar: "Developer", gone: ["Run All Tests", "Show Test Runner Panel"], coreCmdPrefix: "test." },
      ];
      for (const c of cases) {
        const before = await snapshot(page);
        const shown0 = await renderedMenuItems(page, c.bar);
        for (const l of c.gone) expect(count(shown0, l), `[${c.id}] precondition ${c.bar} > ${l}`).toBe(1);
        if (c.coreCmdPrefix) {
          expect(before.coreCommands.filter((k) => k.startsWith(c.coreCmdPrefix!)).length, `[${c.id}] precondition: ${c.coreCmdPrefix}* commands`).toBeGreaterThan(0);
        }
        await takeDown(page, c.id);
        const shown = await renderedMenuItems(page, c.bar);
        for (const l of c.gone) expect(count(shown, l), `[${c.id}] ${c.bar} > ${l} left behind (${fmt(shown)})`).toBe(0);
        for (const k of c.cmds ?? []) expect(await extCommandExists(page, k), `[${c.id}] ${k} left behind`).toBe(false);
        if (c.coreCmdPrefix) {
          const left = (await snapshot(page)).coreCommands.filter((k) => k.startsWith(c.coreCmdPrefix!));
          expect(left, `[${c.id}] the command palette still offers ${c.coreCmdPrefix}*`).toEqual([]);
        }
        await bringUp(page, c.id);
        await expectRestored(page, before, c.id);
        const back = await renderedMenuItems(page, c.bar);
        for (const l of c.gone) expect(count(back, l), `[${c.id}] ${c.bar} > ${l} back once (${fmt(back)})`).toBe(1);
      }
    } finally {
      await reactivateAll(page, IDS);
      await appNewFile(page);
    }
  });
});

// ===========================================================================
// W22 -- contextual tabs stand aside while a selection owner claims
// ===========================================================================

test.describe("contextual tabs and the selection owner (W22)", () => {
  test("W22 Table Design tab hides for a floating-grid cell and returns on a table cell, including the very cell that was hidden", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(120_000);
    let frId: string | null = null;
    const tab = async () => (await ribbonTabs(page)).includes("Table Design");
    try {
      await appNewFile(page);
      await seedTable(page);
      await grid.clickCell("A1");
      await page.keyboard.press("Control+t");
      await expect(page.locator("h2", { hasText: /^Create Table$/ }), "Ctrl+T opened no Create Table").toHaveCount(1, { timeout: 8000 });
      await page.locator("button").filter({ hasText: /^OK$/ }).last().click();
      await eventually(() => invoke<unknown[]>(page, "get_tables_all_sheets"), (t) => t.length === 1, "no table was created");

      await grid.clickCell("B2");
      await eventually(tab, (v) => v, "precondition: the Table Design tab shows for a table cell");

      frId = await holdFloatingCell(page);
      await eventually(tab, (v) => !v, "the Table Design tab stayed while a floating-grid cell holds the selection");

      await grid.clickCell("B3");
      expect(await selectionOwned(page), "clicking a sheet cell ends the claim").toBe(false);
      await eventually(tab, (v) => v, "the tab did not return on a table cell");

      await reclaimFloatingCell(page);
      await eventually(tab, (v) => !v, "the tab stayed on the second claim");
      await grid.clickCell("E10");
      await page.waitForTimeout(400);
      expect(await tab(), "control: a cell OUTSIDE the table shows no Table Design tab").toBe(false);

      // The very cell Core already had: its selection does not move.
      await grid.clickCell("B2");
      await eventually(tab, (v) => v, "precondition: tab on B2");
      await reclaimFloatingCell(page);
      await eventually(tab, (v) => !v, "tab hid");
      expect(await gridSelection(page), "Core's hidden active cell is still B2").toMatchObject({ endRow: 1, endCol: 1 });
      await grid.clickCell("B2");
      expect(await selectionOwned(page), "the click on B2 ended the claim").toBe(false);
      await eventually(tab, (v) => v, "the tab did not return on the very table cell that was hidden");
    } finally {
      if (frId) await deleteFr(page, frId).catch(() => {});
      await closeDialogs(page);
      await appNewFile(page);
    }
  });

  test("W22 + review finding 3: the Sparkline tab hides for a floating-grid cell and returns when the grid is deleted, with E2 still active", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(120_000);
    let frId: string | null = null;
    const tab = async () => (await ribbonTabs(page)).includes("Sparkline");
    const groups = () =>
      page.evaluate(() => ((window as unknown as { __CALCULA_SPARKLINES__?: { getAllGroups: () => unknown[] } }).__CALCULA_SPARKLINES__?.getAllGroups() ?? []).length);
    try {
      await appNewFile(page);
      await writeCells(page, [[1, 0, "10"], [1, 1, "20"], [1, 2, "15"], [1, 3, "30"]]);
      await grid.clickCell("E2");
      expect(await tab(), "precondition: no Sparkline tab before a sparkline exists").toBe(false);

      // Insert > Sparklines > Line, through the dialog.
      await clickMenuPath(page, ["Insert", "Sparklines", "Line"]);
      const dataRange = page.locator('input[placeholder="e.g. A1:A10 or A1:E5"]');
      await expect(dataRange, "the Create Sparklines dialog did not open").toHaveCount(1, { timeout: 5000 });
      expect(await page.locator('input[placeholder="e.g. F1 or F1:F5"]').inputValue(), "Location prefilled from E2").toBe("E2");
      // Focusing Data Range collapses the dialog into its range-picking bar
      // (the RefEdit gesture): type there, Enter expands it back, then OK.
      await dataRange.click();
      const collapsed = page.locator("span", { hasText: /^Data Range:$/ }).locator("xpath=following-sibling::input[1]");
      await expect(collapsed, "focusing Data Range did not open the range-picking bar").toHaveCount(1, { timeout: 5000 });
      await collapsed.fill("A2:D2");
      await collapsed.press("Enter");
      await expect(dataRange, "Enter did not expand the dialog again").toHaveCount(1, { timeout: 5000 });
      expect(await dataRange.inputValue(), "the typed data range").toBe("A2:D2");
      // The dialog's own OK (a toast carries an OK button too).
      await page
        .locator("span", { hasText: /^Create Sparklines \(Line\)$/ })
        .locator('xpath=ancestor::*[.//button[normalize-space()="OK"]][1]')
        .locator("button")
        .filter({ hasText: /^OK$/ })
        .click();
      await eventually(groups, (n) => n === 1, "the dialog created no sparkline group");
      await eventually(tab, (v) => v, "the Sparkline tab did not show after the create");

      frId = await holdFloatingCell(page);
      await eventually(tab, (v) => !v, "the Sparkline tab stayed while a floating-grid cell holds the selection");

      // Delete the floating grid WITHOUT touching the sheet.
      await deleteFr(page, frId);
      frId = null;
      await eventually(() => selectionOwned(page), (v) => v === false, "deleting the floating grid did not end its claim");
      await eventually(tab, (v) => v, "the Sparkline tab did not come back after the floating grid was deleted");
      expect(await gridSelection(page), "E2 is still Core's active cell").toMatchObject({ endRow: 1, endCol: 4 });

      // Check 5 again from a sparkline cell: claim, then the very cell.
      frId = await holdFloatingCell(page);
      await eventually(tab, (v) => !v, "tab hid on the second claim");
      await grid.clickCell("E2");
      await eventually(tab, (v) => v, "the tab did not return on the very sparkline cell that was hidden");
      await grid.clickCell("G6");
      await page.waitForTimeout(400);
      expect(await tab(), "control: a cell without a sparkline shows no Sparkline tab").toBe(false);
    } finally {
      if (frId) await deleteFr(page, frId).catch(() => {});
      await closeDialogs(page);
      await appNewFile(page);
    }
  });
});

// ===========================================================================
// W23 -- a model pivot's destination on a canvas
// ===========================================================================

test.describe("model pivot destination (W23)", () => {
  test("W23 PivotTable from Model reads 'Cell C3' on a worksheet and 'a new pivot box on this canvas' on a canvas", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(120_000);
    let connectionId: string | null = null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calcula-life-model-"));
    const destination = () =>
      page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("div")).find((d) => /^Destination: /.test((d.textContent ?? "").trim()) && d.children.length === 0);
        return el ? (el.textContent ?? "").trim() : null;
      });
    try {
      await appNewFile(page);
      // A model connection (the sales-star fixture; a listed connection is all the dialog needs).
      const bundle = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../../tests/fixtures/model/sales_star.json"), "utf8")) as {
        model: Record<string, unknown>;
      };
      const info = await invoke<{ id: string }>(page, "bi_create_connection", {
        request: { name: "LifeModel", description: null, connectionString: "", modelJson: { formatVersion: 1, model: bundle.model } },
      });
      connectionId = info.id;

      await grid.clickCell("C3");
      await clickMenuPath(page, ["Model", "PivotTable from Model..."]);
      const onSheet = await eventually(destination, (v) => v !== null, "the dialog showed no destination line", 8000);
      expect(onSheet, "on a worksheet the destination is the active cell").toBe("Destination: Cell C3");
      await closeDialogs(page);
      await eventually(destination, (v) => v === null, "the dialog did not close");

      // A canvas, active.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("sheet:requestAdd", { detail: { kind: "canvas" } })));
      await eventually(
        () => invoke<{ sheets: Array<{ kind?: string }>; activeIndex: number }>(page, "get_sheets"),
        (r) => r.sheets[r.activeIndex]?.kind === "canvas",
        "no canvas became active",
      );
      await page.waitForTimeout(500);
      await clickMenuPath(page, ["Model", "PivotTable from Model..."]);
      const onCanvas = await eventually(destination, (v) => v !== null, "the dialog showed no destination line on the canvas", 8000);
      expect(onCanvas, "on a canvas the destination is a new pivot box, never a cell").toBe("Destination: a new pivot box on this canvas");
    } finally {
      await closeDialogs(page);
      if (connectionId) await invoke(page, "bi_delete_connection", { connectionId }).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
      await appNewFile(page);
    }
  });
});

// ===========================================================================
// W24 / X3 -- doors while a floating grid's cell holds the selection
// ===========================================================================

test.describe("doors with a floating-grid cell selected on a worksheet (W24, X3)", () => {
  test("W24 + X3 Insert > Chart... and Insert > PivotTable... open with EMPTY sources and no toast; with a sheet cell they prefill", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(120_000);
    let frId: string | null = null;
    const chartRange = page.locator('input[placeholder="e.g., Sheet1!A1:D10"]');
    const pivotSource = page.locator('[data-testid="pivot-worksheet-source-range"]');
    const REGION = /A\$?1:\$?C\$?5/;
    try {
      await appNewFile(page);
      await seedTable(page);
      await grid.clickCell("B2");
      frId = await holdFloatingCell(page);

      await dismissToasts(page);
      await clickMenuPath(page, ["Insert", "Chart..."]);
      await expect(chartRange, "Insert > Chart... opened no dialog").toHaveCount(1, { timeout: 5000 });
      await page.waitForTimeout(900);
      expect(await chartRange.inputValue(), "the chart's data range was prefilled from the hidden cell").toBe("");
      expect(await toastTexts(page), "Insert > Chart... raised a toast").toEqual([]);
      await closeDialogs(page);
      await expect(chartRange).toHaveCount(0);

      await reclaimFloatingCell(page);
      await dismissToasts(page);
      await clickMenuPath(page, ["Insert", "PivotTable..."]);
      await expect(pivotSource, "Insert > PivotTable... opened no dialog").toHaveCount(1, { timeout: 5000 });
      await page.waitForTimeout(900);
      expect(await pivotSource.inputValue(), "the pivot's source was prefilled from the hidden cell (X3)").toBe("");
      expect(await toastTexts(page), "Insert > PivotTable... raised a toast").toEqual([]);
      await closeDialogs(page);
      await expect(pivotSource).toHaveCount(0);

      // Positive control: a sheet cell, the same doors prefill.
      await grid.clickCell("B2");
      expect(await selectionOwned(page)).toBe(false);
      await clickMenuPath(page, ["Insert", "Chart..."]);
      await expect(chartRange).toHaveCount(1, { timeout: 5000 });
      await eventually(() => chartRange.inputValue(), (v) => REGION.test(v), "control: Insert > Chart... did not prefill the data region");
      await closeDialogs(page);
      await clickMenuPath(page, ["Insert", "PivotTable..."]);
      await expect(pivotSource).toHaveCount(1, { timeout: 5000 });
      await eventually(() => pivotSource.inputValue(), (v) => REGION.test(v), "control: Insert > PivotTable... did not prefill the data region");
    } finally {
      await closeDialogs(page);
      if (frId) await deleteFr(page, frId).catch(() => {});
      await appNewFile(page);
    }
  });

  test("W24 View > Split Window refuses once with a floating-grid cell; with a sheet cell it splits; Remove Split works while the grid holds the selection", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(120_000);
    let frId: string | null = null;
    const split = () => invoke<{ splitRow: number | null; splitCol: number | null }>(page, "get_split_window");
    const isSplit = (c: { splitRow: number | null; splitCol: number | null }) => (c.splitRow ?? 0) > 0 || (c.splitCol ?? 0) > 0;
    try {
      await appNewFile(page);
      expect(isSplit(await split()), "precondition: no split").toBe(false);
      frId = await holdFloatingCell(page);
      const frs = await invoke<Array<{ id: string; rowCount: number; colCount: number }>>(page, "list_floating_ranges");
      const fr = frs.find((f) => f.id === frId)!;

      await dismissToasts(page);
      await clickMenuPath(page, ["View", "Split Window"]);
      await page.waitForTimeout(600);
      const refused = (await toastTexts(page)).filter((t) => /Split Window/.test(t));
      expect(refused, "one refusal toast for Split Window").toHaveLength(1);
      expect(isSplit(await split()), "Split Window split at the hidden cell").toBe(false);

      // Control: a sheet cell BEYOND the floating grid (so the grid stays in the top-left pane).
      const col = Math.ceil((FR_X + 28 + fr.colCount * 64.29) / 64.29) + 1;
      const row = Math.ceil((FR_Y + 36 + fr.rowCount * 20) / 20) + 1;
      const ref = `${String.fromCharCode(65 + col)}${row + 1}`;
      await grid.clickCell(ref);
      await dismissToasts(page);
      await clickMenuPath(page, ["View", "Split Window"]);
      const s = await eventually(split, isSplit, `control: View > Split Window at ${ref} made no split`);
      expect(s, "the split is at the clicked cell").toMatchObject({ splitRow: row, splitCol: col });

      await grid.navigateTo("A1");
      await reclaimFloatingCell(page);
      await dismissToasts(page);
      await clickMenuPath(page, ["View", "Remove Split"]);
      await eventually(split, (c) => !isSplit(c), "Remove Split did not remove the split while the floating grid holds the selection");
      expect((await toastTexts(page)).filter((t) => /was not applied/.test(t)), "Remove Split was refused").toEqual([]);
    } finally {
      await callModule(page, "/src/api/grid.ts", "removeSplitWindow").catch(() => {});
      if (frId) await deleteFr(page, frId).catch(() => {});
      await appNewFile(page);
    }
  });

  test("W24 Trace Precedents / Dependents refuse once each and draw nothing with a floating-grid cell; Remove Arrows still works", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(120_000);
    let frId: string | null = null;
    const arrows = () => callModule<number>(page, TRACING_STORE, "getArrowCount");
    try {
      await appNewFile(page);
      await writeCells(page, [[0, 0, "1"], [0, 1, "2"], [0, 2, "3"], [0, 3, "=SUM(A1:C1)"], [0, 4, "=D1*2"]]);
      await grid.clickCell("D1");
      frId = await holdFloatingCell(page);
      expect(await arrows(), "precondition: no arrows").toBe(0);

      for (const action of ["Trace Precedents", "Trace Dependents"]) {
        await dismissToasts(page);
        await clickMenuPath(page, ["Formulas", action]);
        await page.waitForTimeout(700);
        expect((await toastTexts(page)).filter((t) => t.includes(action)), `one refusal toast for ${action}`).toHaveLength(1);
        expect(await arrows(), `${action} drew arrows from the hidden cell`).toBe(0);
      }

      // Control: on the sheet cell D1 itself, Trace Precedents draws.
      await grid.clickCell("D1");
      await clickMenuPath(page, ["Formulas", "Trace Precedents"]);
      await eventually(arrows, (n) => n > 0, "control: Trace Precedents on D1 drew nothing");

      // Remove Arrows is not the selection's: it works while the grid holds it.
      await reclaimFloatingCell(page);
      await dismissToasts(page);
      await clickMenuPath(page, ["Formulas", "Remove Arrows"]);
      await eventually(arrows, (n) => n === 0, "Remove Arrows left arrows while the floating grid holds the selection");
      expect((await toastTexts(page)).filter((t) => /was not applied/.test(t)), "Remove Arrows was refused").toEqual([]);
    } finally {
      await callModule(page, TRACING_STORE, "removeAllArrows").catch(() => {});
      if (frId) await deleteFr(page, frId).catch(() => {});
      await appNewFile(page);
    }
  });

  test("W24 Scenario Manager > Add... and Name Manager > New... start EMPTY with a floating-grid cell; with a sheet cell they prefill", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(120_000);
    let frId: string | null = null;
    const changing = page.locator('input[placeholder="$B$2,$B$3 or $B$2:$B$5"]');
    const refersTo = page.locator("label", { hasText: /^Refers to:$/ }).locator("xpath=following-sibling::input[1]");
    const openAdd = async () => {
      await clickMenuPath(page, ["Data", "What-If Analysis", "Scenario Manager..."]);
      const add = page.locator("button").filter({ hasText: /^Add\.\.\.$/ });
      await expect(add, "Scenario Manager did not open").toHaveCount(1, { timeout: 5000 });
      await add.click();
      await expect(changing, "Add... showed no Changing cells field").toHaveCount(1, { timeout: 5000 });
      await page.waitForTimeout(300);
    };
    const openNew = async () => {
      await clickMenuPath(page, ["Formulas", "Name Manager"]);
      const nu = page.locator("button").filter({ hasText: /^New\.\.\.$/ });
      await expect(nu, "Name Manager did not open").toHaveCount(1, { timeout: 5000 });
      await nu.click();
      await expect(refersTo, "New... showed no Refers to field").toHaveCount(1, { timeout: 5000 });
      await page.waitForTimeout(300);
    };
    try {
      await appNewFile(page);
      await seedTable(page);
      await grid.clickCell("B2");
      frId = await holdFloatingCell(page);

      await dismissToasts(page);
      await openAdd();
      expect(await changing.inputValue(), "Scenario Manager > Add... named the hidden cell").toBe("");
      await closeDialogs(page);
      await reclaimFloatingCell(page);
      await openNew();
      expect(await refersTo.inputValue(), "Name Manager > New... pointed at the hidden cell").toBe("");
      await closeDialogs(page);
      expect((await toastTexts(page)).filter((t) => /was not applied/.test(t)), "a door refused instead of opening").toEqual([]);

      // Positive control: a sheet cell, both prefill.
      await grid.clickCell("B2");
      expect(await selectionOwned(page)).toBe(false);
      await openAdd();
      expect(await changing.inputValue(), "control: Add... prefills Core's cell").toMatch(/\$?B\$?2/);
      await closeDialogs(page);
      await grid.clickCell("B2");
      await openNew();
      expect(await refersTo.inputValue(), "control: New... prefills Core's cell").toMatch(/Sheet1!\$?B\$?2/);
    } finally {
      await closeDialogs(page);
      if (frId) await deleteFr(page, frId).catch(() => {});
      await appNewFile(page);
    }
  });
});

// ===========================================================================
// BUG-0205 -- the harness's own File > New
// ===========================================================================

test.describe("the harness resets through the app (BUG-0205)", () => {
  test("BUG-0205 resetToNewWorkbook goes through the app's newFile: the chart store and the tab strip follow the new document", async ({
    appPage: page,
  }) => {
    test.setTimeout(90_000);
    const chartsInStore = () => callModule<unknown[]>(page, CHART_STORE, "getAllCharts").then((c) => c.length);
    const makeChart = async () => {
      await callModule(page, CHART_STORE, "createChart", [
        {
          mark: "bar",
          data: { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
          hasHeaders: true,
          seriesOrientation: "columns",
          categoryIndex: 0,
          series: [{ sourceIndex: 1, name: "Units", color: "#4472C4" }],
          title: "Life0205",
        },
        { sheetIndex: 0, x: 400, y: 60, width: 240, height: 160, name: "Life0205" },
      ]);
      await callModule(page, CHART_STORE, "flushPendingChartSaves");
      await eventually(() => invoke<unknown[]>(page, "get_charts"), (c) => c.length === 1, "the chart never reached the backend");
    };
    try {
      await appNewFile(page);
      await seedTable(page);
      await makeChart();
      expect(await chartsInStore(), "precondition: one chart in the frontend store").toBe(1);

      // The defect's mechanism, as a control: a RAW new_file leaves the store stale.
      await invoke(page, "new_file", {});
      await page.waitForTimeout(500);
      expect(await invoke<unknown[]>(page, "get_charts"), "raw new_file cleared the backend").toEqual([]);
      expect(await chartsInStore(), "control: after a RAW new_file the chart store still holds the old chart").toBe(1);

      // The fixed helper: the store follows the new document.
      await resetToNewWorkbook(page);
      await eventually(chartsInStore, (n) => n === 0, "resetToNewWorkbook left a chart in the frontend store");

      // Again from a live document with two sheets and a chart.
      await appNewFile(page);
      await seedTable(page);
      await makeChart();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("sheet:requestAdd", { detail: null })));
      await eventually(() => page.locator("button[data-sheet-tab]").count(), (n) => n === 2, "no second tab");
      await resetToNewWorkbook(page);
      await eventually(chartsInStore, (n) => n === 0, "resetToNewWorkbook left the chart");
      await eventually(() => page.locator("button[data-sheet-tab]").count(), (n) => n === 1, "resetToNewWorkbook left a phantom tab");
      expect(await invoke<unknown[]>(page, "get_charts"), "backend").toEqual([]);
      expect(await invoke<boolean>(page, "is_file_modified"), "a clean document").toBe(false);
    } finally {
      await appNewFile(page);
    }
  });
});

// ===========================================================================
// The whole population
// ===========================================================================

test.describe("live census (Y14, Y15, X19, X20, W20, W21)", () => {
  test("LIVE-CENSUS every built-in round-trips through the dev hook with menus, right-click menus, commands and ribbon tabs restored exactly", async ({
    appPage: page,
  }) => {
    test.setTimeout(600_000);
    const problems: string[] = [];
    let tookSomething = 0;
    const list = await builtIns(page);
    try {
      await appNewFile(page);
      for (const { id, status } of list) {
        if (status !== "active") {
          problems.push(`${id}: status ${status} at rest`);
          continue;
        }
        const before = await snapshot(page);
        const beforeKeys = allKeys(before);
        const dErr = await lifecycle(page, "deactivate", id);
        if (dErr) problems.push(`${id}: deactivate refused: ${dErr}`);
        if ((await statusOf(page, id)) !== "inactive") problems.push(`${id}: not inactive after deactivate`);
        await page.waitForTimeout(200);
        const during = allKeys(await snapshot(page));
        const added = multisetMinus(during, beforeKeys);
        if (added.length) problems.push(`${id}: registered while going down: ${fmt(added)}`);
        // The positive side: what the deactivate really took away.
        if (multisetMinus(beforeKeys, during).length > 0) tookSomething++;
        const aErr = await lifecycle(page, "activate", id);
        if (aErr) problems.push(`${id}: activate failed: ${aErr}`);
        let after: string[] = [];
        try {
          await eventually(
            async () => (after = allKeys(await snapshot(page))),
            (k) => multisetMinus(beforeKeys, k).length === 0 && multisetMinus(k, beforeKeys).length === 0,
            id,
            4000,
          );
        } catch {
          /* reported below */
        }
        const missing = multisetMinus(beforeKeys, after);
        const extra = multisetMinus(after, beforeKeys);
        if (missing.length) problems.push(`${id}: missing after re-activation: ${fmt(missing)}`);
        if (extra.length) problems.push(`${id}: extra after re-activation: ${fmt(extra)}`);
        if ((await statusOf(page, id)) !== "active") problems.push(`${id}: not active after the round trip`);
        if ((await page.locator("[data-focus-container='spreadsheet']").count()) === 0) {
          problems.push(`${id}: the spreadsheet unmounted`);
          break;
        }
      }
    } finally {
      await reactivateAll(page, list.map((e) => e.id));
      await appNewFile(page);
    }
    expect(list.length, "the census saw the built-ins").toBeGreaterThan(60);
    // A deactivate that did nothing would round-trip "cleanly" too: most
    // built-ins register a menu item, a right-click item, a command or a tab,
    // and each of those must have been seen leaving.
    expect(tookSomething, "deactivations that visibly took a registration away").toBeGreaterThan(60);
    expect(problems, `${list.length} built-ins round-tripped`).toEqual([]);
  });
});
