/**
 * THE UNDO ROUND-TRIP ORACLE, RUN OVER PIVOTS WITH NOTHING SUPPRESSED.
 *
 * WHY THIS SPEC EXISTS. Two entries in `e2e/oracles/knownIssues.ts` blinded the
 * undo oracle for fourteen months of programme time:
 *
 *   BUG-0014  pathPrefixes: ["sheets[0].colWidths.", "sheets[1].colWidths."]
 *   BUG-0015  pathPrefixes: ["pivots."]
 *
 * Neither was scoped to its defect. `filterKnownIssues` drops a violation when
 * EVERY digest-diff path is covered by a prefix, so `pivots.` swallowed the
 * whole pivot subtree — every field of every pivot definition, from any cause —
 * and the two `colWidths.` prefixes swallowed all column-width divergence on the
 * first two sheets, likewise from any cause. BUG-0014's own note said so
 * ("this also masks other width-undo regressions while open") and it was right.
 *
 * Both suppressions are gone. This spec is what replaces them: the same
 * question the oracle asks (undo N transactions, compare the digests), asked
 * directly, on the two prefixes that were suppressed, with `diffDigests` and no
 * filter anywhere near it.
 *
 * WHAT IT PINS
 *   1. A pivot's auto-fitted COLUMN WIDTHS come back on undo (BUG-0014). The
 *      fit wrote `column_widths` / `all_column_widths` and recorded nothing on
 *      the undo stack; it now returns what it overwrote and the widths ride in
 *      the same transaction as the pivot change.
 *   2. The pivot DEFINITION does not survive undo-all (BUG-0015), through the
 *      whole create + configure sequence a user actually performs.
 *   3. MOVING a pivot is undoable (`relocate_pivot` recorded nothing at all —
 *      found by narrowing the `pivots.` prefix).
 *   4. The round trip is symmetric: redo puts all three back.
 *
 * VACUOUS-PASS DISCIPLINE, which this class of test needs more than most. A
 * width assertion passes trivially if the fit never happened, and a "no pivot
 * after undo" assertion passes trivially if the pivot was never created. So
 * every check here is preceded by its own positive control, asserted from the
 * SAME digest by the same code path: the pivot is proved present, and the
 * widths are proved to have CHANGED, before anything is claimed about undo.
 *
 * GRID REAL ESTATE. Columns CQ..CZ (94..103), rows 1..24 — outside the ranges
 * the other journeys claim. Each test starts from File ▸ New anyway.
 *
 * LOCALE. sv-SE. No formula is typed here, so no list separator arises.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef } from "../helpers/grid";
import { getWorkbookDigest, diffDigests } from "../oracles/digest";
import type { Digest } from "../oracles/digest";
import { getUndoState } from "../oracles/undoRoundTrip";

/** Where the source table goes, and where the pivot is dropped. */
const SOURCE_TOP_LEFT = "CQ1";
const SOURCE_RANGE = "CQ1:CR5";
const PIVOT_DEST = "CU1";
const PIVOT_MOVED_DEST = "CU12";

/** Long labels, so the auto-fit has something to widen the column FOR. */
const SOURCE_ROWS: Array<[string, string]> = [
  ["Region", "Amount"],
  ["Northern Territories Wholesale", "100"],
  ["Southern Territories Wholesale", "250"],
  ["Northern Territories Wholesale", "175"],
  ["Eastern Territories Wholesale", "325"],
];

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
  await page.waitForTimeout(900);
}

async function setCell(page: Page, ref: string, value: string): Promise<void> {
  const { row, col } = parseCellRef(ref);
  await invoke(page, "update_cell", { row, col, value });
}

/** Lay the source table down. */
async function seedSource(page: Page): Promise<void> {
  const { row, col } = parseCellRef(SOURCE_TOP_LEFT);
  for (let r = 0; r < SOURCE_ROWS.length; r++) {
    for (let c = 0; c < SOURCE_ROWS[r].length; c++) {
      await invoke(page, "update_cell", {
        row: row + r,
        col: col + c,
        value: SOURCE_ROWS[r][c],
      });
    }
  }
  await page.waitForTimeout(300);
}

