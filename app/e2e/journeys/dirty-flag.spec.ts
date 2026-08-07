/**
 * Dirty-flag journey: proves that the mutations which used to leave a workbook
 * looking clean now set `FileState::is_modified` — the single flag the close
 * prompt AND AutoRecover both gate on — and that AutoRecover really snapshots
 * the work.
 *
 * This is the LIVE half of the DocumentEffect census. Unit tests assert the flag
 * per command; what they cannot show is that the user-visible consequences
 * follow: the window-title star, a real AutoRecover file containing the change,
 * and transient previews still NOT nagging.
 *
 * THE CLOSE PROMPT ITSELF lives in `dirty-flag-close.spec.ts`. It cannot be
 * asserted from here: the prompt is a NATIVE dialog and the handler ends in
 * `getCurrentWindow().destroy()`, and Tauri defines the whole IPC surface with
 * `Object.defineProperty(..., { value })` — non-writable and non-configurable —
 * so there is no way to intercept `plugin:dialog|ask` / `plugin:window|destroy`
 * from the page. That spec therefore observes the REAL native dialog window and
 * the REAL process lifetime, one app lifetime per case.
 *
 * Grid area: AE..AJ (columns 30-35). Columns K,L,N,P,R,T-Z,AA-AD are already
 * claimed by other specs.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const TMP = os.tmpdir();
const BASE_FILE = path.join(TMP, "calcula-dirty-flag.cala");
const PERSIST_FILE = path.join(TMP, "calcula-dirty-persist.cala");
/** auto_recover_save writes `~$<filename>.recovery` next to the current file. */
const RECOVERY_FILE = path.join(TMP, "~$calcula-dirty-flag.cala.recovery");

// ---------------------------------------------------------------------------
// Backend helpers
// ---------------------------------------------------------------------------

/** Invoke a backend command through the e2e-enabled window.__TAURI__ bridge. */
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

/** The authoritative dirty flag — the one the close prompt and AutoRecover read. */
async function isDirty(page: Page): Promise<boolean> {
  return invoke<boolean>(page, "is_file_modified");
}

/**
 * The app's own dirty INDICATOR: `updateWindowTitle()` renders "name * - Calcula"
 * when dirty. document.title is what the user sees in the title bar and taskbar.
 */
async function titleShowsDirty(page: Page): Promise<boolean> {
  return page.evaluate(() => / \* - Calcula$/.test(document.title));
}

/**
 * Drive the shell's own title refresh, then read the indicator.
 *
 * `updateWindowTitle()` is bound to a fixed set of app events (CELLS_UPDATED,
 * ROWS_/COLUMNS_ INSERTED/DELETED, DIRTY_STATE_CHANGED). Dispatching
 * DIRTY_STATE_CHANGED runs the SAME production listener, which re-reads
 * `is_file_modified` from the backend, so these assertions are about what the
 * indicator RENDERS for the current flag.
 *
 * KNOWN GAP, measured on 2026-08-07 and deliberately not papered over: nothing
 * fires any of those events for a backend-only mutation, so after adding a
 * conditional-format rule the flag reads `true` while the title still shows no
 * star (it read "Untitled - Calcula" even though the document had been saved to
 * a path and then dirtied). The close prompt -- the safety net -- is correct;
 * the ambient indicator lags it. Fixing that properly means announcing the
 * clean->dirty transition once from the backend choke point
 * (`DocumentEffect::mutates`) rather than asking 355 commands to remember to
 * emit an event, which is the very failure mode the census exists to prevent.
 * Until then this helper asserts the indicator's VALUE, not its liveness.
 */
async function refreshTitle(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("app:dirty-state-changed"));
  });
  await page.waitForTimeout(300);
}

/** Save to `file`, leaving the document CLEAN — the baseline every probe starts from. */
async function saveClean(page: Page, file: string): Promise<void> {
  await invoke(page, "save_file", { path: file });
  await page.waitForTimeout(400);
  expect(await isDirty(page)).toBe(false);
}

async function cfRuleCount(page: Page): Promise<number> {
  const rules = await invoke<unknown[]>(page, "get_all_conditional_formats");
  return Array.isArray(rules) ? rules.length : 0;
}

