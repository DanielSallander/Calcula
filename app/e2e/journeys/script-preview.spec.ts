/**
 * THE FAITHFUL DRY RUN, IN A REAL WORKER REALM.
 *
 * WHAT THIS CLOSES. `ai_dry_run_script` executes a candidate in the Rust
 * QuickJS realm, which rejects `export` outright and shares a small fraction of
 * the Worker realm's `context`. It therefore DECLINED every object script —
 * correctly, because anything it said would have described the emulator rather
 * than the draft — and L3 was consequently dead for the only surface the AI
 * actually drafts for. `previewObjectScript` runs the draft in the realm it will
 * really be mounted into, against a copy of the workbook.
 *
 * WHY THIS TIER, AND ONLY THIS TIER. `spawnWorker()` needs `Worker` AND
 * `window`; the unit tier is jsdom, which has neither, and jsdom cannot import
 * a blob module even with a shim. So every unit test of this rung is either
 * about the pure halves (the backend, the snapshot, the report) or is a
 * source-reading guard. NOTHING below this file has ever executed a script in
 * the realm this feature is about. That is the gap this spec exists to fill,
 * and it is why the discriminating case below matters so much.
 *
 * THE DISCRIMINATING CASE. `context.expose('onClick', handler)` MOUNTS CLEANLY
 * AND NEVER FIRES — a click reaches only handlers registered with
 * `context.onClick(handler)`. That defect shipped in every button reference,
 * both prompts and the assisted template, and no static check can see it. A
 * preview that reported the two shapes identically would be an emulator wearing
 * the realm's clothes; the pair below is what proves it is not.
 *
 * THE INVARIANT, ASSERTED RATHER THAN ASSUMED. A preview must not touch the
 * document. Each writing test therefore checks the REAL cell afterwards, and the
 * suite checks that the workbook never became dirty and that the audit ring
 * gained no rows — the three ways a "preview" would betray itself as an edit.
 *
 * VACUOUS-PASS DISCIPLINE. "The preview reported 1 change" is paired with "the
 * real cell still holds its old value", and the dead-shape case is paired with
 * its live twin — otherwise both would pass on a build where the realm never
 * ran anything at all. The first test proves a script RUNS before any later test
 * concludes anything from one not running.
 *
 * GRID REAL ESTATE. DP1..DP3, away from anything other journeys use.
 *
 * LOCALE. sv-SE. No list separators are needed by any source here.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

/** The cell every draft below writes to. */
const TARGET = { row: 0, col: 119 }; // DP1
const TARGET_REF = "DP1";
const SEED = "seed-value";

interface DryRunReport {
  ok: boolean;
  error: string | null;
  changes: Array<{ row: number; col: number; before: string; after: string }>;
  totalChanges: number;
  output: string[];
  readBack: Array<{ row: number; col: number; value: string }>;
  /** Handlers the script registered that the preview declined to fire. */
  unexercisedHooks: string[];
  applicable: boolean;
  declinedReason: string | null;
}

/**
 * Run one source through the real preview, in the page.
 *
 * `page.evaluate` has NO default timeout, so the app-side deadline is the only
 * one there is — the preview's own 5s setup / 5s event budgets. A hung realm
 * therefore surfaces as a resolved report with an error, not as a wedged test.
 */
async function preview(page: Page, source: string, event?: string): Promise<DryRunReport> {
  return page.evaluate(
    async ({ source, event, readBack }) => {
      const mod = (await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL("/src/api/scriptHost/scriptPreview/index.ts", document.baseURI).href)) as {
        previewObjectScript: (req: unknown) => Promise<unknown>;
      };
      return (await mod.previewObjectScript({
        source,
        objectType: "button",
        event,
        readBack,
      })) as unknown;
    },
    { source, event, readBack: [TARGET] },
  ) as Promise<DryRunReport>;
}

/** How many rows the broker's in-memory audit ring holds right now. */
async function auditTotal(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const mod = (await (
      window as unknown as { __calcImport: (u: string) => Promise<unknown> }
    ).__calcImport(new URL("/src/api/scriptHost/auditRing.ts", document.baseURI).href)) as {
      getAuditTotal: () => number;
    };
    return mod.getAuditTotal();
  });
}

const WRITES = `export function setup(context) {
  context.onClick(() => {
    context.api.setCellValue(${TARGET.row}, ${TARGET.col}, "written-by-preview");
  });
}
`;

/** The dead shape: mounts perfectly, never receives a click. */
const EXPOSED_INSTEAD = `export function setup(context) {
  context.expose("onClick", () => {
    context.api.setCellValue(${TARGET.row}, ${TARGET.col}, "written-by-preview");
  });
}
`;