interface PivotViewResponse {
  pivotId: string;
}

/**
 * Create a pivot and configure it, which is what the UI does: the create path
 * deliberately starts EMPTY and `update_pivot_fields` is what fills it in (and
 * what triggers the column auto-fit). Two transactions, exactly as the ledgered
 * BUG-0015 repro describes.
 */
async function createConfiguredPivot(page: Page): Promise<string> {
  const created = await invoke<PivotViewResponse>(page, "create_pivot_table", {
    request: {
      sourceRange: SOURCE_RANGE,
      destinationCell: PIVOT_DEST,
      hasHeaders: true,
    },
  });
  const pivotId = created.pivotId;
  await invoke(page, "update_pivot_fields", {
    request: {
      pivotId,
      rowFields: [{ sourceIndex: 0, name: "Region" }],
      valueFields: [
        { sourceIndex: 1, name: "Sum of Amount", aggregation: "sum" },
      ],
    },
  });
  await page.waitForTimeout(600);
  return pivotId;
}

/** Undo `n` backend transactions, the way the oracle does. */
async function undoTimes(page: Page, n: number): Promise<number> {
  return page.evaluate(async (count) => {
    const t = (
      window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
      }
    ).__TAURI__;
    let done = 0;
    for (let i = 0; i < count; i++) {
      const r = (await t.core.invoke("undo")) as { success?: boolean } | null;
      if (r && r.success === false) break;
      done++;
    }
    return done;
  }, n) as Promise<number>;
}

async function redoTimes(page: Page, n: number): Promise<number> {
  return page.evaluate(async (count) => {
    const t = (
      window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
      }
    ).__TAURI__;
    let done = 0;
    for (let i = 0; i < count; i++) {
      const r = (await t.core.invoke("redo")) as { success?: boolean } | null;
      if (r && r.success === false) break;
      done++;
    }
    return done;
  }, n) as Promise<number>;
}

/** The digest paths this spec is about, extracted for readable failures. */
function pathsUnder(
  diff: ReturnType<typeof diffDigests>,
  prefixes: string[],
): string[] {
  return diff.diffs
    .filter((d) => prefixes.some((p) => d.path.startsWith(p)))
    .map((d) => `${d.path}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`);
}

/** Sheet 0's column widths, straight off the digest. */
function colWidths(d: Digest): Record<string, number> {
  const sheets = d.digest.sheets as Array<{ colWidths?: Record<string, number> }>;
  return sheets[0]?.colWidths ?? {};
}

/** Pivot definitions, straight off the digest — the `pivots.` subtree. */
function pivots(d: Digest): Record<string, unknown> {
  return (d.digest.pivots ?? {}) as Record<string, unknown>;
}

