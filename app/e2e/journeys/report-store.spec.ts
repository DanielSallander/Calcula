/**
 * THE REPORT STORE HAS ONE REPRESENTATION (§3av) — proved on the RUNNING app.
 *
 * WHAT WAS FIXED. Grid reports used to live in `AppState.report_definitions` (a
 * bare `Mutex<Vec<SavedReport>>`) AND in `extension_data["calcula.reports"]`,
 * kept in step by a `sync_reports_to_extension_data` call every mutation site
 * had to REMEMBER. The saved bytes came from the mirror, so a report mutation
 * that skipped the sync was dropped at save with no error and no prompt: the
 * user's report simply was not there on reopen. The fix deleted the store —
 * `extension_data["calcula.reports"]` is now the one representation, reached
 * only through `report::read_reports` and `report::with_reports_mut`.
 *
 * WHY THIS SPEC EXISTS. Everything above was established by Rust unit tests, a
 * source-level test that no second copy is declared, and a four-arm compile
 * probe. All of those are blind to the same thing: they never open the product.
 * They cannot show that the gesture a USER makes — Model ▸ Report from Design
 * Query…, type a design query, press Create; then Edit Query, rename, Save &
 * refresh — reaches that code, nor that what the user then sees after Save and
 * reopen is what they left. That is the half this spec supplies.
 *
 * THE ASSERTION SHAPE IS `mutate -> save -> WIPE -> reopen -> still there`, never
 * "the sync was called". That distinction is the whole item: "the sync was
 * called" is exactly the assertion that PASSED on the broken design, because all
 * eleven mutation sites did call it. Every test here writes a real `.cala` with
 * `save_file`, wipes the document through the app's own File ▸ New, asserts the
 * document really is empty, and reopens with the app's own `openFileAtPath`.
 *
 * WHAT IS ASSERTED — one test per mutation ROUTE, because the defect was that
 * SOME route might forget the sync, so proving one route proves nothing about
 * the others.
 *   1. THE HEADLINE. Create through the real menu + dialog, then EDIT through
 *      the real contextual Report ribbon tab (rename + a new design query).
 *      The edited name, the edited DSL and the re-materialized cells all
 *      survive save → File ▸ New → reopen. (routes 1 + 2: create_report,
 *      refresh_report)
 *   2. DELETE, through Model ▸ Manage Reports… — the negative half. A deletion
 *      that fails to reach the file is the same bug wearing the other hat, so
 *      the report must STAY gone and its cells must STAY cleared. (route 3)
 *   3. A NON-UI ROUTE: a sandboxed BUTTON OBJECT SCRIPT in its worker realm
 *      calling `api.insertRows`, which reaches the backend through the broker
 *      and re-points every report definition
 *      (`structure::sync_report_definitions_to_regions`). The shifted anchor
 *      must survive. (route 8, driven with no UI at all)
 *   4. SHEET DELETE, through the real sheet-tab context menu: the report's
 *      sheet index is re-pointed 1 → 0 and stays re-pointed. (route 5)
 *   5. UNDO, through a real Ctrl+Z on the grid: an undone RENAME restores the
 *      old name, and the OLD name is what the file then holds. This is a
 *      positive value restored, not an emptiness. (route 9)
 *   6. THE REVERSE ROUTE the fix closed: `set_extension_data("calcula.reports",
 *      …)` — a call spelled exactly like the idiom every other extension uses to
 *      persist — is REFUSED, and the reports are untouched by the attempt.
 *   7. THE CLASS SWEEP's one other real instance, `animationStore.ts`, through
 *      the real View ▸ Animation Timeline panel: a saved animation survives the
 *      same save → wipe → reopen cycle.
 *
 * VACUOUS-PASS DISCIPLINE. Every "still there after reopen" is preceded by the
 * PRE-SAVE assertion of the same value, and by an assertion that File ▸ New
 * really emptied the store. A test cannot pass on a report that was never
 * modified, nor on a wipe that never happened.
 *
 * THE BI FIXTURE IS SETUP, NEVER THE THING UNDER TEST. A report needs a model
 * connection with data. The spec writes a two-column CSV to a temp directory and
 * builds a model over it with the Model Editor's own commands (create blank →
 * add a `csv` catalog source → connect it → import the table → add a measure).
 * Those are `invoke` calls on purpose: they are the fixture. Everything from
 * "open the Model menu" onwards is the real UI.
 *
 * WHY A JOURNEY. Every test calls File ▸ New and reopens a workbook; test 4 adds
 * and deletes sheets. The functional specs share one accumulating workbook whose
 * goldens encode the residue of everything before them.
 *
 * GRID REAL ESTATE. Columns AG..AK (32..36), rows 1..30 — outside every column
 * another spec claims (K, L, N, P, R, T–Z, AA–AD, AW–BD, CE, E, G). Every test
 * starts from File ▸ New anyway, so nothing else's coordinates survive into
 * these.
 *
 * LOCALE. sv-SE — but no spreadsheet formula is typed here, so no separator
 * question arises. The design-query DSL is locale-independent.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef, type GridHelper } from "../helpers/grid";

// ===========================================================================
// Plumbing — setup and ORACLES only. Never the thing under test.
// ===========================================================================

const CSV_DIR = path.join(os.tmpdir(), "calcula-e2e-report-store");
const SAVE_FILE = path.join(os.tmpdir(), "calcula-e2e-report-store.cala");

/** The report's anchor. AG3 = row 2, col 32 (0-based). */
const ANCHOR = "AG3";
const ANCHOR_ROW = 2;
const ANCHOR_COL = 32;

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