test.describe("the faithful Worker-realm dry run", () => {
  test.beforeEach(async ({ grid }) => {
    await grid.setCellValue(TARGET_REF, SEED);
    await expect
      .poll(() => grid.getCellDisplayValue(TARGET_REF), { timeout: 5000 })
      .toBe(SEED);
  });

  test("runs an object script for real, and reports what it WOULD change", async ({ grid }) => {
    const page = grid.page;
    const before = await auditTotal(page);

    const report = await preview(page, WRITES, "onClick");

    // It ran. Everything after this depends on that being true, so it is
    // asserted first and with the reason attached.
    expect(report.applicable, `declined: ${report.declinedReason}`).toBe(true);
    expect(report.ok, `failed: ${report.error}`).toBe(true);
    expect(report.totalChanges).toBe(1);
    expect(report.changes[0]).toMatchObject({
      row: TARGET.row,
      col: TARGET.col,
      before: SEED,
      after: "written-by-preview",
    });
    // readBack reports the VALUE, which the diff alone cannot: a cell rewritten
    // with what it already held is absent from `changes`.
    expect(report.readBack[0]).toMatchObject({ value: "written-by-preview" });

    // THE INVARIANT. The workbook is untouched.
    expect(await grid.getCellDisplayValue(TARGET_REF)).toBe(SEED);
    // And no row was written about a script the user never mounted.
    expect(await auditTotal(page)).toBe(before);
  });

  test("the exposed-onClick shape mounts and never fires — and the preview says so", async ({ grid }) => {
    const page = grid.page;

    // Its live twin is the control: identical work, registered the working way.
    const live = await preview(page, WRITES, "onClick");
    expect(live.applicable && live.ok, "precondition: the live shape works").toBe(true);
    expect(live.totalChanges).toBe(1);

    const dead = await preview(page, EXPOSED_INSTEAD, "onClick");
    expect(dead.applicable, `declined: ${dead.declinedReason}`).toBe(true);
    // The product diagnoses this as "never registered a click handler"; the
    // preview must reach the same conclusion rather than firing the exposed
    // method as a fallback, which would grade a dead script as working.
    expect(dead.ok).toBe(false);
    expect(dead.error).toMatch(/never registers the "onClick" hook/);
    expect(dead.totalChanges).toBe(0);

    expect(await grid.getCellDisplayValue(TARGET_REF)).toBe(SEED);
  });

  test("reports a genuine runtime error — the capability the old rung never had", async ({ grid }) => {
    const page = grid.page;
    // L0-L2 are blind to this: it parses, invents no member and declares
    // nothing it does not use. It simply throws on its first line.
    const report = await preview(
      page,
      `export function setup(context) {
  const rows = null;
  context.api.setCellValue(0, 0, rows.length);
}
`,
    );
    expect(report.applicable, `declined: ${report.declinedReason}`).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.error ?? "").toMatch(/null|undefined|TypeError/i);
  });

  test("never reaches the network, and DECLINES rather than faking a response", async ({ grid }) => {
    const page = grid.page;
    // Two facts at once, and the second is the interesting one.
    //
    // SAFETY: the preview handle declares nothing, so the R19 ceiling — checked
    // BEFORE any grant — refuses this without a prompt, without a grant, and
    // without the Rust gate ever being consulted. The URL is `.invalid`, a
    // reserved TLD, so a regression that DID reach the network fails loudly
    // rather than quietly contacting someone.
    //
    // HONESTY: the refusal is then reported as a DECLINE, not as the script's
    // defect. The draft declared `net.fetch` correctly and L2 already checked
    // that; what a preview cannot do is know what the endpoint would return.
    // Answering from a canned stub would be worse than saying nothing — a
    // script parsing `{}` as an exchange rate would throw, and the preview
    // would report ITS OWN stub as the draft's runtime error.
    const report = await preview(
      page,
      `// @capability net.fetch
export function setup(context) {
  context.onClick(async () => {
    const r = await context.caps.fetch("https://example.invalid/x");
    context.log("fetched " + r.status);
  });
}
`,
      "onClick",
    );
    expect(report.applicable).toBe(false);
    expect(report.declinedReason ?? "").toContain("net.fetch");
    expect(report.ok, "a decline is not a failure").toBe(true);
    expect(report.output.join(" "), "nothing was fetched").not.toContain("fetched");
  });

  test("sees the workbook's real data, including a formula's computed value", async ({ grid }) => {
    const page = grid.page;
    await grid.setCellValue("DP2", "17");
    await grid.setCellValue("DP3", "=DP2*2");
    await expect.poll(() => grid.getCellDisplayValue("DP3"), { timeout: 5000 }).toBe("34");

    const report = await preview(
      page,
      `export async function setup(context) {
  context.log("DP2=" + (await context.api.getCellValue(1, 119)));
  context.log("DP3=" + (await context.api.getCellValue(2, 119)));
  context.log("formula=" + (await context.api.getCellFormula(2, 119)));
}
`,
    );
    expect(report.applicable, `declined: ${report.declinedReason}`).toBe(true);
    expect(report.ok, `failed: ${report.error}`).toBe(true);
    const output = report.output.join("\n");
    // The copy is of the REAL sheet, not an empty one — this is what "a grid
    // backend a preview has no document for" was asking for.
    expect(output).toContain("DP2=17");
    // A formula cell carries the value the workbook already computed. Nothing
    // in the preview evaluates; this number came from the snapshot.
    expect(output).toContain("DP3=34");
    expect(output).toContain("formula==DP2*2");
  });

  test("catches a handler that throws AFTER an await — the round-trip case", async ({ grid }) => {
    const page = grid.page;
    // THE CASE THAT NEEDS THE POST-DRAIN FLUSH, and the reason it exists.
    //
    // The handler issues a call, awaits it, and only then throws. Sequence:
    // the host settles the call and `inFlight` drops to zero — but the WORKER
    // has not seen the result yet. It processes the `callResult` afterwards,
    // the continuation runs, it throws, and only then is `{t:"error"}` posted.
    // A host that stopped at "nothing in flight" would already have finished
    // and reported this as a clean run that changed nothing — the single most
    // misleading verdict this ladder can produce, delivered for a script that
    // is genuinely broken.
    //
    // Nothing else in this file probes it: a REFUSED call and a backend GAP are
    // both recorded host-side, so they need no round trip at all.
    const report = await preview(
      page,
      `export function setup(context) {
  context.onClick(async () => {
    const v = await context.api.getCellValue(${TARGET.row}, ${TARGET.col});
    context.api.setCellValue(1, ${TARGET.col}, v.thisMethodDoesNotExist());
  });
}
`,
      "onClick",
    );
    expect(report.applicable, `declined: ${report.declinedReason}`).toBe(true);
    expect(report.ok, "the handler threw; a clean verdict here would be a lie").toBe(false);
    expect(report.error ?? "").toMatch(/thisMethodDoesNotExist|not a function/i);
  });

  test("computes the value of a formula the SCRIPT wrote", async ({ grid }) => {
    const page = grid.page;
    // The limit this closes. A preview grid holds formula TEXT and nothing that
    // can evaluate it, so a script that wrote `=SUM(...)` and read the cell back
    // saw an empty display — and any dependent of a cell the script changed kept
    // its pre-run value. Neither is something TypeScript can fix: the formula
    // language lives in Rust, and a second evaluator here would be one that
    // disagrees with the workbook.
    //
    // The values are computed by `preview_evaluate_formulas`, which is PURE over
    // the cells handed to it — no AppState, no document, no writes.
    await grid.setCellValue("DP2", "20");
    await grid.setCellValue("DP3", "22");

    const report = await preview(
      page,
      `export function setup(context) {
  context.onClick(async () => {
    context.api.setCellFormula(3, 119, "=SUM(DP2:DP3)");
    context.log("total=" + (await context.api.getCellValue(3, 119)));
  });
}
`,
      "onClick",
    );
    expect(report.applicable, `declined: ${report.declinedReason}`).toBe(true);
    expect(report.ok, `failed: ${report.error}`).toBe(true);
    // The formula TEXT is what the diff reports — the grading vocabulary.
    expect(report.changes.find((c) => c.row === 3)?.after).toBe("=SUM(DP2:DP3)");

    // ...and the VALUE is now observable. Fired a second time so the read lands
    // after a settle point: the product recalculates as part of the write, this
    // recalculates between phases, and §5c states that difference rather than
    // hiding it.
    const second = await preview(
      page,
      `export function setup(context) {
  context.api.setCellFormula(3, 119, "=SUM(DP2:DP3)");
  context.onClick(async () => {
    context.log("total=" + (await context.api.getCellValue(3, 119)));
  });
}
`,
      "onClick",
    );
    expect(second.applicable, `declined: ${second.declinedReason}`).toBe(true);
    expect(second.ok, `failed: ${second.error}`).toBe(true);
    expect(second.output.join("\n"), "42 = 20 + 22, computed by the real evaluator").toContain("total=42");

    // And the workbook itself never saw any of it.
    expect(await grid.getCellDisplayValue("DP4")).toBe("");
  });

  test("a script that only reads changes nothing, and that is not an error", async ({ grid }) => {
    const page = grid.page;
    const report = await preview(
      page,
      `export async function setup(context) {
  context.log("read: " + (await context.api.getCellValue(${TARGET.row}, ${TARGET.col})));
}
`,
    );
    expect(report.applicable, `declined: ${report.declinedReason}`).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.totalChanges).toBe(0);
    expect(report.output.join("\n")).toContain(`read: ${SEED}`);
  });

  test("waits for a handler that sleeps between calls — its tail write is COUNTED", async ({ grid }) => {
    const page = grid.page;
    // §5c.1 C9. `await sleep(100)` suspends the handler with NO broker call in
    // flight, so quiescence-by-calls declared the realm idle and the tail write
    // was silently missing from the diff — "changed nothing" about a correct
    // script. The pong now carries the realm's live-timer count and the settle
    // loop waits for it to reach zero.
    const report = await preview(
      page,
      `export function setup(context) {
  context.onClick(async () => {
    const v = await context.api.getCellValue(${TARGET.row}, ${TARGET.col});
    await new Promise((r) => setTimeout(r, 120));
    context.api.setCellValue(1, ${TARGET.col}, "tail:" + v);
  });
}
`,
      "onClick",
    );
    expect(report.applicable, `declined: ${report.declinedReason}`).toBe(true);
    expect(report.ok, `failed: ${report.error}`).toBe(true);
    expect(report.totalChanges, "the write AFTER the sleep is part of the run").toBe(1);
    expect(report.changes[0]).toMatchObject({ row: 1, col: TARGET.col, after: `tail:${SEED}` });
  });

  test("attributes a throw that lands AFTER the settle to the hook that threw", async ({ grid }) => {
    const page = grid.page;
    // §5c.1 C8. The rejection surfaces only when the timer fires — after the
    // drain went quiet. Unchecked after onSettle, it was either blamed on the
    // NEXT hook or dropped entirely, grading a throwing script as a clean run.
    const report = await preview(
      page,
      `export function setup(context) {
  context.onClick(async () => {
    await new Promise((r) => setTimeout(r, 80));
    throw new Error("boom-after-timer");
  });
}
`,
      "onClick",
    );
    expect(report.applicable, `declined: ${report.declinedReason}`).toBe(true);
    expect(report.ok, "a throwing handler must never grade as a clean run").toBe(false);
    expect(report.error ?? "").toContain("boom-after-timer");
    expect(report.error ?? "").toContain("onClick");
  });

  test("SKIPS a hook whose payload it cannot synthesize — and says so — instead of firing undefined at it", async ({ grid }) => {
    const page = grid.page;
    // §5c.1 A1. The product delivers {startRow, ..., areas} to onSelectionChange;
    // the preview cannot synthesize that, and firing the handler with undefined
    // made this CORRECT destructuring draft throw -> "FAILS when run" -> false
    // rejection. Offered opportunistically (no explicit event), the hook is now
    // skipped with a note; the click handler still runs and is judged.
    const report = await page.evaluate(
      async ({ source }) => {
        const mod = (await (
          window as unknown as { __calcImport: (u: string) => Promise<unknown> }
        ).__calcImport(new URL("/src/api/scriptHost/scriptPreview/index.ts", document.baseURI).href)) as {
          previewObjectScript: (req: unknown) => Promise<unknown>;
        };
        return (await mod.previewObjectScript({ source, objectType: "sheet" })) as unknown;
      },
      {
        source: `export function setup(context) {
  context.onSelectionChange(({ startRow, startCol }) => {
    context.log("moved to", startRow, startCol);
  });
}
`,
      },
    ) as DryRunReport;
    expect(report.applicable, `declined: ${report.declinedReason}`).toBe(true);
    expect(report.ok, `a correct handler must not be fired with a guessed payload: ${report.error}`).toBe(true);
    expect(report.output.join("\n")).toContain("onSelectionChange handler was registered but not exercised");
    // The same fact AS A FIELD, not only as prose. Three surfaces have to act on
    // it, and this is the only tier with a real Worker realm to prove it arrives.
    expect(report.unexercisedHooks).toEqual(["onSelectionChange"]);
  });

  test("serves the mirrors it seeded and DECLINES the ones it cannot", async ({ grid }) => {
    const page = grid.page;
    // §5c.1 D. Every preview used to mount with EMPTY mirror seeds, so
    // context.properties.sheetCount read a fabricated 0 with no broker call —
    // a wrong answer the gap discipline could not see. Known facts are now
    // seeded; everything else gaps.
    const run = (source: string) =>
      page.evaluate(
        async ({ source }) => {
          const mod = (await (
            window as unknown as { __calcImport: (u: string) => Promise<unknown> }
          ).__calcImport(new URL("/src/api/scriptHost/scriptPreview/index.ts", document.baseURI).href)) as {
            previewObjectScript: (req: unknown) => Promise<unknown>;
          };
          return (await mod.previewObjectScript({ source, objectType: "workbook" })) as unknown;
        },
        { source },
      ) as Promise<DryRunReport>;

    const seeded = await run(`export function setup(context) {
  context.log("sheets=" + context.properties.sheetCount);
}
`);
    expect(seeded.applicable, `declined: ${seeded.declinedReason}`).toBe(true);
    expect(seeded.ok, `failed: ${seeded.error}`).toBe(true);
    // The REAL count, not the placeholder 0 the fallback used to fabricate.
    expect(seeded.output.join("\n")).toMatch(/sheets=[1-9]/);

    const unseeded = await run(`export function setup(context) {
  context.log("title=" + context.properties.title);
}
`);
    expect(unseeded.applicable, "an unseeded mirror read is a gap, not an answer").toBe(false);
    expect(unseeded.declinedReason ?? "").toContain("workbook.title");
    expect(unseeded.ok, "a decline is not a failure").toBe(true);
  });

  test("DECLINES rather than judging when the backend cannot serve a member", async ({ grid }) => {
    const page = grid.page;
    // The gap discipline, end to end. `api.setActiveSheet` is a real member the
    // preview cannot model — it holds ONE sheet's copy, and switching sheets is
    // exactly the state it has none of. So the run is evidence about the
    // backend, and no conclusion may be drawn from it.
    //
    // The call is deliberately NOT awaited: the gap must be recorded because
    // the preview could not serve it, not because the script noticed.
    const report = await preview(
      page,
      `export function setup(context) {
  context.onClick(() => {
    context.api.setActiveSheet(0);
  });
}
`,
      "onClick",
    );
    expect(report.applicable).toBe(false);
    expect(report.declinedReason ?? "").toContain("api.setActiveSheet");
    // A decline must not read as a failure OR as a clean bill of health.
    expect(report.ok, "a caller reading only `ok` sees no objection").toBe(true);
    expect(report.error).toBeNull();
  });

  test("leaves the document clean — a preview is not an edit", async ({ grid }) => {
    const page = grid.page;
    // Save first so the workbook is definitively clean, then preview a writer
    // and confirm nothing dirtied it. `is_modified` gates BOTH the
    // close-without-saving prompt and AutoRecover, so a preview that set it
    // would cost the user a spurious prompt at best.
    const dirtyBefore = await page.evaluate(async () => {
      const mod = (await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL("/src/api/backend.ts", document.baseURI).href)) as {
        invokeBackend: <T>(c: string, a?: unknown) => Promise<T>;
      };
      return mod.invokeBackend<boolean>("is_file_modified");
    });

    await preview(page, WRITES, "onClick");

    const dirtyAfter = await page.evaluate(async () => {
      const mod = (await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL("/src/api/backend.ts", document.baseURI).href)) as {
        invokeBackend: <T>(c: string, a?: unknown) => Promise<T>;
      };
      return mod.invokeBackend<boolean>("is_file_modified");
    });

    expect(dirtyAfter, "the preview must not dirty the document").toBe(dirtyBefore);
    expect(await grid.getCellDisplayValue(TARGET_REF)).toBe(SEED);
  });
});

