/**
 * A NEW DOCUMENT CONTAINS NOTHING OF THE PREVIOUS ONE (§2w) — proved on the
 * SAVED BYTES, in the running app.
 *
 * WHAT WAS FIXED. `new_file` did not take `PivotState`, `RibbonFilterState` or
 * `BiState`, and nothing else reset them, while `assemble_workbook_for_save`
 * projects all three into every workbook it writes. So: give workbook A a model
 * connection, a pivot and a ribbon filter; File ▸ New; type one cell; Save as B
 * — and B physically contained A's pivot, A's ribbon filter and A's WHOLE
 * EMBEDDED MODEL:
 *
 *     pivot_definitions/def_….json   <- A's pivot
 *     ribbon_filters/filter_….json   <- A's ribbon filter
 *     bi_connections/conn_0.json     <- A's model: tables, bindings, measures
 *
 * BI connections were worse than the other two: nothing anywhere cleared the
 * map, so they accumulated for the LIFETIME OF THE PROCESS and every save
 * embedded all of them — across Open as well as File ▸ New.
 *
 * THE ORACLE IS THE ARCHIVE, NOT A COMMAND. `list_ribbon_filters` returning
 * nothing is a claim about memory; this reads the `.cala` off disk and
 * enumerates its ZIP central directory. That is what found the defect, and it is
 * the only oracle that cannot be satisfied by a store which is empty for some
 * unrelated reason at the moment it is asked.
 *
 * VACUOUS-PASS DISCIPLINE. Every "B does not contain X" is preceded by the
 * assertion that A DOES contain X, read from the same archive by the same
 * parser. A test that cannot see the entry when it is really there proves
 * nothing when it reports it absent.
 *
 * AND THE SECOND HALF (4a, 2026-08-10): DOCUMENT-SCOPED STATE THAT IS NOT SAVED.
 * §2w's census asks "is every store the SAVE PATH READS reset when the document
 * is replaced?". The undo stack is not a save source, so it was invisible to
 * that question by construction — and `new_file` cleared it in a block of its
 * own labelled "session state that is NOT a save source" which `open_file` never
 * ran. Open A, edit a cell, open B, press Ctrl+Z once, and B's cell is
 * overwritten with A's value and saved that way. The last two tests here are
 * that defect and its neighbour (the dynamic-array spill maps, which do not
 * merely inject a value — they DELETE cells of the newly opened workbook).
 *
 * WHY A JOURNEY. Every test calls File ▸ New, writes real `.cala` files and
 * reopens workbooks. The functional specs share one accumulating workbook.
 *
 * GRID REAL ESTATE. Columns CG..CM (84..90), rows 1..20 — outside every column
 * other specs claim. Every test starts from File ▸ New anyway.
 *
 * LOCALE. sv-SE. The only formula typed here is `=SEQUENCE(4)` — one argument,
 * so no list separator arises.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef } from "../helpers/grid";

const CSV_DIR = path.join(os.tmpdir(), "calcula-e2e-store-leak");
const FILE_A = path.join(os.tmpdir(), "calcula-e2e-leak-a.cala");
const FILE_B = path.join(os.tmpdir(), "calcula-e2e-leak-b.cala");
const FILE_C = path.join(os.tmpdir(), "calcula-e2e-leak-c.cala");
const FILE_D = path.join(os.tmpdir(), "calcula-e2e-leak-d.cala");
/** One control workbook per accumulation cycle — each saved from its own File > New. */
const CYCLE_FILES = [1, 2, 3].map((n) =>
  path.join(os.tmpdir(), `calcula-e2e-leak-cycle-${n}.cala`),
);
/** The .calp half: a registry, and the document a package is pulled into. */
const REGISTRY_DIR = path.join(os.tmpdir(), "calcula-e2e-leak-registry");
const FILE_PKG_SUB = path.join(os.tmpdir(), "calcula-e2e-leak-subscriber.cala");
const PACKAGE_NAME = "leak-probe-report";
/** Defect 4a: the undo stack outliving its document. Three workbooks. */
const FILE_UNDO_A = path.join(os.tmpdir(), "calcula-e2e-leak-undo-a.cala");
const FILE_UNDO_B = path.join(os.tmpdir(), "calcula-e2e-leak-undo-b.cala");
const FILE_UNDO_C = path.join(os.tmpdir(), "calcula-e2e-leak-undo-c.cala");
/** 4a's neighbour: the spill maps. */
const FILE_SPILL_A = path.join(os.tmpdir(), "calcula-e2e-leak-spill-a.cala");
const FILE_SPILL_B = path.join(os.tmpdir(), "calcula-e2e-leak-spill-b.cala");

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
  await page.waitForTimeout(900);
}

