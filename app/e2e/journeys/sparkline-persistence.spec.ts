/**
 * BUG-0012 — "sparkline groups are lost across save/reload", RE-TRIED ON THE
 * REAL APP instead of being carried forward on the ledger for another pass.
 *
 * The entry was filed 2026-06-11 by the save/reload oracle during a scenario
 * run, and has been listed as open in every handover since. Reading the tree in
 * 2026-08 says otherwise: `collect_sparklines_for_save` is wired into
 * `build_workbook_for_save`, `zip_io.rs` writes `sparklines.json` and reads it
 * back unconditionally, and `restore_sparklines` puts them into `AppState`. So
 * either the defect was fixed by one of the persistence passes without anyone
 * closing the entry — the exact failure §6c and §7b name from both sides — or
 * it is still real and the tree reading is wrong.
 *
 * READING THE SOURCE CANNOT SETTLE THAT, and the only reason this entry has
 * survived three passes is that nobody ran it. This spec runs it: a real
 * sparkline group, a real `save_file` to a real `.cala`, a real `open_file`,
 * and the backend's own digest on both sides.
 *
 * WHY THE DIGEST AND NOT A COUNT. `state_digest.rs` hashes sparklines as
 * `sheetIndex -> sorted groups_json`, i.e. the group's LOCATION and SOURCE
 * range, not merely how many exist. A count survives a reload that restores an
 * empty group at the wrong address; the digest does not. It is also the exact
 * instrument that filed the bug, so a green here is a green on the same
 * measurement that reported the red.
 *
 * It is a JOURNEY because it calls `open_file`, which replaces the document and
 * clears the undo stack.
 *
 * Grid area: AP1:AT1 (columns 41-45) — the walker's declared sparkline area,
 * which nothing else in the tree writes to.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { resetToNewWorkbook } from "../helpers/screenshots";

interface SparklineDigest {
  [sheetIndex: string]: string[];
}

async function sparklineDigest(page: import("@playwright/test").Page): Promise<SparklineDigest> {
  return page.evaluate(async () => {
    type TauriBridge = { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
    const tauri = (window as unknown as Record<string, TauriBridge>)["__TAURI__"];
    const digest = (await tauri.core.invoke("get_workbook_state_digest")) as {
      sparklines?: Record<string, string[]>;
    };
    return digest.sparklines ?? {};
  });
}

function groupCount(d: SparklineDigest): number {
  return Object.values(d).reduce((n, groups) => n + groups.length, 0);
}

test.describe("BUG-0012: sparkline groups across save/reload", () => {
  test.setTimeout(180_000);

  test("a sparkline group survives save_file -> open_file, address and source intact", async ({
    appPage,
    grid,
  }) => {
    await resetToNewWorkbook(appPage);
    await appPage.waitForTimeout(500);

    const tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "calcula-spark-")),
      "sparkline-roundtrip.cala",
    );

    // --- build the source data and the group, through the extension's own API
    await grid.setCellValueDirect("AP1", "10");
    await grid.setCellValueDirect("AQ1", "20");
    await grid.setCellValueDirect("AR1", "15");
    await grid.setCellValueDirect("AS1", "30");

    const created = await appPage.evaluate(() => {
      const sparkApi = (window as unknown as Record<string, {
        createSparklineGroup: (
          location: Record<string, number>,
          source: Record<string, number>,
          kind: string,
        ) => unknown;
        getAllGroups: () => unknown[];
      }>)["__CALCULA_SPARKLINES__"];
      if (!sparkApi) return null;
      sparkApi.createSparklineGroup(
        { startRow: 0, startCol: 45, endRow: 0, endCol: 45 },
        { startRow: 0, startCol: 41, endRow: 0, endCol: 44 },
        "line",
      );
      return sparkApi.getAllGroups().length;
    });
    expect(
      created,
      "the Sparklines extension must expose its create API — without a group " +
        "there is nothing for this test to lose, and it would pass vacuously"
    ).not.toBeNull();
    await appPage.waitForTimeout(600);

    const before = await sparklineDigest(appPage);
    // NON-VACUITY: the whole test is "does this survive", so there must be a
    // `this`. A digest with no groups makes every assertion below trivially
    // true — which is precisely how a persistence test rots into a no-op.
    expect(
      groupCount(before),
      "the backend digest must actually hold a sparkline group before the save"
    ).toBeGreaterThan(0);

    // --- save ---------------------------------------------------------------
    const saveError = await appPage.evaluate(async (p: string) => {
      type TauriBridge = { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
      const tauri = (window as unknown as Record<string, TauriBridge>)["__TAURI__"];
      try {
        await tauri.core.invoke("save_file", { path: p, password: null });
        return null;
      } catch (e) {
        return String(e);
      }
    }, tmpFile);
    expect(saveError, "save_file must succeed").toBeNull();
    expect(fs.existsSync(tmpFile), "the .cala file must exist on disk").toBe(true);

    // The archive is a ZIP of structured JSON, so the question "was it written
    // at all" is answerable without the app. This separates "the writer dropped
    // it" from "the reader dropped it" — the two halves BUG-0012's own triage
    // could not tell apart ("either not written to the archive or not restored
    // on load").
    const archive = fs.readFileSync(tmpFile);
    expect(
      archive.includes(Buffer.from("sparklines.json")),
      "the .cala archive must contain a sparklines.json entry — if this fails " +
        "the defect is in the WRITER"
    ).toBe(true);

    // --- reload -------------------------------------------------------------
    const openError = await appPage.evaluate(async (p: string) => {
      type TauriBridge = { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
      const tauri = (window as unknown as Record<string, TauriBridge>)["__TAURI__"];
      try {
        await tauri.core.invoke("open_file", { path: p });
        window.dispatchEvent(new Event("grid:refresh"));
        return null;
      } catch (e) {
        return String(e);
      }
    }, tmpFile);
    expect(openError, "open_file must succeed").toBeNull();
    await appPage.waitForTimeout(1500);

    const after = await sparklineDigest(appPage);

    expect(
      groupCount(after),
      "BUG-0012: the sparkline group did not come back from the .cala"
    ).toBe(groupCount(before));
    expect(
      after,
      "BUG-0012: the sparkline group came back at a different address or over " +
        "a different source range — the digest hashes location AND source, so " +
        "this is stronger than a count"
    ).toEqual(before);

    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  });
});
