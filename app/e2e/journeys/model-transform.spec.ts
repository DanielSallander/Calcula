/**
 * TABLE TRANSFORMATIONS ("applied steps") — the import→transform→refresh loop,
 * proved live against the real engine.
 *
 * The feature's claim is that a user can import a table and then RESHAPE it —
 * filter rows out, rename a column, add a computed one — and that the reshaped
 * table is what the model actually holds afterwards. Unit tests prove each step
 * derives and evaluates; the facade tests prove refresh reaches the pipeline.
 * Neither proves the loop through the real Tauri command surface, over a real
 * connector, in a running app. This does.
 *
 * THE PROBES, AND WHY THEY HAVE TEETH
 *
 *   "does a step SHAPE the table?"  -> after setting a removeColumns step, the
 *                                      overview's column list for the table is
 *                                      polled until it no longer contains the
 *                                      removed column. The columns come from
 *                                      the BACKEND overview, never from the
 *                                      steps we sent — so this fails if the
 *                                      engine accepted the steps but did not
 *                                      re-derive the schema.
 *   "does it FILTER data?"          -> `previewStep` over the real CSV source
 *                                      returns fewer rows than the source has,
 *                                      and none of them is the excluded value.
 *                                      A preview that silently ignored the
 *                                      condition would return all four rows.
 *   "is asOfStep honest?"           -> the SAME candidate pipeline is previewed
 *                                      at -1 (source), 1, and 2, and the row
 *                                      and column counts must differ in the
 *                                      documented way. A backend that ignored
 *                                      asOfStep would return three identical
 *                                      results — which is exactly the bug a
 *                                      single-preview assertion could not see.
 *   "does it SURVIVE a save?"       -> the workbook is saved and reopened and
 *                                      the steps come back. Steps live in the
 *                                      model JSON inside the .cala, so a
 *                                      persistence gap here is silent data loss
 *                                      dressed up as a working feature.
 *   "does it REFUSE bad steps?"     -> a step naming a column that does not
 *                                      exist must be rejected with the step's
 *                                      INDEX, and must leave the model
 *                                      untouched. A partial edit is worse than
 *                                      a refused one.
 *
 * DRIVEN THROUGH RAW INVOKES, DELIBERATELY. `bi_model_*` commands accept the
 * MAIN window (guard MAIN_AND_MODEL_EDITOR), so the whole loop is exercised
 * without opening the Model Editor window — the same choice
 * macro-model-recording.spec.ts makes, and for the same reason: it isolates the
 * command + engine contract from the editor's DOM, which has its own coverage.
 *
 * THE SOURCE IS A REAL CSV FOLDER. A blank model has no tables, and no
 * main-window command seeds one with data. Writing a CSV to a temp folder and
 * pointing a `csv` source at it is the only way to get a BOUND table with real
 * rows — which is the whole point, since a pipeline runs between fetch and
 * store and an unbound table never fetches.
 *
 * NO SEPARATOR HAZARD. The one expression here is `status <> "cancelled"` — a
 * comparison with no argument list, so the sv-SE ';' argument separator never
 * applies. Note also that this expression language has NO `&&`: logical AND is
 * the `AND` keyword, which is what any expression added here must use.
 *
 * SHARED APP, JOURNEY PROJECT. Starts with newFile (which is why this lives in
 * e2e/journeys, not e2e/tests) and removes the BI connection and the temp CSV
 * folder afterwards.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Raw Tauri invoke, the journey idiom (dirty-flag.spec.ts). */
async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const t = (window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
      }).__TAURI__;
      return t.core.invoke(c, a);
    },
    { c: cmd, a: args },
  ) as Promise<T>;
}

/** The file-api helper (newFile / openFileAtPath), same idiom as floating-range.spec.ts. */
async function fileApi<T = unknown>(page: Page, fn: string, arg?: string): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const mod = await (window as unknown as {
        __calcImport: (u: string) => Promise<Record<string, (a?: unknown) => Promise<unknown>>>;
      }).__calcImport(new URL("/src/core/lib/file-api.ts", document.baseURI).href);
      return (await mod[fn](arg)) as unknown;
    },
    { fn, arg },
  ) as Promise<T>;
}

const MODEL_NAME = "E2E Transform Model";
const SOURCE_ID = "e2e_csv";
const TABLE = "orders";

/** Four orders; one is cancelled and one is under the amount threshold. */
const CSV = [
  "id,status,amount,note",
  "1,open,150,alpha",
  "2,cancelled,200,beta",
  "3,open,50,gamma",
  "4,closed,300,delta",
].join("\n");