// ===========================================================================
// "Preview form" — the same dry run, PAINTED
// ===========================================================================
/**
 * WHAT THIS ADDS. Everything above judges a preview by its REPORT. A `form`
 * script's report is a layout, and a layout is only checkable by drawing it:
 * the editor's "Preview form" action runs the code ON SCREEN through the same
 * `previewObjectScript` rung and paints the captured `form.define` layout in
 * the real trusted renderer — labelled as a preview, seeded from the copy the
 * run used, and with Submit turned into a "what would be written" list instead
 * of a write.
 *
 * WHY THE IN-APP EDITOR AND NOT THE EDITOR WINDOW. There are two hosts for the
 * same action and they share the same testid: `CodeEditorDialog` (main window,
 * dialog id `scriptable-objects.code-editor`) calls `runFormPreview` directly,
 * and `ObjectScriptEditorApp` (a separate Tauri window) sends the compiled
 * buffer over `formPreviewBridge`'s Tauri event channel to the SAME function in
 * the main window. Both ends of that bridge are covered by unit tests; what
 * only a journey can prove is that the run really produces a painted, inert
 * form. The main-window host is therefore the one driven here — it exercises
 * the identical `runFormPreview`, with one window instead of two.
 *
 * THE FOUR THINGS A PREVIEW MUST NOT DO, asserted rather than assumed: it must
 * not mount the script, must not write the cell it is bound to, must not dirty
 * the document, and must not put a row in the audit ring (the preview handle is
 * `preview: true`, and `broker.ts`'s `audit()` returns early for it). A
 * "preview" that failed any of those would be an edit wearing a label.
 *
 * GRID REAL ESTATE. DR123 (0-based row 122, col 121) — inside the DP..DR /
 * rows 122..128 band the Forms feature owns, and distinct from DP1..DP4 above
 * and from every cell script-form.spec.ts / script-form-distributed.spec.ts use.
 */

