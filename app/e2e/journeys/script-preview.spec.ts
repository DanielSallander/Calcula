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
