/**
 * §2aa THROUGH THE REAL UI — a subscribed `.calp` report resolves its model
 * after save + reopen, and fails SAFELY when it cannot.
 *
 * WHAT §2aa WAS. `capture_local_bi_connections` deliberately skips PACKAGE
 * connections when saving a `.cala` — a package's model belongs to its
 * publisher and travels in the `.calp`; embedding a copy in every subscriber's
 * file would let a subscriber serve a model no publisher ever signed. What was
 * missing is the other half: nothing ever put them back. Measured on a saved
 * subscriber workbook, a reopen gave `bi_get_connections` = **0**, and every BI
 * pivot in the report pointed at `ConnectionId::ZERO`. There was even a comment
 * claiming the restore ran on the open path; it described an intention with no
 * implementation behind it.
 *
 * THE FIX re-materializes from the SUBSCRIPTION LEDGER plus the local package
 * cache, through the same three gates a pull runs, in the same order, under
 * `PinPolicy::RequirePinned`: signature over the pinned publisher key, min-app
 * version, then every artifact hashed against the signed manifest.
 *
 * WHY THE UNHAPPY PATHS ARE HALF THIS SPEC. A restore that "usually works" is
 * indistinguishable, on a green run, from one that falls back to unverified
 * bytes — and falling back is the failure mode that matters, because a `.cala`
 * arrives BY EMAIL naming a package and a registry of its author's choosing.
 * The three answers the design commits to are asserted here, not assumed:
 *   - package/version gone   -> no connection, a NAMED skip, the workbook still
 *                               opens on the last pull's cells;
 *   - artifact tampered with -> no connection, a DIFFERENT named skip, and NO
 *                               fallback to the unverified bytes;
 *   - and neither is silent: `calp_get_package_connection_skips` reports both,
 *     because "this package has no data source" and "this package's model could
 *     not be verified on this machine" must not be the same observable state.
 *
 * THE REGISTRY IS SNAPSHOTTED after publication and restored between tests, so
 * the sabotage each unhappy-path test performs is undone for the next one and
 * the happy path can be re-proved at the end.
 *
 * WHY A JOURNEY. It publishes, calls File > New, saves and reopens workbooks.
 *
 * GRID REAL ESTATE. Columns EK..EP (140..145). Every test starts from File > New.
 *
 * LOCALE. sv-SE. No formula here needs a list separator.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef } from "../helpers/grid";

const WORK = path.join(os.tmpdir(), "calcula-subscription-restore");
const CSV_DIR = path.join(WORK, "csv");
const REGISTRY = path.join(WORK, "registry");
/** A pristine copy of the registry, taken right after publication. */
const REGISTRY_BACKUP = path.join(WORK, "registry-pristine");
const FILE_PUBLISHER = path.join(WORK, "publisher.cala");
const FILE_SUBSCRIBER = path.join(WORK, "subscriber.cala");

const PACKAGE = "subscription-restore-report";
const VERSION = "1.0.0";
const MODEL_NAME = "SUBSCRIPTION RESTORE MODEL";
/** A cell of the subscriber's own workbook, so "it still opens" is checkable. */
const SUBSCRIBER_CELL = "EK5";
const SUBSCRIBER_VALUE = "SUBSCRIBER-OWN-CELL";

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
  await page.waitForTimeout(900);
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

async function cellDisplay(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const cells = await invoke<Array<{ row: number; col: number; display: string }>>(
    page,
    "get_viewport_cells",
    { startRow: row, startCol: col, endRow: row, endCol: col },
  );
  return String(cells[0]?.display ?? "");
}

interface Connection {
  id: string;
  name: string;
  packageDataSourceId?: string | null;
}

async function connections(page: Page): Promise<Connection[]> {
  return invoke<Connection[]>(page, "bi_get_connections", {});
}

interface Skip {
  packageName: string;
  registryUrl: string;
  reason: string;
  detail: string;
}

async function skips(page: Page): Promise<Skip[]> {
  return invoke<Skip[]>(page, "calp_get_package_connection_skips", {});
}