/** The `@api` facade — the same module every extension imports. */
const FORM_API = "/src/api/index.ts";
/** The in-app Object Script Editor. */
const EDITOR_DIALOG_ID = "scriptable-objects.code-editor";

const FORM_CELL_REF = "DR123";
/** 0-based, and the number the snapshot-bound precondition below is checked against. */
const FORM_CELL_ROW = 122;
const FORM_CELL_SEED = "Seeded Co";
const FORM_SCRIPT_ID = `preview-form-${Date.now().toString(36)}`;
const FORM_SCRIPT_NAME = "Preview Form Under Test";

/* eslint-disable @typescript-eslint/naming-convention --
 * `__calcImport` is installed by main.tsx and `__formAppImport` is this block's
 * own page-side global; the double-underscore is the harness convention. */
type FormAppWindow = Window & {
  __calcImport: (url: string) => Promise<unknown>;
  __formAppImport?: (modulePath: string) => Promise<unknown>;
};
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Import `@api` at the URL the RUNNING app loaded it from.
 *
 * Vite's dev server versions a module's URL (`?t=...`) after any edit in its
 * import graph, and two URLs are two module records with two copies of the
 * module-level state — here the form registry, the mount table and the audit
 * ring. A test that imported the unversioned path would read a PHANTOM whose
 * registries are always empty, and every "nothing was mounted / nothing was
 * audited" assertion below would pass against it no matter what happened.
 */