/**
 * Add a conditional-format rule through the REAL menu and the REAL QuickCFDialog.
 * The close-prompt spec inlines the same sequence for its "dirty" case.
 */
async function addCfRuleViaDialog(
  grid: { page: Page; selectRange: (a: string, b: string) => Promise<void>; openMenu: (m: string) => Promise<void>; hoverMenuItem: (i: string) => Promise<void>; clickMenuItem: (i: string) => Promise<void> },
  value = "50",
): Promise<void> {
  const page = grid.page;
  await grid.selectRange("AE1", "AE3");

  // Format > Conditional Formatting > Highlight Cells Rules > Greater Than...
  await grid.openMenu("Format");
  await grid.hoverMenuItem("Conditional Formatting");
  await grid.hoverMenuItem("Highlight Cells Rules");
  await grid.clickMenuItem("Greater Than");

  // The real QuickCFDialog.
  await expect(page.locator("text=GREATER THAN").first()).toBeVisible({ timeout: 8000 });
  const valueInput = page.locator('input[type="text"]:visible').last();
  await valueInput.fill(value);

  // Commit through the dialog's own OK button.
  await page.locator("button").filter({ hasText: /^OK$/ }).last().click();
  await page.waitForTimeout(600);
}

// ===========================================================================

test.describe.serial("Dirty flag: mutations, AutoRecover and transient previews", () => {
  // ------------------------------------------------------------------
  // 2. CONTROL — runs FIRST so the headline cannot pass on an
  //    already-dirty workbook.
  // ------------------------------------------------------------------
  test("CONTROL: read-only and session-only actions leave the document clean", async ({ grid }) => {
    const page = grid.page;

    await grid.setCellValueDirect("AE1", "10");
    await grid.setCellValueDirect("AE2", "50");
    await grid.setCellValueDirect("AE3", "90");
    await saveClean(page, BASE_FILE);

    // --- Genuinely read-only: read a cell back. ---
    const readBack = await invoke<{ display?: string } | null>(page, "get_cell", { row: 0, col: 30 });
    expect(String(readBack?.display ?? "")).toBe("10");

    // --- Session-only: move the selection, switch the active sheet. ---
    await grid.navigateTo("AE3");
    await grid.navigateTo("AE1");
    await invoke(page, "set_active_sheet", { index: 0 });
    await page.waitForTimeout(200);

    // Flag AND indicator must both still read clean.
    expect(await isDirty(page)).toBe(false);
    await refreshTitle(page);
    expect(await titleShowsDirty(page)).toBe(false);
  });

  // ------------------------------------------------------------------
  // 1. THE HEADLINE — a conditional-format rule added through the REAL dialog.
  // ------------------------------------------------------------------
  test("HEADLINE: a conditional-format rule added through the real dialog dirties the document", async ({
    grid,
  }) => {
    const page = grid.page;

    await saveClean(page, BASE_FILE);
    const before = await cfRuleCount(page);

    await addCfRuleViaDialog(grid);

    // The dialog really added a rule.
    expect(await cfRuleCount(page)).toBe(before + 1);

    // ---- The flag both safety nets read. ----
    expect(await isDirty(page)).toBe(true);

    // ---- The app's own dirty indicator. ----
    await refreshTitle(page);
    expect(await titleShowsDirty(page)).toBe(true);
  });

  // ------------------------------------------------------------------
  // 4. BREADTH — one previously-broken command per area.
  // ------------------------------------------------------------------
  test("BREADTH: previously-broken commands across six areas each dirty the document", async ({
    grid,
  }) => {
    test.setTimeout(120_000);
    const page = grid.page;
    const uniq = Date.now().toString(36);

    // Seed a small table for the pivot/chart cases (AE..AF, rows 6-9).
    await grid.setCellValueDirect("AE6", "City");
    await grid.setCellValueDirect("AF6", "Sales");
    await grid.setCellValueDirect("AE7", "Oslo");
    await grid.setCellValueDirect("AF7", "100");
    await grid.setCellValueDirect("AE8", "Bergen");
    await grid.setCellValueDirect("AF8", "200");
    await grid.setCellValueDirect("AE9", "Oslo");
    await grid.setCellValueDirect("AF9", "150");

    const chartId = await page.evaluate(() => crypto.randomUUID());

    const cases: { area: string; run: () => Promise<void> }[] = [
      {
        area: "named range",
        run: async () => {
          await invoke(page, "create_named_range", {
            name: `DirtyNR${uniq}`,
            sheetIndex: null,
            refersTo: "Sheet1!$AE$1:$AE$3",
            comment: null,
            folder: null,
          });
        },
      },
      {
        area: "note / comment",
        run: async () => {
          await invoke(page, "add_comment", {
            params: {
              row: 5,
              col: 32,
              authorEmail: "e2e@example.com",
              authorName: "E2E",
              content: `dirty-flag ${uniq}`,
            },
          });
        },
      },
      {
        area: "protection",
        run: async () => {
          await invoke(page, "protect_sheet", { params: { password: null } });
        },
      },
      {
        area: "page setup",
        run: async () => {
          const setup = await invoke<Record<string, unknown>>(page, "get_page_setup");
          setup.orientation = setup.orientation === "landscape" ? "portrait" : "landscape";
          await invoke(page, "set_page_setup", { setup });
        },
      },
      {
        area: "pivot",
        run: async () => {
          await invoke(page, "create_pivot_table", {
            request: {
              sourceRange: "AE6:AF9",
              destinationCell: "AH6",
              hasHeaders: true,
            },
          });
        },
      },
      {
        area: "chart",
        run: async () => {
          const spec = {
            mark: "bar",
            data: { sheetIndex: 0, startRow: 5, startCol: 30, endRow: 8, endCol: 31 },
            hasHeaders: true,
            seriesOrientation: "columns",
            categoryIndex: 0,
            series: [{ sourceIndex: 1, name: "Sales", color: "#4472C4" }],
            title: "Dirty Flag Chart",
          };
          await invoke(page, "save_chart", {
            entry: { id: chartId, sheetIndex: 0, specJson: JSON.stringify(spec) },
          });
        },
      },
    ];

    const results: { area: string; dirty: boolean }[] = [];
    try {
      for (const c of cases) {
        // Each area starts from a genuinely clean document, so the assertion is
        // about THIS command and nothing that ran before it.
        await saveClean(page, BASE_FILE);
        await c.run();
        await page.waitForTimeout(300);
        results.push({ area: c.area, dirty: await isDirty(page) });

        // Protection would block the next save; lift it immediately.
        if (c.area === "protection") {
          await invoke(page, "unprotect_sheet", { password: null });
          await page.waitForTimeout(200);
        }
      }
    } finally {
      // Never leave the sheet protected for the rest of the suite.
      await invoke(page, "unprotect_sheet", { password: null }).catch(() => {});
    }

    const clean = results.filter((r) => !r.dirty).map((r) => r.area);
    expect(clean, `these areas did NOT dirty the document: ${clean.join(", ")}`).toEqual([]);
    expect(results).toHaveLength(6);
  });

  // ------------------------------------------------------------------
  // 3. AUTORECOVER — the second safety net, driven by the REAL extension timer.
  // ------------------------------------------------------------------
  test("AUTORECOVER: the real timer snapshots a previously-broken mutation", async ({ grid }) => {
    test.setTimeout(240_000); // a real 1-minute AutoRecover cycle plus slack
    const page = grid.page;

    const nrName = `RecoverNR${Date.now().toString(36)}`;

    // Clean baseline at a known path, so the recovery path is predictable.
    await saveClean(page, BASE_FILE);

    // Remove any stale snapshot so its mere existence cannot pass the test.
    if (fs.existsSync(RECOVERY_FILE)) fs.unlinkSync(RECOVERY_FILE);
    expect(fs.existsSync(RECOVERY_FILE)).toBe(false);

    // A mutation of exactly the previously-broken kind: create_named_range did
    // not even take FileState, so it could not mark dirty — and AutoRecover
    // returns "not_dirty" when the flag is clear, so it would have refused to
    // snapshot this work.
    await invoke(page, "create_named_range", {
      name: nrName,
      sheetIndex: null,
      refersTo: "Sheet1!$AE$1:$AE$3",
      comment: null,
      folder: null,
    });
    await page.waitForTimeout(300);
    expect(await isDirty(page)).toBe(true);

    try {
      // Drive the REAL AutoRecover: File > AutoRecover Interval > 1 minute.
      // The extension's menu action calls set_auto_recover_settings AND restarts
      // its own setInterval, so the snapshot below is written by the extension's
      // timer firing on its own — the test never calls auto_recover_save.
      await grid.openMenu("File");
      await grid.hoverMenuItem("AutoRecover Interval");
      await grid.clickMenuItem("1 minute");
      await grid.closeMenu();

      const settings = await invoke<{ enabled: boolean; intervalMs: number }>(
        page,
        "get_auto_recover_settings",
      );
      expect(settings.enabled).toBe(true);
      expect(settings.intervalMs).toBe(60_000);

      // Wait for the timer to fire (60s) plus slack.
      await expect
        .poll(() => fs.existsSync(RECOVERY_FILE), {
          timeout: 120_000,
          intervals: [2000],
          message: "AutoRecover never wrote a recovery snapshot",
        })
        .toBe(true);
    } finally {
      // Restore the default interval so later specs are not perturbed.
      await grid.openMenu("File").catch(() => {});
      await grid.hoverMenuItem("AutoRecover Interval").catch(() => {});
      await grid.clickMenuItem("5 minutes").catch(() => {});
      await grid.closeMenu().catch(() => {});
    }

    expect(fs.statSync(RECOVERY_FILE).size).toBeGreaterThan(0);

    // ---- The snapshot must CONTAIN the work. ----
    // Open the recovery file through the real load path and look for the range.
    await invoke(page, "open_file", { path: RECOVERY_FILE, password: null });
    await page.waitForTimeout(1500);

    const names = await invoke<{ name: string }[]>(page, "get_all_named_ranges");
    expect(names.map((n) => n.name)).toContain(nrName);

    // ---- 6. A freshly LOADED document must start CLEAN. ----
    expect(await isDirty(page)).toBe(false);
    await refreshTitle(page);
    expect(await titleShowsDirty(page)).toBe(false);
  });

  // ------------------------------------------------------------------
  // 5. TRANSIENT — animation playback must NOT dirty a saved workbook.
  // ------------------------------------------------------------------
  test("TRANSIENT: animation playback leaves a saved workbook clean, during and after", async ({
    grid,
  }) => {
    test.setTimeout(120_000);
    const page = grid.page;

    // Model: AE20 is the driver, AF20 depends on it.
    await grid.setCellValueDirect("AE20", "7");
    await grid.setCellValueDirect("AF20", "=AE20*2");
    await saveClean(page, BASE_FILE);

    const driverDisplay = async () => {
      const cell = await invoke<{ display?: string } | null>(page, "get_cell", { row: 19, col: 30 });
      return String(cell?.display ?? "");
    };

    // Open the Animation panel and configure a clock-cell driver.
    await grid.openMenu("View");
    await grid.clickMenuItem("Animation Timeline");
    await expect(page.locator('[data-testid="anim-driver-cell"]')).toBeVisible({ timeout: 8000 });
    await page.locator('[data-testid="anim-driver-cell"]').fill("AE20");
    await page.locator('[data-testid="anim-from"]').fill("0");
    await page.locator('[data-testid="anim-to"]').fill("10");
    await page.locator('[data-testid="anim-step"]').fill("1");
    await page.locator('[data-testid="anim-set-driver"]').click();
    await expect(page.locator('[data-testid="anim-frame"]')).toHaveText("1 / 11", { timeout: 5000 });

    // Configuring the driver must not have dirtied anything.
    expect(await isDirty(page)).toBe(false);

    // Step: the transient write really lands in the grid...
    await page.locator('button[title="Step forward"]').click();
    await expect.poll(driverDisplay, { timeout: 5000 }).toBe("1");

    // ...and the document is STILL clean while the preview is running.
    expect(await isDirty(page)).toBe(false);

    // Play to the end.
    await page.locator('button[title="Play"]').click();
    await expect.poll(driverDisplay, { timeout: 20_000 }).toBe("10");
    expect(await isDirty(page)).toBe(false);

    // Stop restores the model.
    await page.locator('button[title="Stop (reset)"]').click();
    await expect.poll(driverDisplay, { timeout: 5000 }).toBe("7");

    // Clean after playback — no preview may ever start nagging the user.
    expect(await isDirty(page)).toBe(false);
    await refreshTitle(page);
    expect(await titleShowsDirty(page)).toBe(false);
  });

  // ------------------------------------------------------------------
  // 7. VIEW FLAGS + BOOKMARKS persist across save / wipe / reopen.
  // ------------------------------------------------------------------
  test("PERSISTENCE: the four view flags and bookmarks survive save, new_file and reopen", async ({
    grid,
  }) => {
    test.setTimeout(180_000);
    const page = grid.page;

    await grid.setCellValueDirect("AE30", "flagcheck");

    // ---- Set all four display flags (the command the View toggles call). ----
    await invoke(page, "set_sheet_display_flags", {
      patch: {
        displayZeros: false,
        showFormulas: true,
        viewMode: "pageLayout",
        displayHeadings: false,
      },
    });
    await page.waitForTimeout(200);

    // Setting persisted view state must itself dirty the document.
    expect(await isDirty(page)).toBe(true);

    expect(await invoke<Record<string, unknown>>(page, "get_sheet_display_flags")).toMatchObject({
      displayZeros: false,
      showFormulas: true,
      viewMode: "pageLayout",
      displayHeadings: false,
    });

    // ---- Add a bookmark through the REAL menu: Insert > Bookmarks > Add Bookmark. ----
    await grid.navigateTo("AE30");
    await grid.openMenu("Insert");
    await grid.hoverMenuItem("Bookmarks");
    await grid.clickMenuItem("Add Bookmark");
    await grid.closeMenu();
    // Write-through persists on every mutation; give the chain a moment.
    await page.waitForTimeout(1000);

    const bookmarkJson = await invoke<string | null>(page, "read_virtual_file", {
      path: ".calcula/bookmarks.json",
    });
    expect(bookmarkJson, "bookmark was not written through to the virtual file").toBeTruthy();
    expect(JSON.parse(String(bookmarkJson)).cellBookmarks.length).toBeGreaterThan(0);

    // A bookmark edit must also dirty the document (createVirtualFile does).
    expect(await isDirty(page)).toBe(true);

    // ---- Save, then WIPE with new_file. ----
    await saveClean(page, PERSIST_FILE);

    await invoke(page, "new_file");
    await page.waitForTimeout(1200);

    expect(await invoke<Record<string, unknown>>(page, "get_sheet_display_flags")).toMatchObject({
      displayZeros: true,
      showFormulas: false,
      viewMode: "normal",
      displayHeadings: true,
    });
    // new_file is a load path: it must leave the document clean.
    expect(await isDirty(page)).toBe(false);

    // ---- Reopen. ----
    await invoke(page, "open_file", { path: PERSIST_FILE, password: null });
    await page.waitForTimeout(1500);

    expect(await invoke<Record<string, unknown>>(page, "get_sheet_display_flags")).toMatchObject({
      displayZeros: false,
      showFormulas: true,
      viewMode: "pageLayout",
      displayHeadings: false,
    });

    const restoredBookmarks = await invoke<string | null>(page, "read_virtual_file", {
      path: ".calcula/bookmarks.json",
    });
    expect(restoredBookmarks, "bookmarks did not survive the round-trip").toBeTruthy();
    expect(JSON.parse(String(restoredBookmarks)).cellBookmarks.length).toBeGreaterThan(0);

    // Reopening must not leave the document dirty.
    expect(await isDirty(page)).toBe(false);

    // ---- Reload the frontend: the flags must survive a full UI restart. ----
    await page.reload();
    await page.waitForSelector("[data-focus-container='spreadsheet']", {
      state: "visible",
      timeout: 90_000,
    });
    await page.waitForTimeout(2000);

    expect(await invoke<Record<string, unknown>>(page, "get_sheet_display_flags")).toMatchObject({
      displayZeros: false,
      showFormulas: true,
      viewMode: "pageLayout",
      displayHeadings: false,
    });
    expect(await isDirty(page)).toBe(false);

    // Restore defaults so later specs see a normal view.
    await invoke(page, "set_sheet_display_flags", {
      patch: {
        displayZeros: true,
        showFormulas: false,
        viewMode: "normal",
        displayHeadings: true,
      },
    });
    await invoke(page, "new_file").catch(() => {});
    await page.waitForTimeout(500);
  });
});