/** The subscription ledger — the thing the restore reads. */
async function subscriptions(
  page: Page,
): Promise<Array<{ packageName: string; resolvedVersion: string }>> {
  const manifest = await invoke<{
    subscriptions?: Array<{ packageName: string; resolvedVersion: string }>;
  }>(page, "calp_get_subscriptions", {});
  return manifest.subscriptions ?? [];
}

// ---------------------------------------------------------------------------
// Registry surgery — the two unhappy paths, performed on the bytes on disk.
// ---------------------------------------------------------------------------

function versionDir(): string {
  return path.join(REGISTRY, PACKAGE, VERSION);
}

/**
 * The BLOB holding the published model.
 *
 * A registry does not store artifacts under their logical paths: the version
 * directory holds only `version-manifest.json` + `.sig`, and every artifact
 * lives content-addressed in `<registry>/.blobs/<first two hex>/<sha256>`. The
 * logical path -> digest map is `artifactChecksums` in the signed manifest, so
 * that is where the model's blob is looked up. (The first version of this
 * helper looked for `models/<id>/model.json` on disk and threw — the directory
 * exists and is EMPTY, which is exactly the kind of layout assumption that would
 * otherwise have made a tampering test corrupt nothing and pass.)
 *
 * THROWS at every step. A tampering test that silently corrupted the wrong file
 * would assert a refusal that no refusal caused.
 */
function modelBlobPath(): string {
  const manifestFile = path.join(versionDir(), "version-manifest.json");
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`the published version has no manifest at ${manifestFile}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
    artifactChecksums?: Record<string, string>;
  };
  const checksums = manifest.artifactChecksums ?? {};
  const modelEntries = Object.entries(checksums).filter(
    ([logical]) => logical.startsWith("models/") && logical.endsWith("model.json"),
  );
  if (modelEntries.length !== 1) {
    throw new Error(
      `expected exactly one published model artifact, found ${modelEntries.length} in ` +
        `${JSON.stringify(Object.keys(checksums))} — the package carries no model, so ` +
        `the tampering below would corrupt nothing`,
    );
  }
  const digest = modelEntries[0][1];
  const blob = path.join(REGISTRY, ".blobs", digest.slice(0, 2), digest);
  if (!fs.existsSync(blob)) {
    throw new Error(`the model artifact's blob is missing at ${blob}`);
  }
  return blob;
}

function snapshotRegistry(): void {
  if (fs.existsSync(REGISTRY_BACKUP)) fs.rmSync(REGISTRY_BACKUP, { recursive: true, force: true });
  fs.cpSync(REGISTRY, REGISTRY_BACKUP, { recursive: true });
}

function restoreRegistry(): void {
  if (!fs.existsSync(REGISTRY_BACKUP)) {
    throw new Error("no pristine registry snapshot — the happy path never ran");
  }
  fs.rmSync(REGISTRY, { recursive: true, force: true });
  fs.cpSync(REGISTRY_BACKUP, REGISTRY, { recursive: true });
}

// ---------------------------------------------------------------------------
// The fixture — a CSV-backed model, published as a report package.
// Setup, never the thing under test.
// ---------------------------------------------------------------------------