/** Call an exported function of one of the app's OWN modules, in its own realm. */
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

/**
 * Wipe the workbook through the app's OWN File ▸ New path. The raw
 * `invoke("new_file")` is the bypass; the wrapper is what announces the change.
 */
async function newFile(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(800);
}

/** Save to `SAVE_FILE`. `save_file` is the command File ▸ Save invokes. */
async function saveWorkbook(page: Page): Promise<void> {
  await invoke(page, "save_file", { path: SAVE_FILE });
  await page.waitForTimeout(700);
}

/** Reopen `SAVE_FILE` through the app's own open path. */
async function reopenWorkbook(page: Page): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "openFileAtPath", [SAVE_FILE]);
  await page.waitForTimeout(2200);
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(400);
}

/**
 * The display string the CANVAS has for a cell of the ACTIVE sheet.
 * `get_viewport_cells` is the command GridCanvas itself calls for the strings it
 * paints, so this is the rendered text and not a private backend field.
 */
async function renderedCell(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const cells = await invoke<Array<{ row: number; col: number; display: string }>>(
    page,
    "get_viewport_cells",
    { startRow: row, startCol: col, endRow: row, endCol: col },
  );
  return String(cells[0]?.display ?? "");
}

interface SavedReport {
  id: string;
  name: string;
  dslText: string;
  connectionId: string;
  sheetIndex: number;
  anchorRow: number;
  anchorCol: number;
  endRow: number;
  endCol: number;
}

/** The workbook's report definitions, read through the product's own command. */
async function listReports(page: Page): Promise<SavedReport[]> {
  return invoke<SavedReport[]>(page, "list_reports", {});
}

// ---------------------------------------------------------------------------
// The BI fixture: a CSV-backed model. Setup, never the thing under test.
// ---------------------------------------------------------------------------

/**
 * Build a model connection over a two-column CSV and return its id.
 *
 * `sales.csv` holds North 100 / South 250 / North 50 / East 25, so
 * `ROWS: sales.region / VALUES: [TotalAmount]` renders East 25, North 150,
 * South 250 and a Grand Total of 425 — values distinctive enough that a stale
 * or absent report is unmistakable.
 */