/**
 * Write one cell through the command the grid itself calls. `update_cell` takes
 * row/col: the A1 form is resolved here so the fixture reads like the grid the
 * user sees, and the locale's decimal separator never enters it (no number is
 * typed).
 */
async function setCell(page: Page, ref: string, value: string): Promise<void> {
  const { row, col } = parseCellRef(ref);
  await invoke(page, "update_cell", { row, col, value });
  await page.waitForTimeout(150);
}

async function saveAs(page: Page, target: string): Promise<void> {
  await invoke(page, "save_file", { path: target });
  await page.waitForTimeout(900);
}

async function openAt(page: Page, target: string): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "openFileAtPath", [target]);
  await page.waitForTimeout(2200);
}

// ---------------------------------------------------------------------------
// THE ORACLE: the archive's own entry list
// ---------------------------------------------------------------------------

/**
 * Every entry name in a `.cala`, read from the ZIP CENTRAL DIRECTORY.
 *
 * Written out rather than pulled from a package because the point of this spec
 * is to look at the bytes with nothing in between. The central directory is
 * used in preference to scanning for local headers because it is the archive's
 * authoritative index — a local header can be left behind by a rewritten entry.
 *
 * THROWS when the archive cannot be parsed. "No entries" and "could not look"
 * must never share a return value here: every assertion below is an ABSENCE, so
 * a parser that silently returned `[]` would pass this whole spec on a file it
 * had never opened.
 */
function calaEntries(file: string): string[] {
  if (!fs.existsSync(file)) {
    throw new Error(`the archive is missing at ${file} — nothing was saved`);
  }
  const buf = fs.readFileSync(file);
  // End of central directory: signature 0x06054b50, scanned from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error(
      `${file} has no ZIP end-of-central-directory record — it is not a plain ` +
        `.cala archive (an encrypted one would look like this)`,
    );
  }
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error(`${file}: central directory entry ${n} has a bad signature`);
    }
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.subarray(off + 46, off + 46 + nameLen).toString("utf8"));
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (names.length === 0) {
    throw new Error(`${file} contains no entries at all — the parse is broken`);
  }
  return names;
}

/** Entries under a given archive folder, e.g. "bi_connections/". */
function entriesUnder(file: string, folder: string): string[] {
  return calaEntries(file).filter((e) => e.startsWith(folder));
}

/**
 * The DECOMPRESSED text of every entry in a `.cala`, concatenated.
 *
 * `calaEntries` answers "is this OBJECT in the archive"; the undo defect needs
 * the other question — "which VALUE is in the archive" — because the leak is a
 * cell that looks entirely ordinary and holds another document's content. There
 * is no object to count; there is only the wrong string in the right place.
 *
 * Same discipline as `calaEntries`: it THROWS rather than returning "" on any
 * parse failure, because every assertion built on it is a `not.toContain`, and
 * an empty string satisfies all of them.
 */
function calaText(file: string): string {
  if (!fs.existsSync(file)) {
    throw new Error(`the archive is missing at ${file} — nothing was saved`);
  }
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error(`${file} has no ZIP end-of-central-directory record`);
  }
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const parts: string[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error(`${file}: central directory entry ${n} has a bad signature`);
    }
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${file}: entry ${n} has no local header at its recorded offset`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      parts.push(raw.toString("utf8"));
    } else if (method === 8) {
      parts.push(zlib.inflateRawSync(raw).toString("utf8"));
    } else {
      throw new Error(`${file}: entry ${n} uses unsupported compression method ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (parts.length === 0) {
    throw new Error(`${file} contains no entries at all — the parse is broken`);
  }
  return parts.join("\n");
}