interface ColumnInfo {
  name: string;
}
interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  storageMode: string;
  bound: boolean;
  transformSteps: Array<Record<string, unknown>>;
  sourceColumns: ColumnInfo[];
}
interface Overview {
  tables: TableInfo[];
}
interface PreviewResult {
  columns: string[];
  rows: Array<Array<string | null>>;
  rowCount: number;
  truncated: boolean;
  sampled: boolean;
  diagnostics: Array<{ index: number; message: string }>;
}

const tableOf = (overview: Overview, name: string): TableInfo => {
  const found = overview.tables.find((t) => t.name === name);
  if (!found) {
    throw new Error(
      `table '${name}' not in overview (have: ${overview.tables.map((t) => t.name).join(", ")})`,
    );
  }
  return found;
};

const columnNames = (t: TableInfo): string[] => t.columns.map((c) => c.name);

test.describe("BI model — table transformations", () => {
  let csvDir = "";
  let connectionId = "";

  test("import, transform, preview, persist", async ({ grid }) => {
    const page = grid.page;
    test.setTimeout(180_000);

    // --- Arrange: a real CSV folder source ---------------------------------
    csvDir = fs.mkdtempSync(path.join(os.tmpdir(), "calcula-transform-e2e-"));
    fs.writeFileSync(path.join(csvDir, `${TABLE}.csv`), CSV, "utf8");

    await fileApi(page, "newFile");
    await page.waitForTimeout(500);

    const created = await invoke<{ id: string }>(page, "bi_model_create_blank", {
      name: MODEL_NAME,
    });
    connectionId = created.id;
    expect(connectionId, "bi_model_create_blank returned a connection id").toBeTruthy();

    // A CSV source keeps its directory in `database` and its cosmetic schema
    // name in `defaultSchema` (PersistedConnection has no dedicated path field).
    await invoke(page, "bi_model_upsert_source", {
      connectionId,
      id: SOURCE_ID,
      kind: "csv",
      host: null,
      port: null,
      database: csvDir,
      defaultSchema: "csv",
      trustServerCertificate: false,
      sslMode: null,
      preferredAuth: "integrated",
      displayName: "E2E CSV",
    });
    await invoke(page, "bi_model_connect_source", {
      connectionId,
      sourceId: SOURCE_ID,
      connectionString: "",
      remember: false,
    });

    const listed = await invoke<Array<{ schema: string; name: string }>>(
      page,
      "bi_model_list_source_tables",
      { connectionId },
    );
    const sourceTable = listed.find((t) => t.name === TABLE);
    expect(sourceTable, `source table '${TABLE}' was listed`).toBeTruthy();

    let overview = await invoke<Overview>(page, "bi_model_import_tables", {
      connectionId,
      tables: [{ schema: sourceTable!.schema, name: sourceTable!.name }],
    });
    const imported = tableOf(overview, TABLE);
    expect(imported.bound, "the imported table is bound to its source").toBe(true);
    expect(columnNames(imported)).toEqual(
      expect.arrayContaining(["id", "status", "amount", "note"]),
    );
    expect(
      imported.transformSteps,
      "a freshly imported table has no pipeline",
    ).toEqual([]);

    // --- Probe 1: a candidate pipeline previews before it is saved ---------
    const candidate = [
      { type: "filterRows", condition: 'status <> "cancelled"' },
      { type: "removeColumns", columns: ["note"] },
    ];

    const source = await invoke<PreviewResult>(page, "bi_model_transform", {
      connectionId,
      op: "previewStep",
      table: TABLE,
      steps: candidate,
      asOfStep: -1, // the step list's "Source" row
      rowLimit: null,
      queryId: null,
    });
    expect(source.diagnostics, "the source sample is clean").toEqual([]);
    expect(source.rowCount, "the CSV has four rows").toBe(4);
    expect(source.columns).toContain("note");

    const afterFilter = await invoke<PreviewResult>(page, "bi_model_transform", {
      connectionId,
      op: "previewStep",
      table: TABLE,
      steps: candidate,
      asOfStep: 1,
      rowLimit: null,
      queryId: null,
    });
    expect(afterFilter.rowCount, "the cancelled row is filtered out").toBe(3);
    expect(
      afterFilter.columns,
      "step 2 has not run yet, so `note` is still there",
    ).toContain("note");
    const statusIndex = afterFilter.columns.indexOf("status");
    expect(
      afterFilter.rows.map((r) => r[statusIndex]),
      "no cancelled row survives the filter",
    ).not.toContain("cancelled");

    const afterAll = await invoke<PreviewResult>(page, "bi_model_transform", {
      connectionId,
      op: "previewStep",
      table: TABLE,
      steps: candidate,
      asOfStep: null, // all steps
      rowLimit: null,
      queryId: null,
    });
    expect(afterAll.rowCount).toBe(3);
    expect(afterAll.columns, "the second step dropped `note`").not.toContain("note");

    // The candidate was never saved.
    overview = await invoke<Overview>(page, "bi_model_get_overview", { connectionId });
    expect(
      tableOf(overview, TABLE).transformSteps,
      "previewing must not persist the candidate steps",
    ).toEqual([]);

    // --- Probe 2: a bad step is refused, with its index, changing nothing ---
    const bad = await invoke<{ diagnostics: Array<{ index: number; message: string }> }>(
      page,
      "bi_model_transform",
      {
        connectionId,
        op: "deriveSchema",
        table: TABLE,
        steps: [
          { type: "removeColumns", columns: ["note"] },
          { type: "removeColumns", columns: ["does_not_exist"] },
        ],
        asOfStep: null,
        rowLimit: null,
        queryId: null,
      },
    );
    expect(bad.diagnostics.length, "the bad step produced a diagnostic").toBeGreaterThan(0);
    expect(
      bad.diagnostics[0].index,
      "the diagnostic names the SECOND step, not the first",
    ).toBe(1);
    expect(bad.diagnostics[0].message).toContain("does_not_exist");

    const rejected = await invoke<Overview>(page, "bi_model_transform", {
      connectionId,
      op: "set",
      table: TABLE,
      steps: [{ type: "removeColumns", columns: ["does_not_exist"] }],
      asOfStep: null,
      rowLimit: null,
      queryId: null,
    }).then(
      () => "accepted",
      (e: unknown) => String(e),
    );
    expect(rejected, "setting an invalid pipeline must fail").not.toBe("accepted");
    overview = await invoke<Overview>(page, "bi_model_get_overview", { connectionId });
    expect(
      columnNames(tableOf(overview, TABLE)),
      "a refused edit leaves the table exactly as it was",
    ).toEqual(expect.arrayContaining(["id", "status", "amount", "note"]));

    // --- Probe 3: saving the pipeline re-derives the table's columns -------
    overview = await invoke<Overview>(page, "bi_model_transform", {
      connectionId,
      op: "set",
      table: TABLE,
      steps: candidate,
      asOfStep: null,
      rowLimit: null,
      queryId: null,
    });
    const shaped = tableOf(overview, TABLE);
    expect(shaped.transformSteps.length, "both steps were saved").toBe(2);
    expect(
      columnNames(shaped),
      "the engine re-derived the table's columns from the steps",
    ).not.toContain("note");
    expect(columnNames(shaped)).toEqual(expect.arrayContaining(["id", "status", "amount"]));
    expect(
      shaped.sourceColumns.map((c) => c.name),
      "the source's own schema is recorded so later edits can derive from it",
    ).toEqual(expect.arrayContaining(["id", "status", "amount", "note"]));
    expect(
      shaped.storageMode,
      "a transformed table is InMemory — DirectQuery would push SQL for columns the source lacks",
    ).toContain("InMemory");

    // --- Probe 4: the pipeline survives save + reopen -----------------------
    const savePath = path.join(csvDir, "transform-journey.cala");
    await invoke(page, "save_file", { path: savePath });
    await page.waitForTimeout(1000);
    await fileApi(page, "newFile");
    await page.waitForTimeout(500);
    await invoke(page, "open_file", { path: savePath, password: null });
    await page.waitForTimeout(1500);

    const connections = await invoke<Array<{ id: string; name: string }>>(
      page,
      "bi_get_connections",
      {},
    );
    const reopened = connections.find((c) => c.name === MODEL_NAME);
    expect(reopened, "the BI connection came back after reopen").toBeTruthy();
    connectionId = reopened!.id;

    overview = await invoke<Overview>(page, "bi_model_get_overview", {
      connectionId,
    });
    const restored = tableOf(overview, TABLE);
    expect(
      restored.transformSteps.length,
      "the pipeline is stored in the model JSON inside the .cala",
    ).toBe(2);
    expect(
      (restored.transformSteps[0] as { type?: string }).type,
      "and the first step is the one we saved, in order",
    ).toBe("filterRows");
    expect(columnNames(restored), "the reopened table keeps its shaped columns").not.toContain(
      "note",
    );

    // --- Probe 5: clearing the pipeline restores the source schema ---------
    overview = await invoke<Overview>(page, "bi_model_transform", {
      connectionId,
      op: "set",
      table: TABLE,
      steps: [],
      asOfStep: null,
      rowLimit: null,
      queryId: null,
    });
    const cleared = tableOf(overview, TABLE);
    expect(cleared.transformSteps).toEqual([]);
    expect(
      columnNames(cleared),
      "clearing the steps brings the source's own columns back",
    ).toContain("note");
  });

  test.afterAll(async ({ sharedPage }) => {
    if (connectionId) {
      await invoke(sharedPage, "bi_disconnect", { connectionId }).catch(() => {});
    }
    if (csvDir) {
      fs.rmSync(csvDir, { recursive: true, force: true });
    }
  });
});