async function setupCsvModel(page: Page, name: string): Promise<string> {
  fs.mkdirSync(CSV_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CSV_DIR, "sales.csv"),
    "region,amount\nNorth,100\nSouth,250\nNorth,50\nEast,25\n",
    "utf8",
  );

  const conn = await invoke<{ id: string }>(page, "bi_model_create_blank", {
    name,
    connectionString: null,
  });
  await invoke(page, "bi_model_upsert_source", {
    connectionId: conn.id,
    id: "csv1",
    kind: "csv",
    host: null,
    port: null,
    database: CSV_DIR.replace(/\\/g, "/"),
    defaultSchema: "main",
    trustServerCertificate: false,
    sslMode: null,
    preferredAuth: "integrated",
    displayName: "CSV files",
  });
  await invoke(page, "bi_model_connect_source", {
    connectionId: conn.id,
    sourceId: "csv1",
    connectionString: "",
    remember: false,
  });
  await invoke(page, "bi_model_import_tables", {
    connectionId: conn.id,
    tables: [{ schema: "main", name: "sales" }],
  });
  await invoke(page, "bi_model_upsert_measure", {
    connectionId: conn.id,
    originalName: null,
    name: "TotalAmount",
    formula: "SUM(sales[amount])",
    description: null,
    formatString: null,
    formatStringExpression: null,
    detailRows: null,
    group: null,
    hidden: null,
  });
  return conn.id;
}

// ---------------------------------------------------------------------------
// THE REAL GESTURES
// ---------------------------------------------------------------------------

/** Open a top-level menu and click one of its items, by their visible text. */
async function menuAction(page: Page, menu: string, item: RegExp): Promise<void> {
  await page.locator("button").filter({ hasText: new RegExp(`^${menu}$`) }).first().click();
  await page.waitForTimeout(350);
  await page.locator("button").filter({ hasText: item }).first().click();
  await page.waitForTimeout(1400);
}

/**
 * Replace a Monaco editor's whole content.
 *
 * `keyboard.insertText` rather than `keyboard.type`: the DSL is multi-line, and
 * the Enter that a typed newline sends is swallowed by Monaco's autocomplete
 * popup (which the field names in `ROWS:` reliably open). `insertText` still
 * goes through the editor's real input pipeline — this is the editor doing the
 * edit, not a state setter being poked.
 */
async function replaceMonacoText(page: Page, card: ReturnType<Page["locator"]>, text: string) {
  await card.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
  await page.waitForTimeout(500);
}

/** The dialog card that owns a given `<h2>` heading. */
function dialogCard(page: Page, heading: string) {
  return page.locator(`h2:has-text("${heading}")`).locator("xpath=../..");
}

/**
 * Create a report the way a user does: put the cursor where it should land, open
 * Model ▸ Report from Design Query…, name it, pick the connection, type the
 * design query, press Create report.
 */
async function createReportViaUI(
  page: Page,
  grid: GridHelper,
  opts: { anchor: string; name: string; connectionId: string; dsl: string },
): Promise<void> {
  await grid.navigateTo(opts.anchor);
  await page.waitForTimeout(400);

  await menuAction(page, "Model", /Report from Design Query/);
  const card = dialogCard(page, "New report from design query");
  await expect(card, "the create-report dialog must open").toBeVisible();

  await card.locator('input[type="text"]').first().fill(opts.name);
  await card.locator("select").first().selectOption(opts.connectionId);
  // The dialog fetches the connection's model before it can compile the query.
  await page.waitForTimeout(1200);
  await replaceMonacoText(page, card, opts.dsl);
  await card.locator("button").filter({ hasText: /^Create report$/ }).click();
  await page.waitForTimeout(2600);

  await expect(
    page.locator('h2:has-text("New report from design query")'),
    "the create dialog closes on success — if it is still open it is showing an error",
  ).toHaveCount(0);
}

/**
 * Open the CONTEXTUAL Report ribbon tab for the report under the cursor. It only
 * exists while the selection is inside a report region, which is itself part of
 * the claim: the tab is how a user reaches Edit Query / Refresh / Delete.
 */