async function buildPublisherWorkbook(page: Page): Promise<string> {
  fs.mkdirSync(CSV_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CSV_DIR, "sales.csv"),
    "region,amount\nNorth,100\nSouth,250\nNorth,50\nEast,25\n",
    "utf8",
  );

  await newFile(page);
  const conn = await invoke<{ id: string }>(page, "bi_model_create_blank", {
    name: MODEL_NAME,
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
  await invoke(page, "save_file", { path: FILE_PUBLISHER });
  await page.waitForTimeout(600);
  return conn.id;
}

// ===========================================================================

test.describe.serial("§2aa — a subscribed report finds its model again, or fails loudly", () => {
  test.beforeAll(() => {
    if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });
    fs.mkdirSync(REGISTRY, { recursive: true });
  });

  // =========================================================================
  // 1. THE HAPPY PATH — publish, subscribe, save, File > New, reopen
  // =========================================================================
  test("a saved subscriber workbook resolves its package model again on reopen", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);

    await buildPublisherWorkbook(page);
    const published = await invoke<{ packageName: string; version: string }>(page, "calp_publish", {
      params: {
        registryPath: REGISTRY,
        packageName: PACKAGE,
        version: VERSION,
        kind: "report",
        sheetIndices: [],
        publishedBy: "e2e",
        includeComments: false,
      },
    });
    expect(
      published.version,
      "precondition: nothing below means anything if the package was not published",
    ).toBe(VERSION);
    snapshotRegistry();

    // ---- A FRESH document subscribes. File > New has wiped every store, so
    // this is the subscriber's machine as far as the stores are concerned.
    await newFile(page);
    expect(
      await connections(page),
      "the subscriber's blank document must start with no connections at all",
    ).toHaveLength(0);

    await invoke(page, "calp_pull", {
      params: { registryPath: REGISTRY, packageName: PACKAGE, versionPin: VERSION },
    });
    await page.waitForTimeout(2000);

    const afterPull = await connections(page);
    expect(
      afterPull.length,
      "precondition: the PULL itself must create the package connection, or the " +
        "reopen assertion below is about a model that never existed",
    ).toBeGreaterThan(0);
    const pulledPackageConn = afterPull.find((c) => !!c.packageDataSourceId);
    expect(
      pulledPackageConn,
      "the pull produced connections but none of them is a PACKAGE connection",
    ).toBeTruthy();
    const pulledDataSourceId = pulledPackageConn?.packageDataSourceId ?? "";

    // ---- The subscriber saves their workbook, with one cell of their own.
    await setCell(page, SUBSCRIBER_CELL, SUBSCRIBER_VALUE);
    await invoke(page, "save_file", { path: FILE_SUBSCRIBER });
    await expect
      .poll(() => fs.existsSync(FILE_SUBSCRIBER), { timeout: 20_000, intervals: [200] })
      .toBe(true);

    // ---- File > New: everything goes. THIS IS THE NEGATIVE that makes the
    // reopen below a real transition rather than a value that never moved.
    await newFile(page);
    expect(
      await connections(page),
      "File > New left the subscriber's package connection behind",
    ).toHaveLength(0);
    expect(await subscriptions(page), "File > New left the subscription ledger behind").toHaveLength(
      0,
    );

    // =====================================================================
    // THE REOPEN. Measured on the pre-fix build as: connections = 0, and
    // `calp_refresh_data` could not help because refresh only ever UPDATES a
    // connection that already exists.
    // =====================================================================
    await openAt(page, FILE_SUBSCRIBER);

    expect(
      await subscriptions(page),
      "the subscription ledger itself did not come back, so the restore has " +
        "nothing to read and this test is measuring the wrong failure",
    ).toHaveLength(1);

    const reopened = await connections(page);
    expect(
      reopened.length,
      "a reopened subscriber workbook has NO path back to a live model: every BI " +
        "pivot in the report points at ConnectionId::ZERO and Refresh cannot help, " +
        "because refresh only updates a connection that already exists",
    ).toBeGreaterThan(0);

    const restored = reopened.find((c) => c.packageDataSourceId === pulledDataSourceId);
    expect(
      restored,
      `the reopen produced a connection, but not for the data source the PULL ` +
        `resolved (${pulledDataSourceId}). Restore and pull must resolve the same ` +
        `artifact or the subscriber is looking at a different model than they ` +
        `accepted`,
    ).toBeTruthy();

    // ---- AND IT IS NOT SILENT ABOUT SUCCESS EITHER: no skips recorded.
    expect(
      await skips(page),
      "the restore reported a skip on the happy path",
    ).toHaveLength(0);

    // ---- The subscriber's own cell survived, so "it resolved" is not being
    // confused with "it re-pulled and overwrote the document".
    expect(
      await cellDisplay(page, SUBSCRIBER_CELL),
      "the reopened subscriber lost its own cell",
    ).toBe(SUBSCRIBER_VALUE);
  });

  // =========================================================================
  // 2. UNHAPPY: THE PACKAGE VERSION IS GONE
  // =========================================================================
  test("a subscribed package whose version has vanished: no connection, a named skip, and the workbook still opens", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);

    // The registry the subscriber's ledger names loses the version it pinned —
    // the shared folder was tidied, the publisher retired the release, the
    // drive is not synced today.
    const dir = versionDir();
    expect(fs.existsSync(dir), "precondition: the published version must be there to remove").toBe(
      true,
    );
    fs.rmSync(dir, { recursive: true, force: true });

    await newFile(page);
    await openAt(page, FILE_SUBSCRIBER);

    // ---- NO CONNECTION. Not a stale one, not an unverified one — none.
    expect(
      (await connections(page)).filter((c) => !!c.packageDataSourceId),
      "a subscriber whose package cannot be found got a package connection anyway",
    ).toHaveLength(0);

    // ---- AND IT SAID SO. Without this, "this package has no data source" and
    // "this package's model could not be found on this machine" are the same
    // observable state: a pivot quietly reporting no connection.
    const reported = await skips(page);
    expect(
      reported.map((s) => s.packageName),
      "the restore skipped the subscription and reported nothing",
    ).toEqual([PACKAGE]);
    expect(
      reported[0].reason,
      "a missing version must be reported as unreachable, NOT as tampering — the " +
        "two are different problems with different remedies",
    ).toBe("unreachable");
    expect(reported[0].detail, "the skip carries no explanation").not.toBe("");

    // ---- THE WORKBOOK STILL OPENS on the last pull's cells. A failed restore
    // must not cost the subscriber their document.
    expect(
      await cellDisplay(page, SUBSCRIBER_CELL),
      "a subscriber whose package went missing lost their own workbook contents",
    ).toBe(SUBSCRIBER_VALUE);

    // ---- The ledger is intact, so a later reopen can succeed again (test 4).
    expect(
      await subscriptions(page),
      "a failed restore destroyed the subscription ledger",
    ).toHaveLength(1);
  });

  // =========================================================================
  // 3. UNHAPPY: THE MODEL ARTIFACT WAS TAMPERED WITH
  // =========================================================================
  test("a tampered model artifact is refused, with no fallback to the unverified bytes", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);

    restoreRegistry();
    const artifact = modelBlobPath();
    const original = fs.readFileSync(artifact);
    // One appended byte. The file stays syntactically fine and semantically
    // identical; only its CONTENT HASH moves. That is deliberate — the gate
    // under test is the digest in the signed manifest, and it must fire before
    // anything reads the bytes as a model at all.
    fs.writeFileSync(artifact, Buffer.concat([original, Buffer.from("\n")]));
    expect(
      fs.readFileSync(artifact).length,
      "precondition: the artifact must really have changed on disk",
    ).toBeGreaterThan(original.length);

    await newFile(page);
    await openAt(page, FILE_SUBSCRIBER);

    expect(
      (await connections(page)).filter((c) => !!c.packageDataSourceId),
      "a subscriber that cannot prove WHICH model it has was given one anyway — " +
        "this is the exact fallback the .calp integrity machinery exists to refuse",
    ).toHaveLength(0);

    const reported = await skips(page);
    expect(
      reported.map((s) => s.packageName),
      "the tampered package was skipped silently",
    ).toEqual([PACKAGE]);
    expect(
      reported[0].reason,
      "a tampered artifact must be distinguishable from a missing one",
    ).toBe("badManifest");

    expect(
      await cellDisplay(page, SUBSCRIBER_CELL),
      "the refusal cost the subscriber their document",
    ).toBe(SUBSCRIBER_VALUE);
  });

  // =========================================================================
  // 4. THE REGISTRY IS PUT BACK — and the happy path holds again
  // =========================================================================
  test("with the registry repaired the same workbook resolves its model again", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);

    restoreRegistry();
    await newFile(page);
    await openAt(page, FILE_SUBSCRIBER);

    expect(
      (await connections(page)).filter((c) => !!c.packageDataSourceId).length,
      "after the registry was repaired the subscriber still cannot resolve its " +
        "model — the two failures above left something latched",
    ).toBeGreaterThan(0);
    expect(
      await skips(page),
      "a previous run's skip is still being reported after a successful restore",
    ).toHaveLength(0);
  });
});