async function installFormAppImport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as FormAppWindow;
    if (w.__formAppImport) return;
    w.__formAppImport = async (modulePath: string) => {
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
      const url =
        entries.length > 0 ? entries[entries.length - 1] : new URL(modulePath, document.baseURI).href;
      return w.__calcImport(url);
    };
  });
}

async function apiCall<T = unknown>(page: Page, fn: string, args: unknown[] = []): Promise<T> {
  return page.evaluate(
    async ({ fn, args, api }) => {
      const w = window as unknown as FormAppWindow;
      const m = (await w.__formAppImport!(api)) as Record<string, (...a: unknown[]) => unknown>;
      if (typeof m[fn] !== "function") throw new Error(`@api exports no function "${fn}"`);
      return (await m[fn](...args)) as unknown;
    },
    { fn, args, api: FORM_API },
  ) as Promise<T>;
}

async function formScriptSourceRegistered(page: Page): Promise<void> {
  const source = [
    "// @capability ui.dialog",
    "function setup(form) {",
    "  form.define({",
    '    title: "Preview order", submitLabel: "Save", width: 420,',
    "    children: [",
    `      { type: "textbox",  name: "customer", label: "Customer", bind: "${FORM_CELL_REF}", maxLength: 40 },`,
    '      { type: "checkbox", name: "rush",     label: "Rush order" },',
    "    ],",
    "  });",
    "}",
    "",
  ].join("\n");
  await page.evaluate(
    async ({ api, id, name, source }) => {
      const w = window as unknown as FormAppWindow;
      const m = (await w.__formAppImport!(api)) as {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- an exported identifier, not a name this file picks
        ObjectScriptManager: { registerScript: (d: unknown) => void };
      };
      // REGISTERED ONLY. Not saved to the backend and never mounted: the whole
      // claim is that previewing unsaved code runs nothing in the workbook.
      m.ObjectScriptManager.registerScript({
        id,
        name,
        objectType: "form",
        instanceId: `${id}-instance`,
        source,
        accessLevel: "restricted",
        description: null,
      });
    },
    { api: FORM_API, id: FORM_SCRIPT_ID, name: FORM_SCRIPT_NAME, source },
  );
}