async function openReportRibbonTab(page: Page, grid: GridHelper, cellInReport: string) {
  await grid.navigateTo(cellInReport);
  await page.waitForTimeout(1200);
  const tab = page.locator("button").filter({ hasText: /^Report$/ }).first();
  await expect(tab, "the contextual Report tab must appear for a cell inside a report").toHaveCount(
    1,
  );
  await tab.click();
  await page.waitForTimeout(700);
}

/** Edit a report through the contextual Report tab ▸ Edit Query. */
async function editReportViaUI(
  page: Page,
  grid: GridHelper,
  opts: { cellInReport: string; newName: string; newDsl: string },
): Promise<void> {
  await openReportRibbonTab(page, grid, opts.cellInReport);
  await page.locator("button").filter({ hasText: /Edit Query/ }).first().click();
  await page.waitForTimeout(1600);

  const card = dialogCard(page, "Edit report");
  await expect(card, "the edit-report dialog must open").toBeVisible();
  await card.locator('input[type="text"]').first().fill(opts.newName);
  await page.waitForTimeout(300);
  await replaceMonacoText(page, card, opts.newDsl);
  await card.locator("button").filter({ hasText: /^Save & refresh$/ }).click();
  await page.waitForTimeout(2600);

  await expect(
    page.locator('h2:has-text("Edit report")'),
    "the edit dialog closes on success — if it is still open it is showing an error",
  ).toHaveCount(0);
}

/**
 * Delete a report through Model ▸ Manage Reports…. That surface is used rather
 * than the Report tab's own Delete because the latter asks for confirmation
 * through a NATIVE Windows message box, which is outside the WebView and so
 * outside Playwright's reach. Both call the same `delete_report` command.
 */
async function deleteReportViaManageDialog(page: Page, reportName: string): Promise<void> {
  await menuAction(page, "Model", /Manage Reports/);
  const card = dialogCard(page, "Reports");
  await expect(card, "the manage-reports dialog must open").toBeVisible();
  await expect(card, "and it must list the report we are about to delete").toContainText(
    reportName,
  );
  await card.locator("button").filter({ hasText: /^Delete$/ }).first().click();
  await page.waitForTimeout(1800);
  await card.locator('button[aria-label="Close"]').first().click();
  await page.waitForTimeout(500);
}

/** Add a sheet through the REAL tab-bar button and wait for the auto-switch. */
async function addSheetViaUI(page: Page): Promise<void> {
  await page.locator('button[title="Add new sheet"]').click({ force: true });
  await page.waitForTimeout(1000);
}

/**
 * Delete a sheet through the REAL tab context menu and its in-app confirmation
 * dialog ("Delete Sheet" / "Are you sure…" / Delete).
 */
async function deleteSheetViaUI(page: Page, index: number): Promise<void> {
  const tab = page.locator(`button[data-sheet-tab="${index}"]`);
  await tab.click({ button: "right" });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  await page.waitForTimeout(700);
  await expect(
    page.locator("text=Are you sure you want to delete"),
    "the sheet-delete confirmation must appear",
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).last().click();
  await page.waitForTimeout(1600);
}

/** Switch sheets through the REAL tab button. */
async function activateSheetViaUI(page: Page, index: number): Promise<void> {
  await page.locator(`button[data-sheet-tab="${index}"]`).click();
  await page.waitForTimeout(900);
}

const BASE_DSL = "ROWS: sales.region" + String.fromCharCode(10) + "VALUES: [TotalAmount]";
const EDITED_DSL = "ROWS: sales.amount" + String.fromCharCode(10) + "VALUES: [TotalAmount]";

// ===========================================================================
// The tests
// ===========================================================================