/** The backend's undo/redo state, exactly as the ribbon's Undo button reads it. */
async function undoState(page: Page): Promise<{
  canUndo: boolean;
  undoDepth: number;
  undoDescription: string | null;
}> {
  return invoke(page, "get_undo_state");
}

/** One cell's displayed text, read the way the grid reads it. */
async function cellDisplay(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const cells = await invoke<Array<{ row: number; col: number; display: string }>>(
    page,
    "get_cells_in_rows",
    { startRow: row, endRow: row },
  );
  return cells.find((c) => c.row === row && c.col === col)?.display ?? "";
}

// ---------------------------------------------------------------------------
// The fixture: a CSV-backed model, a grid pivot and a ribbon filter over them.
// Setup, never the thing under test.
// ---------------------------------------------------------------------------

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
  return conn.id;
}

/** Type the little source block a grid pivot is built from, then build it. */
async function setupGridPivot(page: Page): Promise<void> {
  const rows: Array<[string, string]> = [
    ["CG1", "Region"],
    ["CH1", "Amount"],
    ["CG2", "North"],
    ["CH2", "100"],
    ["CG3", "South"],
    ["CH3", "250"],
  ];
  for (const [ref, value] of rows) {
    await setCell(page, ref, value);
  }
  await invoke(page, "create_pivot_table", {
    request: {
      sourceRange: "CG1:CH3",
      destinationCell: "CJ1",
      sourceSheet: null,
      destinationSheet: null,
      hasHeaders: true,
      name: "LEAK PROBE PIVOT",
      sourceTableName: null,
    },
  });
  await page.waitForTimeout(900);
}

async function setupRibbonFilter(page: Page, connectionId: string): Promise<void> {
  await invoke(page, "create_ribbon_filter", {
    params: {
      name: "LEAK PROBE FILTER",
      connectionId,
      fieldName: "sales.region",
      fieldDataType: "text",
      displayMode: null,
      order: null,
    },
  });
  await page.waitForTimeout(400);
}

/** Build workbook A: model connection + grid pivot + ribbon filter, saved. */
async function buildWorkbookA(page: Page, target: string): Promise<void> {
  await newFile(page);
  const connectionId = await setupCsvModel(page, "LEAK PROBE MODEL");
  await setupGridPivot(page);
  await setupRibbonFilter(page, connectionId);
  await saveAs(page, target);
}

// ===========================================================================