async function isFormScriptMounted(page: Page): Promise<boolean> {
  return page.evaluate(
    async ({ api, id }) => {
      const w = window as unknown as FormAppWindow;
      const m = (await w.__formAppImport!(api)) as {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- an exported identifier, not a name this file picks
        ObjectScriptManager: { isScriptMounted: (id: string) => boolean };
      };
      return m.ObjectScriptManager.isScriptMounted(id);
    },
    { api: FORM_API, id: FORM_SCRIPT_ID },
  );
}

async function isDocumentDirty(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const mod = (await (window as unknown as FormAppWindow).__calcImport(
      new URL("/src/api/backend.ts", document.baseURI).href,
    )) as {
      invokeBackend: <T>(c: string, a?: unknown) => Promise<T>;
    };
    return mod.invokeBackend<boolean>("is_file_modified");
  });
}

/**
 * PRECONDITION, NOT DECORATION. A preview copies at most `MAX_SNAPSHOT_CELLS`
 * (20 000) cells of the active sheet, clamped ROWS-FIRST over the used range
 * (`scriptPreview/snapshot.ts`), so on a very WIDE sheet the copy can stop
 * short of the row a binding names. One app instance serves every spec in this
 * suite, and each of them widens the used range a little, so "the widget opened
 * empty" is a failure two different causes can produce. This states which one
 * up front, in the snapshot's own arithmetic, so the seed assertion below can
 * only fail for the reason it is about.
 */