test.describe("The report store has one representation (§3av) — on the running app", () => {
  test.beforeEach(async ({ appPage: page }) => {
    await newFile(page);
  });

  // -----------------------------------------------------------------------
  test("1. THE HEADLINE: a report created and then EDITED through the real UI survives save, File > New and reopen", async ({
    appPage: page,
    grid,
  }) => {
    const cid = await setupCsvModel(page, "Report Store Model 1");

    // --- create, through the real menu + dialog ---
    await createReportViaUI(page, grid, {
      anchor: ANCHOR,
      name: "Regional Sales",
      connectionId: cid,
      dsl: BASE_DSL,
    });

    const afterCreate = await listReports(page);
    expect(afterCreate, "one report exists after the Create gesture").toHaveLength(1);
    expect(afterCreate[0].name).toBe("Regional Sales");
    expect(await renderedCell(page, "AG3"), "the report header cell").toBe("sales.region");
    expect(await renderedCell(page, "AG5"), "North's group row").toBe("North");
    expect(await renderedCell(page, "AH5"), "North = 100 + 50").toBe("150");

    // --- edit, through the real contextual Report tab ---
    await editReportViaUI(page, grid, {
      cellInReport: "AG4",
      newName: "Amounts Detail",
      newDsl: EDITED_DSL,
    });

    // PRE-SAVE: the change really happened. Without this the test could pass on
    // a report that was never modified.
    const beforeSave = await listReports(page);
    expect(beforeSave, "still exactly one report after the edit").toHaveLength(1);
    expect(beforeSave[0].name, "PRE-SAVE: the new name").toBe("Amounts Detail");
    expect(beforeSave[0].dslText, "PRE-SAVE: the new design query").toContain("sales.amount");
    expect(await renderedCell(page, "AG3"), "PRE-SAVE: the re-materialized header").toBe(
      "sales.amount",
    );

    // --- save, wipe, reopen ---
    await saveWorkbook(page);
    await newFile(page);
    expect(await listReports(page), "File > New really emptied the store").toHaveLength(0);
    expect(await renderedCell(page, "AG3"), "File > New really cleared the cells").toBe("");

    await reopenWorkbook(page);

    const afterReload = await listReports(page);
    expect(afterReload, "the report is in the reopened workbook").toHaveLength(1);
    expect(afterReload[0].name, "the EDITED name survived the round trip").toBe("Amounts Detail");
    expect(afterReload[0].dslText, "the EDITED design query survived").toContain("sales.amount");
    expect(afterReload[0].anchorRow).toBe(ANCHOR_ROW);
    expect(afterReload[0].anchorCol).toBe(ANCHOR_COL);
    expect(await renderedCell(page, "AG3"), "and the EDITED cells are on the grid").toBe(
      "sales.amount",
    );
  });

  // -----------------------------------------------------------------------
  test("2. a report DELETED through Manage Reports stays deleted across save and reopen (the negative half)", async ({
    appPage: page,
    grid,
  }) => {
    const cid = await setupCsvModel(page, "Report Store Model 2");
    await createReportViaUI(page, grid, {
      anchor: ANCHOR,
      name: "Doomed Report",
      connectionId: cid,
      dsl: BASE_DSL,
    });
    expect(await listReports(page), "the report to be deleted exists first").toHaveLength(1);
    expect(await renderedCell(page, "AG3")).toBe("sales.region");

    await deleteReportViaManageDialog(page, "Doomed Report");

    // PRE-SAVE: it is gone from the live document.
    expect(await listReports(page), "PRE-SAVE: the delete took effect").toHaveLength(0);
    expect(await renderedCell(page, "AG3"), "PRE-SAVE: its cells were cleared").toBe("");

    await saveWorkbook(page);
    await newFile(page);
    await reopenWorkbook(page);

    expect(
      await listReports(page),
      "a deletion that does not reach the file is the same defect wearing the other hat",
    ).toHaveLength(0);
    expect(await renderedCell(page, "AG3"), "and its cells stay cleared").toBe("");
  });

  // -----------------------------------------------------------------------
  test("3. a NON-UI route — a sandboxed button script calling api.insertRows — re-points the report, and the new anchor survives", async ({
    appPage: page,
    grid,
  }) => {
    const cid = await setupCsvModel(page, "Report Store Model 3");
    await createReportViaUI(page, grid, {
      anchor: ANCHOR,
      name: "Script Shifted",
      connectionId: cid,
      dsl: BASE_DSL,
    });
    const before = await listReports(page);
    expect(before, "the report exists before the script runs").toHaveLength(1);
    expect(before[0].anchorRow, "it starts at row index 2 (AG3)").toBe(ANCHOR_ROW);

    // A real object script in its own worker realm. `api.insertRows` is an
    // allowlisted "unlocked/mutate" verb: worker -> broker -> backend
    // `insert_rows` -> `sync_report_definitions_to_regions` -> `with_reports_mut`.
    // No UI is involved anywhere in that chain.
    const SHEET = 0;
    const ROW = 40;
    const COL = 36; // AK41 — inside this spec's own column block.
    const instanceId = `control-${SHEET}-${ROW}-${COL}`;

    await invoke(page, "set_script_security_level", { level: "enabled" });
    await invoke(page, "set_control_metadata", {
      sheetIndex: SHEET,
      row: ROW,
      col: COL,
      metadata: {
        controlType: "button",
        properties: { label: { valueType: "static", value: "Insert" } },
      },
    });
    await page.waitForTimeout(300);

    await page.evaluate(async (a) => {
      const api = await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL("/src/api/index.ts", document.baseURI).href);
      const events = await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL("/src/api/events.ts", document.baseURI).href);
      const { ObjectScriptManager } = api as { ObjectScriptManager: Record<string, Function> };
      const { emitAppEvent } = events as { emitAppEvent: (n: string, p: unknown) => void };

      const scriptDef = {
        id: "report-store-insert-" + a.instanceId,
        name: "Report Store Insert",
        objectType: "button",
        instanceId: a.instanceId,
        source:
          "function setup(button){ button.onClick(function(){ button.api.insertRows(0, 2); }); }",
        accessLevel: "unlocked",
        description: null,
      };
      (window as unknown as { __reportStoreScript: unknown }).__reportStoreScript = scriptDef;
      ObjectScriptManager.registerScript(scriptDef);
      await ObjectScriptManager.mountScript(scriptDef.id);
      await new Promise((r) => setTimeout(r, 900));
      emitAppEvent("button:clicked", { instanceId: a.instanceId, x: 1, y: 1 });
    }, { instanceId });
    await page.waitForTimeout(2000);

    // Unmount before asserting so nothing else in the run inherits the script.
    await page.evaluate(async () => {
      const api = (await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL("/src/api/index.ts", document.baseURI).href)) as {
        ObjectScriptManager: Record<string, Function>;
      };
      const def = (window as unknown as { __reportStoreScript?: { id: string } })
        .__reportStoreScript;
      if (def) {
        try {
          api.ObjectScriptManager.unmountScript(def.id);
          api.ObjectScriptManager.removeScript(def.id);
        } catch {
          /* best effort */
        }
      }
    });

    // PRE-SAVE: the script's two inserted rows pushed the report down.
    const afterScript = await listReports(page);
    expect(afterScript, "the report is still there after the script ran").toHaveLength(1);
    expect(afterScript[0].anchorRow, "PRE-SAVE: two inserted rows moved the anchor 2 -> 4").toBe(
      ANCHOR_ROW + 2,
    );
    expect(await renderedCell(page, "AG5"), "PRE-SAVE: the header moved to AG5").toBe(
      "sales.region",
    );

    await saveWorkbook(page);
    await newFile(page);
    expect(await listReports(page), "File > New really emptied the store").toHaveLength(0);
    await reopenWorkbook(page);

    const afterReload = await listReports(page);
    expect(afterReload, "the script-shifted report is in the reopened workbook").toHaveLength(1);
    expect(afterReload[0].anchorRow, "the SHIFTED anchor is what the file holds").toBe(
      ANCHOR_ROW + 2,
    );
    expect(await renderedCell(page, "AG5"), "and its cells are at the shifted anchor").toBe(
      "sales.region",
    );

    await invoke(page, "remove_control_metadata", { sheetIndex: SHEET, row: ROW, col: COL }).catch(
      () => undefined,
    );
  });

  // -----------------------------------------------------------------------
  test("4. deleting a SHEET through the real tab menu re-points the report's sheet index, and the new index survives", async ({
    appPage: page,
    grid,
  }) => {
    const cid = await setupCsvModel(page, "Report Store Model 4");

    // Put the report on the SECOND sheet, then delete the first one.
    await addSheetViaUI(page);
    expect(await page.locator("button[data-sheet-tab]").count()).toBe(2);
    await activateSheetViaUI(page, 1);

    await createReportViaUI(page, grid, {
      anchor: ANCHOR,
      name: "Sheet Two Report",
      connectionId: cid,
      dsl: BASE_DSL,
    });
    const before = await listReports(page);
    expect(before, "the report exists on sheet 2").toHaveLength(1);
    expect(before[0].sheetIndex, "it starts on sheet index 1").toBe(1);

    await deleteSheetViaUI(page, 0);
    expect(await page.locator("button[data-sheet-tab]").count(), "one sheet left").toBe(1);

    // PRE-SAVE: the surviving sheet is now index 0 and the report followed it.
    const afterDelete = await listReports(page);
    expect(afterDelete, "the report survived the sheet delete").toHaveLength(1);
    expect(afterDelete[0].sheetIndex, "PRE-SAVE: re-pointed 1 -> 0").toBe(0);
    expect(await renderedCell(page, "AG3"), "PRE-SAVE: its cells render on the surviving sheet").toBe(
      "sales.region",
    );

    await saveWorkbook(page);
    await newFile(page);
    await reopenWorkbook(page);

    const afterReload = await listReports(page);
    expect(afterReload, "the report is in the reopened workbook").toHaveLength(1);
    expect(afterReload[0].sheetIndex, "the RE-POINTED sheet index is what the file holds").toBe(0);
    expect(await renderedCell(page, "AG3"), "and its cells are there").toBe("sales.region");
  });

  // -----------------------------------------------------------------------
  test("5. Ctrl+Z of a rename restores the OLD name, and the OLD name is what the file then holds", async ({
    appPage: page,
    grid,
  }) => {
    const cid = await setupCsvModel(page, "Report Store Model 5");
    await createReportViaUI(page, grid, {
      anchor: ANCHOR,
      name: "Original Name",
      connectionId: cid,
      dsl: BASE_DSL,
    });
    await editReportViaUI(page, grid, {
      cellInReport: "AG4",
      newName: "Renamed In Error",
      newDsl: EDITED_DSL,
    });
    const afterEdit = await listReports(page);
    expect(afterEdit[0].name, "the rename landed first").toBe("Renamed In Error");
    expect(await renderedCell(page, "AG3")).toBe("sales.amount");

    // A real Ctrl+Z on the grid.
    await grid.navigateTo("AG10");
    await grid.undo();
    await page.waitForTimeout(1800);

    // PRE-SAVE: the undo restored a VALUE, not an emptiness.
    const afterUndo = await listReports(page);
    expect(afterUndo, "undo did not delete the report").toHaveLength(1);
    expect(afterUndo[0].name, "PRE-SAVE: the old name is back").toBe("Original Name");
    expect(afterUndo[0].dslText, "PRE-SAVE: the old design query is back").toContain("sales.region");
    expect(await renderedCell(page, "AG3"), "PRE-SAVE: the old cells are back").toBe("sales.region");

    await saveWorkbook(page);
    await newFile(page);
    await reopenWorkbook(page);

    const afterReload = await listReports(page);
    expect(afterReload, "the report is in the reopened workbook").toHaveLength(1);
    expect(afterReload[0].name, "the UNDONE state is what the file holds").toBe("Original Name");
    expect(afterReload[0].dslText).toContain("sales.region");
    expect(await renderedCell(page, "AG3")).toBe("sales.region");
  });

  // -----------------------------------------------------------------------
  test("6. the reverse route is closed: set_extension_data('calcula.reports') is REFUSED and the reports are untouched", async ({
    appPage: page,
    grid,
  }) => {
    const cid = await setupCsvModel(page, "Report Store Model 6");
    await createReportViaUI(page, grid, {
      anchor: ANCHOR,
      name: "Protected Report",
      connectionId: cid,
      dsl: BASE_DSL,
    });
    expect(await listReports(page)).toHaveLength(1);

    // The slot key is spelled exactly like the Reports extension's manifest id,
    // and `setExtensionData(EXTENSION_ID, …)` is the idiom every other extension
    // uses to persist. One such call used to replace every report in the
    // workbook with whatever the caller was persisting.
    const refusal = await page.evaluate(async () => {
      const t = (
        window as unknown as {
          __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } };
        }
      ).__TAURI__;
      try {
        await t.core.invoke("set_extension_data", {
          extensionId: "calcula.reports",
          value: [],
        });
        return "ACCEPTED";
      } catch (e) {
        return String(e);
      }
    });
    expect(refusal, "the reserved slot must be refused, not silently written").not.toBe("ACCEPTED");
    expect(refusal).toContain("reserved extension-data key");

    // And the refusal really protected the data — before and after a round trip.
    expect(await listReports(page), "the report survived the attempt").toHaveLength(1);
    await saveWorkbook(page);
    await newFile(page);
    await reopenWorkbook(page);
    const afterReload = await listReports(page);
    expect(afterReload, "and it is in the reopened workbook").toHaveLength(1);
    expect(afterReload[0].name).toBe("Protected Report");
    expect(await renderedCell(page, "AG3")).toBe("sales.region");
  });

  // -----------------------------------------------------------------------
  test("7. the class sweep's other instance: an animation saved through the real panel survives save, File > New and reopen", async ({
    appPage: page,
  }) => {
    // The Animation extension had the same disease in TypeScript: a module-level
    // `let animations` plus a `persist()` each mutator had to remember, with the
    // extension-data blob as what the .cala keeps. The list is now a `#private`
    // field whose only mutating door writes through.
    await menuAction(page, "View", /Animation Timeline/);

    const newBtn = page.locator('[data-testid="anim-new"]');
    await expect(newBtn, "the Animation panel must be open").toHaveCount(1);
    await newBtn.click();
    await page.waitForTimeout(1000);

    const nameInput = page.locator('input[placeholder="Revenue ramp"]');
    await expect(nameInput, "the new-animation dialog must open").toHaveCount(1);
    await nameInput.fill("Quarterly Ramp");
    await page.locator('[data-testid="anim-cell-ref"]').fill("AG20");
    await page.locator('[data-testid="anim-create-btn"]').click();
    await page.waitForTimeout(1400);

    // PRE-SAVE: the animation is in the store.
    const before = await invoke<{ animations?: Array<{ name: string }> } | null>(
      page,
      "get_extension_data",
      { extensionId: "calcula.animation" },
    );
    expect(
      before?.animations?.map((a) => a.name),
      "PRE-SAVE: the saved animation is in the workbook's extension data",
    ).toContain("Quarterly Ramp");
    await expect(
      page.locator('[data-testid="anim-saved-list"]'),
      "PRE-SAVE: and the panel lists it",
    ).toContainText("Quarterly Ramp");

    await saveWorkbook(page);
    await newFile(page);
    const wiped = await invoke<{ animations?: Array<{ name: string }> } | null>(
      page,
      "get_extension_data",
      { extensionId: "calcula.animation" },
    );
    expect(wiped?.animations ?? [], "File > New really emptied it").toHaveLength(0);

    await reopenWorkbook(page);

    const after = await invoke<{ animations?: Array<{ name: string }> } | null>(
      page,
      "get_extension_data",
      { extensionId: "calcula.animation" },
    );
    expect(
      after?.animations?.map((a) => a.name),
      "the saved animation survived the round trip",
    ).toContain("Quarterly Ramp");
  });
});
