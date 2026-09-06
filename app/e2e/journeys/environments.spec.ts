/**
 * ENVIRONMENTS — Dev → Test → Prod against the live app, over a real workspace
 * on disk.
 *
 * WHY A JOURNEY. Every unit tier here is honest about what it can see and none
 * of them can see this: the promotion log is written by one command, verified by
 * another, mirrored into a manifest by a third, and read by a fourth on a
 * different machine's behalf. The failures that matter live in the seams —
 * a listing that claims a promotion the signed log does not carry, a subscriber
 * that resolves an environment as `latest`, a rollback that reads as an update.
 *
 * WHAT IS PROVED, in order, on one workspace:
 *   1. An application with NO pipeline behaves exactly as before.
 *   2. A pipeline can be defined, and defining it moves nobody.
 *   3. A push lands on the LINE and moves no environment.
 *   4. Promotion moves a pointer, is attributed, and COPIES NOTHING — the
 *      version directory's bytes are identical before and after.
 *   5. An environment subscription resolves through the POINTER, so a push
 *      alone offers it no update — the defect a resolver that forgot the
 *      environment branch would produce, and the one `latest` would hide.
 *   6. A rollback is offered as a rollback, backwards, to a version the
 *      environment actually held.
 *   7. Promoting to a version the environment never held, out of pipeline
 *      order, is REFUSED by name.
 *   8. A tampered promotion log fails the whole fold rather than degrading to
 *      "no environments" — the two must not look alike.
 *   9. Subscribing to the LINE on an application that has environments is
 *      refused without `followLine`.
 *
 * THE WORKSPACE IS ON DISK and inspected directly between steps, because "the
 * pointer moved" and "the log says the pointer moved" are different claims and
 * the whole design rests on the second one being the authority.
 *
 * GRID REAL ESTATE. Columns FA..FF (156..161). Every test starts from File > New.
 *
 * LOCALE. sv-SE. No formula here needs a list separator.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef } from "../helpers/grid";

const REPO = path.resolve(process.cwd(), "..");
const WORK = path.join(os.tmpdir(), "calcula-environments");
const REGISTRY = path.join(WORK, "workspace");
const FILE_DEV = path.join(WORK, "dev.cala");
const FILE_SUB = path.join(WORK, "subscriber.cala");

const APP = "environments-report";
const CELL = "FA5";

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

/** Invoke and return the REFUSAL text, failing if the call succeeded. */
async function refusal(page: Page, cmd: string, args: unknown): Promise<string> {
  const outcome = await page.evaluate(
    async ({ c, a }) => {
      const t = (
        window as unknown as {
          __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
        }
      ).__TAURI__;
      try {
        await t.core.invoke(c, a);
        return { ok: true, message: "" };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    { c: cmd, a: args },
  );
  expect(outcome.ok, `${cmd} was expected to refuse but succeeded`).toBe(false);
  return outcome.message;
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

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

interface EnvironmentInfo {
  name: string;
  version: string | null;
  previousVersion: string;
  promotedBy: string;
  promoterKey: string;
  isYou: boolean;
  sequence: number;
  heldVersions: string[];
}

interface EnvironmentsResponse {
  packageName: string;
  headVersion: string;
  environments: EnvironmentInfo[];
  history: Array<{ sequence: number; kind: string; environment: string; version: string }>;
  youMayPromote: boolean;
  writable: boolean;
  problem: string;
}

async function environments(page: Page): Promise<EnvironmentsResponse> {
  return invoke<EnvironmentsResponse>(page, "calp_environments", {
    params: { registryPath: REGISTRY, packageName: APP },
  });
}

async function publish(page: Page, version: string, summary: string): Promise<void> {
  await invoke(page, "calp_publish", {
    params: {
      registryPath: REGISTRY,
      packageName: APP,
      version,
      kind: "report",
      sheetIndices: [],
      publishedBy: "",
      includeComments: false,
      mode: "createNew",
      changeSummary: summary,
    },
  });
  await page.waitForTimeout(400);
}

/** A push to an EXISTING application, which is what the second version onward is. */
async function push(page: Page, version: string, base: string, summary: string): Promise<void> {
  await invoke(page, "calp_publish", {
    params: {
      registryPath: REGISTRY,
      packageName: APP,
      version,
      kind: "report",
      sheetIndices: [],
      publishedBy: "",
      includeComments: false,
      mode: "update",
      expectedBaseVersion: base,
      changeSummary: summary,
    },
  });
  await page.waitForTimeout(400);
}

function logPath(): string {
  return path.join(REGISTRY, APP, "promotions.json");
}

function readLog(): { promotions: Array<{ record: Record<string, unknown>; signature: string }> } {
  return JSON.parse(fs.readFileSync(logPath(), "utf8")) as {
    promotions: Array<{ record: Record<string, unknown>; signature: string }>;
  };
}

/**
 * A stable fingerprint of a published version's bytes on disk.
 *
 * The point of the promotion test: a promotion must change NOTHING here. If it
 * rebuilt or re-signed anything, "what was tested is what ships" would be a
 * claim rather than a fact.
 */
function versionFingerprint(version: string): string {
  const dir = path.join(REGISTRY, APP, version);
  const walk = (d: string): string[] =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? walk(path.join(d, e.name))
          : [`${path.relative(dir, path.join(d, e.name))}:${fs.statSync(path.join(d, e.name)).size}`],
      )
      .sort();
  return walk(dir).join("|");
}

// ===========================================================================

test.describe.serial("environments — one line, named pointers, over a real workspace", () => {
  test.beforeAll(() => {
    if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(REGISTRY, { recursive: true });
  });

  // =========================================================================
  // 1-3. No pipeline is the default; defining one moves nobody; a push lands
  //      on the LINE.
  // =========================================================================
  test("an application starts with no environments, and a push lands on the line", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    await newFile(page);
    await setCell(page, CELL, "V1");
    await invoke(page, "save_file", { path: FILE_DEV });
    await publish(page, "1.0.0", "first");

    // 1. NO ENVIRONMENTS BY DEFAULT. An application that defines none must
    //    behave exactly as it always did — this is the guarantee that lets the
    //    feature ship without touching anybody who has not adopted it.
    let envs = await environments(page);
    expect(envs.environments).toEqual([]);
    expect(envs.headVersion).toBe("1.0.0");
    expect(envs.problem).toBe("");
    expect(envs.youMayPromote).toBe(true);
    expect(fs.existsSync(logPath()), "no pipeline means no log file at all").toBe(false);

    // 2. DEFINE THE PIPELINE. Nothing is promoted by defining it.
    envs = await invoke<EnvironmentsResponse>(page, "calp_set_environments", {
      params: {
        registryPath: REGISTRY,
        packageName: APP,
        environments: ["test", "prod"],
        expectedSequence: 0,
      },
    });
    expect(envs.environments.map((e) => e.name)).toEqual(["test", "prod"]);
    expect(envs.environments.every((e) => e.version === null)).toBe(true);

    // The LOG is the authority, and it is written even for a pipeline edit —
    // otherwise the ordered list would live only in the unsigned mirror.
    const log = readLog();
    expect(log.promotions).toHaveLength(1);
    expect(log.promotions[0].record.sequence).toBe(1);
    expect(log.promotions[0].signature.length).toBeGreaterThan(16);

    // 3. A PUSH MOVES THE LINE, NOT AN ENVIRONMENT. This is the whole point of
    //    separating the two gestures.
    await setCell(page, CELL, "V2");
    await invoke(page, "save_file", { path: FILE_DEV });
    await push(page, "1.1.0", "1.0.0", "second");

    envs = await environments(page);
    expect(envs.headVersion).toBe("1.1.0");
    expect(envs.environments.every((e) => e.version === null)).toBe(true);
  });

  // =========================================================================
  // 4. Promotion moves a pointer and copies nothing.
  // =========================================================================
  test("promotion moves a pointer, is attributed, and copies no bytes", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);

    const before = versionFingerprint("1.1.0");

    const result = await invoke<{
      environment: string;
      from: string | null;
      to: string;
      isRollback: boolean;
      writebackReport: string;
    }>(page, "calp_promote", {
      params: {
        registryPath: REGISTRY,
        packageName: APP,
        environment: "test",
        version: "1.1.0",
        checkCurrent: true,
        expectedCurrent: "",
      },
    });
    expect(result.to).toBe("1.1.0");
    expect(result.from == null || result.from === "").toBe(true);
    expect(result.isRollback).toBe(false);
    // No writeback regions in this application, so the report is empty rather
    // than a sentence about a feature it does not use.
    expect(result.writebackReport).toBe("");

    // NOTHING WAS COPIED. A promotion that rebuilt or re-signed anything would
    // break "what was tested is bit-for-bit what ships".
    expect(versionFingerprint("1.1.0")).toBe(before);

    // ATTRIBUTED, and by KEY — the display name is not what is verified.
    const envs = await environments(page);
    const test0 = envs.environments.find((e) => e.name === "test")!;
    expect(test0.version).toBe("1.1.0");
    expect(test0.isYou).toBe(true);
    expect(test0.promoterKey.length).toBeGreaterThan(16);

    // The mirror agrees with the log, and the LOG is what says so.
    const log = readLog();
    expect(log.promotions).toHaveLength(2);
    expect(log.promotions[1].record.sequence).toBe(2);
  });

  // =========================================================================
  // 5. An environment subscription follows the POINTER.
  // =========================================================================
  test("an environment subscription moves only when the pointer moves", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);

    await newFile(page);
    // A pull ADDS the application's sheets beside the workbook's own, so the
    // active sheet is still the blank one File > New made. The real dialog
    // lands the user on the pulled report using the index the BACKEND reports
    // — never list arithmetic, which names the wrong sheet whenever an
    // object-backed sheet is present.
    const pulled = await invoke<{ firstPulledSheetIndex?: number | null }>(page, "calp_pull", {
      params: {
        registryPath: REGISTRY,
        packageName: APP,
        versionPin: "",
        environment: "test",
        followLine: false,
      },
    });
    await page.waitForTimeout(600);
    expect(pulled.firstPulledSheetIndex ?? null).not.toBeNull();
    await invoke(page, "set_active_sheet", { index: pulled.firstPulledSheetIndex });
    await page.waitForTimeout(400);

    const subs = await invoke<{
      subscriptions: Array<{ packageName: string; versionPin: string; environment: string | null; resolvedVersion: string }>;
    }>(page, "calp_get_subscriptions", {});
    const sub = subs.subscriptions.find((s) => s.packageName === APP)!;
    expect(sub.environment).toBe("test");
    expect(sub.resolvedVersion).toBe("1.1.0");
    // THE EMPTY PIN IS DELIBERATE. `VersionPin::parse("")` errs, so a resolver
    // that forgot the environment branch fails loudly instead of quietly
    // reporting "up to date" forever.
    expect(sub.versionPin).toBe("");
    expect(await cellDisplay(page, CELL)).toBe("V2");

    await invoke(page, "save_file", { path: FILE_SUB });

    // A PUSH ALONE OFFERS NOTHING. This is the defect `latest` produced and the
    // reason the feature exists: unreleased work must not reach this subscriber.
    await openAt(page, FILE_DEV);
    await setCell(page, CELL, "V3");
    await invoke(page, "save_file", { path: FILE_DEV });
    await push(page, "1.2.0", "1.1.0", "third");

    await openAt(page, FILE_SUB);
    let preview = await invoke<{ subscriptionPreviews: Array<{ packageName: string; newVersion: string }> }>(
      page,
      "calp_refresh_preview",
      {},
    );
    expect(
      preview.subscriptionPreviews.filter((p) => p.packageName === APP),
      "a push must not offer an update to an environment subscriber",
    ).toHaveLength(0);

    // PROMOTE, and the same subscriber is offered it.
    await invoke(page, "calp_promote", {
      params: {
        registryPath: REGISTRY,
        packageName: APP,
        environment: "test",
        version: "1.2.0",
        checkCurrent: true,
        expectedCurrent: "1.1.0",
      },
    });

    preview = await invoke(page, "calp_refresh_preview", {});
    const row = preview.subscriptionPreviews.find((p) => p.packageName === APP);
    expect(row, "promoting must offer the environment subscriber an update").toBeTruthy();
    expect(row!.newVersion).toBe("1.2.0");

    // APPLY IT, and save. The next test rolls test BACK, and a rollback is only
    // observable from a subscriber that actually moved forward first — leaving
    // this one on 1.1.0 would make the rollback a no-op that looks like a pass.
    await invoke(page, "calp_refresh_apply", { params: null });
    await page.waitForTimeout(800);
    await invoke(page, "save_file", { path: FILE_SUB });
    await page.waitForTimeout(400);
  });

  // =========================================================================
  // 6. A rollback goes backwards, and says so.
  // =========================================================================
  test("a rollback is offered as a rollback, to a version the environment held", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);

    // test has held 1.1.0 and 1.2.0, so 1.1.0 is a legitimate rollback target.
    const envsBefore = await environments(page);
    const t = envsBefore.environments.find((e) => e.name === "test")!;
    expect(t.heldVersions, "the rollback candidates come from the SIGNED log").toContain("1.1.0");

    const result = await invoke<{ isRollback: boolean; from: string | null; to: string }>(
      page,
      "calp_promote",
      {
        params: {
          registryPath: REGISTRY,
          packageName: APP,
          environment: "test",
          version: "1.1.0",
          checkCurrent: true,
          expectedCurrent: "1.2.0",
        },
      },
    );
    expect(result.isRollback, "going backwards must be reported as a rollback").toBe(true);
    expect(result.from).toBe("1.2.0");
    expect(result.to).toBe("1.1.0");

    // AND THE SUBSCRIBER IS TOLD. A downgrade read as an update is a subscriber
    // concluding the publisher changed those cells.
    await openAt(page, FILE_SUB);
    const preview = await invoke<{
      subscriptionPreviews: Array<{ packageName: string; newVersion: string; isRollback: boolean }>;
    }>(page, "calp_refresh_preview", {});
    const row = preview.subscriptionPreviews.find((p) => p.packageName === APP);
    expect(row).toBeTruthy();
    expect(row!.newVersion).toBe("1.1.0");
    expect(row!.isRollback, "the refresh preview must say it is going backwards").toBe(true);
  });

  // =========================================================================
  // 7. Out-of-order promotion is refused by name.
  // =========================================================================
  test("promoting prod past test, or to a version it never held, is refused", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);

    // prod is empty and test holds 1.1.0. Promoting prod to the LINE HEAD
    // (1.2.0) skips the pipeline: prod may only take what test currently holds.
    const message = await refusal(page, "calp_promote", {
      params: {
        registryPath: REGISTRY,
        packageName: APP,
        environment: "prod",
        version: "1.2.0",
        checkCurrent: true,
        expectedCurrent: "",
      },
    });
    expect(message).toMatch(/1\.1\.0/);

    // What IS allowed is exactly what test holds.
    const ok = await invoke<{ to: string }>(page, "calp_promote", {
      params: {
        registryPath: REGISTRY,
        packageName: APP,
        environment: "prod",
        version: "1.1.0",
        checkCurrent: true,
        expectedCurrent: "",
      },
    });
    expect(ok.to).toBe("1.1.0");

    // AND A STALE POINTER IS REFUSED. `expectedCurrent` is what the dialog
    // showed; a colleague's promotion between render and click must not be
    // promoted over.
    const stale = await refusal(page, "calp_promote", {
      params: {
        registryPath: REGISTRY,
        packageName: APP,
        environment: "prod",
        version: "1.2.0",
        checkCurrent: true,
        expectedCurrent: "",
      },
    });
    expect(stale.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // 8. A tampered log fails the fold — it does not degrade to "no pipeline".
  // =========================================================================
  test("a tampered promotion log is a problem, not an absent pipeline", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);

    const original = fs.readFileSync(logPath(), "utf8");
    const log = JSON.parse(original) as {
      promotions: Array<{ record: { event?: Record<string, unknown> }; signature: string }>;
    };
    // Retarget the last promotion at the line head, leaving its signature.
    const last = log.promotions[log.promotions.length - 1];
    expect(last.record.event, "the fixture must actually change a promotion").toBeTruthy();
    (last.record.event as Record<string, unknown>).version = "1.2.0";
    fs.writeFileSync(logPath(), JSON.stringify(log, null, 2));

    try {
      const envs = await environments(page);
      // THE TWO MUST NOT LOOK ALIKE. "No environments" is a normal state; "this
      // log did not verify" is a workspace somebody may have tampered with, and
      // reading the second as the first would invite an admin to define a fresh
      // pipeline over it.
      expect(envs.problem, "a tampered log must be reported as a problem").not.toBe("");
      expect(envs.environments).toEqual([]);
    } finally {
      fs.writeFileSync(logPath(), original);
    }

    // Restored: the pipeline is back, and the retarget did not stick.
    const after = await environments(page);
    expect(after.problem).toBe("");
    expect(after.environments.find((e) => e.name === "prod")!.version).toBe("1.1.0");
  });

  // =========================================================================
  // 8b. THE REVIEW'S FIXES, live. Each was a confirmed finding.
  // =========================================================================
  test("an unreadable promotion log refuses the subscribe instead of admitting it", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    await newFile(page);

    // The gate used to read the pipeline with `unwrap_or_default()`, so a log
    // it could not trust collapsed into "no environments" and a bare-pin
    // subscribe was admitted onto the development line with no refusal and no
    // notice — the one outcome the gate exists to prevent.
    const original = fs.readFileSync(logPath(), "utf8");
    fs.writeFileSync(logPath(), original.replace(/"sequence": 2/, '"sequence": 7'));
    try {
      const message = await refusal(page, "calp_pull", {
        params: {
          registryPath: REGISTRY,
          packageName: APP,
          versionPin: "latest",
          environment: null,
          followLine: false,
        },
      });
      expect(message).toMatch(/CALP_PULL_ENVIRONMENT_UNKNOWN/);
    } finally {
      fs.writeFileSync(logPath(), original);
    }
  });

  test("a promotion that moves an environment backwards reports itself as a rollback", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);

    // prod is at 1.1.0 and test at 1.1.0. Roll TEST back to 1.0.0, then promote
    // test into prod: that second step moves prod BACKWARDS through the ordinary
    // promote path, which the dialog used to present as a plain promotion.
    await invoke(page, "calp_promote", {
      params: {
        registryPath: REGISTRY,
        packageName: APP,
        environment: "test",
        version: "1.0.0",
        checkCurrent: false,
        expectedCurrent: "",
      },
    });
    const back = await invoke<{ isRollback: boolean; from: string | null; to: string }>(
      page,
      "calp_promote",
      {
        params: {
          registryPath: REGISTRY,
          packageName: APP,
          environment: "prod",
          version: "1.0.0",
          checkCurrent: false,
          expectedCurrent: "",
        },
      },
    );
    expect(back.isRollback, "a backwards move through PROMOTE is still a rollback").toBe(
      true,
    );
    expect(back.to).toBe("1.0.0");
  });

  test("an HTTP workspace can read the promotion log at all", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    // `HttpWorkspace` inherited the trait default `Ok(None)` for application-root
    // files, so environments were inert over HTTP and the follow-line gate could
    // not fire. There is no HTTP server in this journey, so this asserts the
    // implementation exists rather than its behaviour over the wire — the unit
    // tier cannot see it either, because the default silently answered.
    const src = fs.readFileSync(
      path.join(REPO, "app/src-tauri/src/calp_registry.rs"),
      "utf8",
    );
    const impl = src.slice(src.indexOf("impl WorkspaceTransport for HttpWorkspace"));
    expect(impl).toContain("fn read_application_artifact(");
    expect(impl).toContain("check_rel_path");
  });

  // =========================================================================
  // 9. Following the LINE on an application with environments is deliberate.
  // =========================================================================
  test("subscribing to the development line needs followLine, and says what is on offer", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    await newFile(page);

    const message = await refusal(page, "calp_pull", {
      params: {
        registryPath: REGISTRY,
        packageName: APP,
        versionPin: "latest",
        environment: null,
        followLine: false,
      },
    });
    // The refusal has to NAME the environments, or it is a dead end.
    expect(message).toMatch(/test/);
    expect(message).toMatch(/prod/);

    // Both targets at once is refused too — a pin beside an environment is two
    // claims about what to follow, and one of them would silently win.
    const ambiguous = await refusal(page, "calp_pull", {
      params: {
        registryPath: REGISTRY,
        packageName: APP,
        versionPin: "latest",
        environment: "prod",
        followLine: false,
      },
    });
    expect(ambiguous.length).toBeGreaterThan(0);

    // POSITIVE CONTROL. Saying it deliberately works, and lands on the head —
    // without this, a refusal test passes just as happily against a pull that
    // is broken outright.
    await invoke(page, "calp_pull", {
      params: {
        registryPath: REGISTRY,
        packageName: APP,
        versionPin: "latest",
        environment: null,
        followLine: true,
      },
    });
    await page.waitForTimeout(600);
    const subs = await invoke<{
      subscriptions: Array<{ packageName: string; environment: string | null; resolvedVersion: string }>;
    }>(page, "calp_get_subscriptions", {});
    const sub = subs.subscriptions.find((s) => s.packageName === APP)!;
    expect(sub.environment == null || sub.environment === "").toBe(true);
    expect(sub.resolvedVersion, "the line's head, not prod's pointer").toBe("1.2.0");
  });
});