test.describe("Pivot undo fidelity — the two suppressions, unsuppressed", () => {
  test.beforeEach(async ({ appPage: page }) => {
    await newFile(page);
  });

  test("undo of create+configure restores the pivot-fitted column widths AND removes the pivot", async ({
    appPage: page,
  }) => {
    await seedSource(page);

    // The baseline the oracle would capture: state, and the id on top of the
    // undo stack, BEFORE the pivot actions.
    const baseline = await getWorkbookDigest(page);
    const baselineUndo = await getUndoState(page);
    const baselineTop =
      baselineUndo.undoSeqs.length > 0
        ? baselineUndo.undoSeqs[baselineUndo.undoSeqs.length - 1]
        : null;

    const pivotId = await createConfiguredPivot(page);
    const after = await getWorkbookDigest(page);

    // ---- POSITIVE CONTROLS. Without these the whole test is vacuous. ----
    expect(
      Object.keys(pivots(after)),
      "precondition: the pivot must exist in the digest before undo is asked about it",
    ).toContain(pivotId);

    const widthsBefore = colWidths(baseline);
    const widthsAfter = colWidths(after);
    const widened = Object.keys(widthsAfter).filter(
      (col) => widthsAfter[col] !== widthsBefore[col],
    );
    expect(
      widened.length,
      "precondition: creating and configuring the pivot must actually auto-fit at " +
        "least one column, or the width half of this test proves nothing. " +
        `before=${JSON.stringify(widthsBefore)} after=${JSON.stringify(widthsAfter)}`,
    ).toBeGreaterThan(0);

    // ---- Wind back to the baseline by IDENTITY, not by depth. ----
    const now = await getUndoState(page);
    const position = baselineTop === null ? -1 : now.undoSeqs.indexOf(baselineTop);
    const steps = baselineTop === null ? now.undoSeqs.length : now.undoSeqs.length - 1 - position;
    expect(
      steps,
      "the pivot actions must have pushed at least one undo transaction",
    ).toBeGreaterThan(0);
    const undone = await undoTimes(page, steps);
    expect(undone, "every step back to the checkpoint must succeed").toBe(steps);
    await page.waitForTimeout(500);

    const undoneDigest = await getWorkbookDigest(page);
    const undoDiff = diffDigests(baseline, undoneDigest, "undo");

    // BUG-0014, stated as the oracle would have stated it.
    expect(
      pathsUnder(undoDiff, ["sheets[0].colWidths.", "sheets[1].colWidths."]),
      "BUG-0014: the pivot's auto-fitted column widths must be undone with the " +
        "pivot change that caused them (Excel undoes the two together)",
    ).toEqual([]);

    // BUG-0015, likewise.
    expect(
      pathsUnder(undoDiff, ["pivots."]),
      "BUG-0015: no pivot definition may survive undo-all",
    ).toEqual([]);

    // And nothing else either — the suppressions were the only reason this
    // window was ever green, so the honest assertion is the whole digest.
    expect(
      undoDiff.diffs.map((d) => d.path),
      "undoing back to the checkpoint must restore the checkpoint state exactly",
    ).toEqual([]);

    // ---- Symmetry: redo puts it all back. ----
    const redone = await redoTimes(page, undone);
    expect(redone, "redo must be able to replay every undone step").toBe(undone);
    await page.waitForTimeout(500);

    const redoneDigest = await getWorkbookDigest(page);
    const redoDiff = diffDigests(after, redoneDigest, "undo");
    expect(
      redoDiff.diffs.map(
        (d) => `${d.path}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`,
      ),
      "redoing must restore the post-action state exactly, widths included",
    ).toEqual([]);
  });

  test("moving a pivot is undoable — relocate_pivot recorded nothing at all", async ({
    appPage: page,
  }) => {
    await seedSource(page);
    const pivotId = await createConfiguredPivot(page);

    const beforeMove = await getWorkbookDigest(page);
    const beforeUndo = await getUndoState(page);
    const topBeforeMove =
      beforeUndo.undoSeqs.length > 0
        ? beforeUndo.undoSeqs[beforeUndo.undoSeqs.length - 1]
        : null;
    expect(
      Object.keys(pivots(beforeMove)),
      "precondition: the pivot must exist before it is moved",
    ).toContain(pivotId);

    const { row, col } = parseCellRef(PIVOT_MOVED_DEST);
    await invoke(page, "relocate_pivot", { pivotId, newRow: row, newCol: col });
    await page.waitForTimeout(500);

    const afterMove = await getWorkbookDigest(page);
    const moveDiff = diffDigests(beforeMove, afterMove, "undo");
    expect(
      pathsUnder(moveDiff, ["pivots."]).length,
      "precondition: the move must actually change the pivot definition, or the " +
        "undo assertion below is vacuous",
    ).toBeGreaterThan(0);

    const now = await getUndoState(page);
    const position = topBeforeMove === null ? -1 : now.undoSeqs.indexOf(topBeforeMove);
    const steps =
      topBeforeMove === null ? now.undoSeqs.length : now.undoSeqs.length - 1 - position;
    expect(
      steps,
      "the move must have pushed exactly one undo transaction — it used to push none, " +
        "so Ctrl+Z silently reverted whatever came before it instead",
    ).toBe(1);

    expect(await undoTimes(page, steps)).toBe(steps);
    await page.waitForTimeout(500);

    const undoneDigest = await getWorkbookDigest(page);
    const undoDiff = diffDigests(beforeMove, undoneDigest, "undo");
    expect(
      undoDiff.diffs.map((d) => d.path),
      "undoing the move must put the pivot back where it was",
    ).toEqual([]);
  });
});