async function assertRowIsInsideTheSnapshot(page: Page, row: number): Promise<void> {
  const used = await page.evaluate(async () => {
    const mod = (await (window as unknown as FormAppWindow).__calcImport(
      new URL("/src/api/backend.ts", document.baseURI).href,
    )) as {
      invokeBackend: <T>(c: string, a?: unknown) => Promise<T>;
    };
    return mod.invokeBackend<{
      startRow: number;
      startCol: number;
      endRow: number;
      endCol: number;
      empty: boolean;
    }>("get_used_range", { sheetIndex: null });
  });
  if (used.empty) return;
  const width = Math.max(1, used.endCol - used.startCol + 1);
  const maxRows = Math.max(1, Math.floor(20_000 / width));
  const lastCopiedRow = Math.min(used.endRow, used.startRow + maxRows - 1);
  expect(
    lastCopiedRow,
    `the active sheet's used range is ${width} columns wide, so a preview copies only ` +
      `rows ${used.startRow}..${lastCopiedRow} of it — row ${row} is outside the copy and ` +
      `this test's bound widget would open empty for a reason that has nothing to do ` +
      `with forms. Move this spec's cell to a lower row, or narrow what earlier specs ` +
      `leave on this sheet.`,
  ).toBeGreaterThanOrEqual(row);
}