test.describe("a new document carries nothing of the previous one", () => {
  test.beforeAll(() => {
    for (const f of [
      FILE_A,
      FILE_B,
      FILE_C,
      FILE_D,
      FILE_PKG_SUB,
      FILE_UNDO_A,
      FILE_UNDO_B,
      FILE_UNDO_C,
      FILE_SPILL_A,
      FILE_SPILL_B,
      ...CYCLE_FILES,
    ]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    // A registry left behind by an earlier run already holds this package name
    // at 1.0.0, and publishing over an existing version is refused.
    if (fs.existsSync(REGISTRY_DIR)) {
      fs.rmSync(REGISTRY_DIR, { recursive: true, force: true });
    }
  });

  test("File > New then save: B contains none of A's pivot, filter or model", async ({ appPage: page }) => {
    test.setTimeout(240_000);

    await buildWorkbookA(page, FILE_A);

    // THE VACUITY GUARD. Everything below is an absence, so the archive parser
    // must first be shown finding all three when they really are there.
    expect(
      entriesUnder(FILE_A, "pivot_definitions/"),
      "workbook A must really carry its pivot, or the absence assertions below prove nothing",
    ).not.toHaveLength(0);
    expect(
      entriesUnder(FILE_A, "ribbon_filters/"),
      "workbook A must really carry its ribbon filter",
    ).not.toHaveLength(0);
    expect(
      entriesUnder(FILE_A, "bi_connections/"),
      "workbook A must really carry its embedded model",
    ).not.toHaveLength(0);

    // The user's whole gesture: File > New, type one cell, Save As.
    await newFile(page);
    await setCell(page, "CG1", "only this");
    await saveAs(page, FILE_B);

    expect(
      entriesUnder(FILE_B, "pivot_definitions/"),
      "a document the user typed ONE CELL into carries the previous workbook's pivot",
    ).toHaveLength(0);
    expect(
      entriesUnder(FILE_B, "ribbon_filters/"),
      "a document the user typed ONE CELL into carries the previous workbook's ribbon filter",
    ).toHaveLength(0);
    expect(
      entriesUnder(FILE_B, "bi_connections/"),
      "a document the user typed ONE CELL into carries the previous workbook's " +
        "MODEL CONNECTION — tables, bindings, measures and source catalog, in a " +
        "file they may well send to somebody else",
    ).toHaveLength(0);

    // ...and B really was written, so the emptiness is B's and not a missing file.
    expect(
      calaEntries(FILE_B),
      "B must be a real archive with the ordinary sections in it",
    ).toContain("manifest.json");
  });

  test("Open then save: D contains none of C's predecessor's model", async ({ appPage: page }) => {
    test.setTimeout(240_000);

    // C is an ordinary workbook with no model of its own.
    await newFile(page);
    await setCell(page, "CG5", "plain");
    await saveAs(page, FILE_C);
    expect(
      entriesUnder(FILE_C, "bi_connections/"),
      "C is the control: it never had a model",
    ).toHaveLength(0);

    // A has one. Open it, then open C, then save C's document under a new name.
    // BI connections used to be only ever ADDED to, so this is the sequence in
    // which they accumulated for the life of the process.
    await buildWorkbookA(page, FILE_A);
    expect(
      entriesUnder(FILE_A, "bi_connections/"),
      "precondition: A really carries a model",
    ).not.toHaveLength(0);

    await openAt(page, FILE_A);
    await openAt(page, FILE_C);
    await saveAs(page, FILE_D);

    expect(
      entriesUnder(FILE_D, "bi_connections/"),
      "opening a workbook with a model and then opening another left the first " +
        "one's connection live — every subsequent save in the session embeds it",
    ).toHaveLength(0);
    expect(
      entriesUnder(FILE_D, "pivot_definitions/"),
      "the previously-opened workbook's pivot survived into this one",
    ).toHaveLength(0);
    expect(
      entriesUnder(FILE_D, "ribbon_filters/"),
      "the previously-opened workbook's ribbon filter survived into this one",
    ).toHaveLength(0);
  });

  test("reopening A still finds everything A owns", async ({ appPage: page }) => {
    test.setTimeout(240_000);

    // THE COUNTERWEIGHT. A reset that ran too eagerly — or in the wrong place in
    // `open_file` — would pass both tests above by destroying the document being
    // opened. The invariant is "exactly the opened document's state", not "less".
    await buildWorkbookA(page, FILE_A);
    await newFile(page);
    await openAt(page, FILE_A);

    const pivots = await invoke<unknown[]>(page, "get_all_pivot_tables", {});
    expect(pivots.length, "A's pivot must come back when A is reopened").toBeGreaterThan(0);

    const filters = await invoke<unknown[]>(page, "get_all_ribbon_filters", {});
    expect(filters.length, "A's ribbon filter must come back when A is reopened").toBeGreaterThan(
      0,
    );

    const connections = await invoke<unknown[]>(page, "bi_get_connections", {});
    expect(
      connections.length,
      "A's model connection must be reconstructed from the embedded model",
    ).toBeGreaterThan(0);

    // And saving it again writes the same sections back — the reset did not
    // quietly eat the content between open and save.
    await saveAs(page, FILE_A);
    expect(entriesUnder(FILE_A, "pivot_definitions/")).not.toHaveLength(0);
    expect(entriesUnder(FILE_A, "ribbon_filters/")).not.toHaveLength(0);
    expect(entriesUnder(FILE_A, "bi_connections/")).not.toHaveLength(0);
  });

  test("three cycles in ONE app lifetime accumulate nothing", async ({ appPage: page }) => {
    test.setTimeout(300_000);

    // WHY THREE. The defect was not "the store is dirty once": nothing anywhere
    // cleared `BiState.connections`, so every document opened in the process
    // ADDED to it and every save embedded the union. One open/save pair cannot
    // tell a leak apart from a store that happened to be non-empty; a count that
    // does not grow over three identical cycles can.
    await buildWorkbookA(page, FILE_A);
    expect(
      entriesUnder(FILE_A, "bi_connections/"),
      "precondition: A really carries exactly one model",
    ).toHaveLength(1);

    const connectionCounts: number[] = [];
    for (let cycle = 0; cycle < CYCLE_FILES.length; cycle++) {
      // Open the model-bearing workbook...
      await openAt(page, FILE_A);
      const live = await invoke<unknown[]>(page, "bi_get_connections", {});
      connectionCounts.push(live.length);

      // ...then start a brand-new document and save it. Nothing of A may reach it.
      await newFile(page);
      await setCell(page, "CG10", `cycle ${cycle + 1}`);
      await saveAs(page, CYCLE_FILES[cycle]);

      expect(
        entriesUnder(CYCLE_FILES[cycle], "bi_connections/"),
        `cycle ${cycle + 1}: a blank document carries model connections from the ` +
          `workbook opened before it`,
      ).toHaveLength(0);
      expect(
        entriesUnder(CYCLE_FILES[cycle], "pivot_definitions/"),
        `cycle ${cycle + 1}: a blank document carries the previous workbook's pivot`,
      ).toHaveLength(0);
      expect(
        entriesUnder(CYCLE_FILES[cycle], "ribbon_filters/"),
        `cycle ${cycle + 1}: a blank document carries the previous workbook's ribbon filter`,
      ).toHaveLength(0);
    }

    // THE ACCUMULATION ORACLE. Opening A three times must leave exactly A's own
    // connection live each time. 1,2,3 is the defect; anything below 1 would mean
    // the reset ate the document being opened (test 3 guards that side too).
    expect(
      connectionCounts,
      "opening the same model-bearing workbook three times in one process left a " +
        "growing pile of connections — every save in the session embeds all of them",
    ).toEqual([1, 1, 1]);
  });

  test(".calp: a pulled package's model resolves, and does not outlive its document", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);

    // THE OTHER HALF OF THE DECISION. The fix deliberately does NOT reset in
    // `calp_pull`: a pull materializes package content INTO the open document and
    // is the only flow that legitimately creates a BI connection, so resetting
    // there would delete the connection the pull had just made. That decision is
    // only sound if BOTH halves hold — the pulled model still resolves inside the
    // document that pulled it, AND it is gone the moment that document is
    // replaced. Both are asserted here.
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });

    // Publish workbook A (model + pivot + filter) as a report package.
    await buildWorkbookA(page, FILE_A);
    const published = await invoke<{ packageName: string; version: string }>(
      page,
      "calp_publish",
      {
        params: {
          registryPath: REGISTRY_DIR,
          packageName: PACKAGE_NAME,
          version: "1.0.0",
          kind: "report",
          sheetIndices: [],
          publishedBy: "e2e",
          includeComments: false,
        },
      },
    );
    expect(
      published.version,
      "precondition: the package must really have been published, or the pull " +
        "below would be testing nothing",
    ).toBe("1.0.0");

    // A FRESH document subscribes to it. This is the subscriber's machine as far
    // as the stores are concerned: File > New has just wiped everything.
    await newFile(page);
    const beforePull = await invoke<unknown[]>(page, "bi_get_connections", {});
    expect(
      beforePull,
      "the subscriber's blank document must start with no connections at all",
    ).toHaveLength(0);

    await invoke(page, "calp_pull", {
      params: {
        registryPath: REGISTRY_DIR,
        packageName: PACKAGE_NAME,
        versionPin: "1.0.0",
      },
    });
    await page.waitForTimeout(1500);

    // (1) THE SUBSCRIBED REPORT RESOLVES ITS MODEL.
    const pulled = await invoke<Array<{ id: string; name: string }>>(
      page,
      "bi_get_connections",
      {},
    );
    expect(
      pulled.length,
      "pulling a package with a data source must materialize its BI connection — " +
        "without it a subscribed report cannot refresh anything",
    ).toBeGreaterThan(0);

    const info = await invoke<{ tables?: unknown[] } | null>(page, "bi_get_model_info", {
      connectionId: pulled[0].id,
    });
    expect(
      info,
      "the pulled connection has no engine: the connection exists but the model " +
        "behind it does not, which is a report that cannot resolve",
    ).not.toBeNull();
    expect(
      info?.tables ?? [],
      "the pulled model carries no tables — the package's embedded model did not load",
    ).not.toHaveLength(0);

    // The subscriber can save; the package connection is deliberately NOT written
    // into the `.cala` (it reconstructs from the .calp — `capture_local_bi_connections`
    // skips `package_data_source_id`), so this asserts the shape the fix relies on
    // rather than a leak.
    await saveAs(page, FILE_PKG_SUB);
    expect(
      entriesUnder(FILE_PKG_SUB, "bi_connections/"),
      "a package connection was written into the subscriber's .cala — it is " +
        "supposed to reconstruct from the package, not be embedded twice",
    ).toHaveLength(0);

    // (2) AND IT DOES NOT OUTLIVE ITS DOCUMENT. Before the fix this connection
    // survived File > New and every later save in the session embedded whatever
    // it could — including a package model the new document never subscribed to.
    await newFile(page);
    const afterNew = await invoke<unknown[]>(page, "bi_get_connections", {});
    expect(
      afterNew,
      "the pulled package's connection survived File > New — the document that " +
        "subscribed is gone and its model is still live",
    ).toHaveLength(0);

    await setCell(page, "CG12", "after the pull");
    await saveAs(page, FILE_D);
    expect(
      entriesUnder(FILE_D, "bi_connections/"),
      "a document created after a package pull carries the package's model",
    ).toHaveLength(0);
  });

  // =========================================================================
  // DEFECT 4a — the undo stack outliving its document, and its neighbour
  // =========================================================================

  test("Open then ONE Ctrl+Z: the opened workbook keeps its own value", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);

    // THE ORACLE THAT FOUND IT, unchanged. Two workbooks whose CL1 differ by a
    // single word, one edit, one undo, one save — and then the bytes.
    await newFile(page);
    await setCell(page, "CL1", "A-ORIGINAL");
    await saveAs(page, FILE_UNDO_A);

    await newFile(page);
    await setCell(page, "CL1", "B-ORIGINAL");
    await saveAs(page, FILE_UNDO_B);

    // Workbook A, with one undoable edit in it — ON THE SAME CELL. That is what
    // makes the entry dangerous rather than merely stale: its before-image is
    // "A-ORIGINAL" AT CL1, so applying it in another document overwrites CL1
    // there. An entry pointing at a cell the new document happens to leave empty
    // would still be a leak, and would still be wrong, but it would not show up
    // in the bytes — and a test that cannot see the corruption is not a test of
    // it. (Measured: with the reset removed and the probe editing a DIFFERENT
    // cell, this spec passed on a demonstrably broken build.)
    await openAt(page, FILE_UNDO_A);
    await setCell(page, "CL1", "A-EDITED");

    // VACUITY GUARD. Everything below asserts an ABSENCE of history, so the
    // reader must first be shown history when there really is some.
    const inA = await undoState(page);
    expect(
      inA.canUndo,
      "the edit in A produced no undo entry, so the assertions below would pass " +
        "on a stack that was never populated",
    ).toBe(true);
    expect(inA.undoDepth, "A's stack must hold the edit just made").toBeGreaterThan(0);

    // Now open B. The document on screen has never been edited.
    await openAt(page, FILE_UNDO_B);
    expect(
      await cellDisplay(page, "CL1"),
      "precondition: B really is the document on screen",
    ).toBe("B-ORIGINAL");

    const inB = await undoState(page);
    expect(
      inB.canUndo,
      `the freshly-opened workbook offers an undo it has not earned ` +
        `(depth ${inB.undoDepth}, "${inB.undoDescription ?? ""}"). The stack ` +
        `belongs to the workbook that is no longer open, and its entries name ` +
        `bare (sheet, row, col) coordinates — so applying one here overwrites ` +
        `a cell of THIS document with a value from THAT one`,
    ).toBe(false);
    expect(inB.undoDepth, "a freshly-opened workbook has no undo history").toBe(0);

    // THE GESTURE. One Ctrl+Z, which a user presses without thinking.
    await invoke(page, "undo");
    await page.waitForTimeout(400);

    expect(
      await cellDisplay(page, "CL1"),
      "one Ctrl+Z after File ▸ Open replaced the open workbook's cell with the " +
        "PREVIOUS workbook's value",
    ).toBe("B-ORIGINAL");

    // ...and the bytes, which is where the damage becomes permanent.
    await saveAs(page, FILE_UNDO_C);
    const saved = calaText(FILE_UNDO_C);
    expect(
      saved,
      "the saved workbook does not contain its own cell value at all",
    ).toContain("B-ORIGINAL");
    expect(
      saved,
      "THE 4a CORRUPTION, on disk: a workbook saved after one Ctrl+Z physically " +
        "contains a value from a DIFFERENT document, written into a cell the " +
        "user never touched",
    ).not.toContain("A-ORIGINAL");
  });

  test("Open then edit: the previous workbook's spill does not delete cells here", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);

    // Workbook A: one dynamic-array formula spilling CL1:CL4.
    await newFile(page);
    await setCell(page, "CL1", "=SEQUENCE(4)");
    await page.waitForTimeout(500);
    expect(
      await cellDisplay(page, "CL3"),
      "VACUITY GUARD: A's SEQUENCE must really spill, or nothing below is being " +
        "tested — a spill that never happened leaks no map",
    ).not.toBe("");
    await saveAs(page, FILE_SPILL_A);

    // Workbook B: ordinary literals at exactly the coordinates A's spill covered.
    await newFile(page);
    for (const [ref, value] of [
      ["CL1", "B-ONE"],
      ["CL2", "B-TWO"],
      ["CL3", "B-THREE"],
      ["CL4", "B-FOUR"],
    ] as Array<[string, string]>) {
      await setCell(page, ref, value);
    }
    await saveAs(page, FILE_SPILL_B);

    // The sequence: open A (its spill is registered), then open B.
    await openAt(page, FILE_SPILL_A);
    await openAt(page, FILE_SPILL_B);

    // (1) THE REFUSAL. `check_spill_protection` reads the stale `spill_hosts`
    //     and rejects the edit, naming a formula in a workbook that is closed.
    await setCell(page, "CL2", "B-TWO EDITED");
    expect(
      await cellDisplay(page, "CL2"),
      "editing a cell of the newly-opened workbook was refused because the " +
        "PREVIOUS workbook had a spill at that coordinate — those cells stay " +
        "uneditable for the rest of the session",
    ).toBe("B-TWO EDITED");

    // (2) THE DELETION, which is the part that loses data. Clearing the stale
    //     spill ORIGIN takes the branch that removes every coordinate the
    //     previous document's spill covered — from THIS document's grid.
    await setCell(page, "CL1", "");
    await page.waitForTimeout(400);

    for (const [ref, expected] of [
      ["CL2", "B-TWO EDITED"],
      ["CL3", "B-THREE"],
      ["CL4", "B-FOUR"],
    ] as Array<[string, string]>) {
      expect(
        await cellDisplay(page, ref),
        `clearing ${"CL1"} deleted ${ref} — a cell of the open workbook that the ` +
          `user never touched, because the PREVIOUS workbook's spill map still ` +
          `claimed that coordinate. There is no undo entry for it: the undo ` +
          `transaction records only the cell actually edited`,
      ).toBe(expected);
    }
  });
});