test.describe("the editor's Preview form — a layout painted from unsaved code", () => {
  test.afterEach(async ({ sharedPage: page }) => {
    await installFormAppImport(page);
    // The modal slot first: a preview left open would refuse the next spec's
    // dialog, and the wedge guard would blame that spec.
    await apiCall(page, "resetScriptForms").catch(() => undefined);
    await apiCall(page, "resetScriptDialogs").catch(() => undefined);
    await apiCall(page, "hideDialog", [EDITOR_DIALOG_ID]).catch(() => undefined);
    await page
      .evaluate(
        async ({ api, id }) => {
          const w = window as unknown as FormAppWindow;
          const m = (await w.__formAppImport!(api)) as {
            // eslint-disable-next-line @typescript-eslint/naming-convention -- an exported identifier, not a name this file picks
            ObjectScriptManager: { removeScript: (id: string) => void };
          };
          try {
            m.ObjectScriptManager.removeScript(id);
          } catch {
            /* already gone */
          }
        },
        { api: FORM_API, id: FORM_SCRIPT_ID },
      )
      .catch(() => undefined);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(50);
    }
  });

  test("Preview form paints the layout, Submit lists what WOULD be written, and nothing is mounted, written, dirtied or audited", async ({
    appPage: page,
    grid,
  }) => {
    // A cold Monaco load plus two Worker-realm preview passes; keep the
    // journey project's full budget rather than shrinking it.
    test.setTimeout(300_000);
    await installFormAppImport(page);
    await grid.setCellValue(FORM_CELL_REF, FORM_CELL_SEED);
    await expect
      .poll(() => grid.getCellDisplayValue(FORM_CELL_REF), { timeout: 10_000 })
      .toBe(FORM_CELL_SEED);
    await assertRowIsInsideTheSnapshot(page, FORM_CELL_ROW);

    await formScriptSourceRegistered(page);
    await apiCall(page, "showDialog", [EDITOR_DIALOG_ID, { scriptId: FORM_SCRIPT_ID }]);

    // The action exists ONLY for a form script (CodeEditorDialog gates it on
    // `activeScript.objectType === "form"`), so its presence is already an
    // assertion that the editor recognised the object type.
    const action = page.locator('[data-testid="script-form-preview-action"]');
    await expect(action, "the editor offers no Preview form action for a form script").toBeVisible({
      timeout: 60_000,
    });

    // The two invariants are measured from HERE — after the editor is up, so
    // Monaco's own loading cannot be mistaken for the preview's doing.
    const dirtyBefore = await isDocumentDirty(page);
    // Through `@api`, not through auditRing.ts directly: this block's other
    // reads all go through that one resolved module, and a ring read from a
    // SECOND instance would report 0 both times and agree with itself.
    const auditBefore = await apiCall<number>(page, "getAuditTotal");
    expect(await isFormScriptMounted(page), "precondition: the script must not be mounted").toBe(false);

    await action.click();

    // A failed preview reports WHY on the status strip; read it into the
    // failure rather than timing out on an invisible dialog.
    const status = page.locator('[data-testid="script-form-preview-status"]');
    await expect(status).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => (await status.getAttribute("data-phase")) ?? "", { timeout: 90_000 })
      .not.toBe("running");
    expect(
      await status.getAttribute("data-phase"),
      `the preview did not open. The editor said: ${await status.innerText()}`,
    ).toBe("shown");

    // ---- THE PAINTED FORM -------------------------------------------------
    const dialog = page.locator("[data-script-form]");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    const band = page.locator("[data-script-form-band]");
    await expect(band).toContainText(FORM_SCRIPT_NAME);
    // THE PREVIEW MARKER, in host chrome the script cannot address or remove.
    await expect(band, "a preview must say so where the user is looking").toContainText(
      "nothing will be written",
    );
    await expect(page.locator("[data-script-form-title]")).toHaveText("Preview order");

    // The session belongs to the PREVIEW identity (`preview:<scriptId>`), not
    // to a mount — the registry's own answer to "whose dialog is this".
    expect(
      (await apiCall<{ scriptId: string } | null>(page, "getActiveScriptForm"))?.scriptId,
    ).toBe(`preview:${FORM_SCRIPT_ID}`);
    expect(await isFormScriptMounted(page), "a preview must not mount the script").toBe(false);

    // Seeded from the COPY the run read, not from an empty grid.
    const customer = page.locator('[data-form-widget="customer"]');
    await expect(customer).toHaveValue(FORM_CELL_SEED);

    // ---- SUBMIT SHOWS THE WOULD-WRITE LIST --------------------------------
    await customer.click();
    await customer.fill("Typed In Preview");
    await page.locator('[data-form-widget="rush"]').check();
    await page.locator("[data-script-form-submit]").first().click();

    const wouldWrite = page.locator("[data-script-form-preview]");
    await expect(
      wouldWrite,
      "Submit in a preview must answer with what WOULD be written, never with a write",
    ).toBeVisible({ timeout: 15_000 });
    await expect(wouldWrite).toContainText("customer");
    // The binding is named in the script's own words, so the author can see
    // which cell each answer is aimed at.
    await expect(wouldWrite).toContainText(FORM_CELL_REF);
    await expect(wouldWrite).toContainText("Typed In Preview");
    // ...alongside what the cell holds NOW, which is what makes it a diff.
    await expect(wouldWrite).toContainText(FORM_CELL_SEED);

    // THE CELL ITSELF NEVER MOVED.
    expect(
      await grid.getCellDisplayValue(FORM_CELL_REF),
      "a preview wrote the bound cell — that is an edit, not a preview",
    ).toBe(FORM_CELL_SEED);

    // ---- CLOSE, AND THE INVARIANTS ---------------------------------------
    await page.locator("[data-script-form-close]").first().click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    expect(
      await grid.getCellDisplayValue(FORM_CELL_REF),
      "closing the preview wrote the bound cell",
    ).toBe(FORM_CELL_SEED);
    expect(await isFormScriptMounted(page), "the preview left the script mounted").toBe(false);
    expect(
      await apiCall(page, "getActiveScriptForm"),
      "the preview identity kept the app-wide modal slot after closing",
    ).toBeNull();
    expect(
      await isDocumentDirty(page),
      "the preview dirtied the document — is_modified gates BOTH the " +
        "close-without-saving prompt and AutoRecover",
    ).toBe(dirtyBefore);
    expect(
      await apiCall<number>(page, "getAuditTotal"),
      "the preview put a row in the audit ring: a dry run is not an event in " +
        "this workbook's history, and the transparency panel renders that ring",
    ).toBe(auditBefore);

    // The editor's status strip clears itself once the form is gone, so the
    // author is not left reading a note about a dialog that closed.
    await expect(status).toBeHidden({ timeout: 15_000 });
  });
});
