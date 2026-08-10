//! FILENAME: app/e2e/journeys/undo-across-open.spec.ts
// PURPOSE: Prove defect 4a (§2x) is dead THROUGH THE REAL UI, on the saved bytes.
//
// WHAT THIS ADDS OVER `document-store-leak.spec.ts`
//   That spec pins the same defect at the STORE level: it drives `open_file`,
//   `update_cell` and `undo` as Tauri commands. This one drives the gestures a
//   user actually performs — the File menu, the NATIVE file picker, typing into
//   the grid, the ribbon's own Undo button and Ctrl+Z on the grid container —
//   and reads the answer out of the ZIP on disk. The difference is not
//   decoration: the real path runs `fileOpen()`, which calls
//   `window.location.reload()` after a successful open. The frontend is
//   therefore rebuilt from scratch between the edit and the undo, and the whole
//   question of §2x is what the BACKEND still holds across that boundary. A
//   command-level test cannot see the reload at all.
//
// THE ORACLE IS THE ARCHIVE. `calaText` parses the `.cala` ZIP here in the spec
// and THROWS on any parse failure. Every corruption assertion below is a
// `not.toContain`, and a parser that returned "" on failure would satisfy all of
// them on a file it never opened. Precedent: `document-store-leak.spec.ts` and
// `image-ingress.spec.ts`.
//
// PRECONDITIONS ARE ASSERTED FIRST, EVERY TIME. The register records that the
// first version of the store-level acceptance test passed on a demonstrably
// broken build because its probe edited a cell the two workbooks agreed about.
// So: the two fixtures are proved DIFFERENT in their bytes, the edit is proved
// to have registered as an undo entry, and the freshly-opened document is proved
// to be the one on screen — before anything is asserted about corruption.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { GridHelper } from "../helpers/grid";

const WORK = path.join(os.tmpdir(), "calcula-undo-across-open");
/** The PowerShell helper that answers the native file picker; written at setup. */
const DIALOG_PS1 = path.join(WORK, "answer-file-dialog.ps1");

const FILE_ALPHA = path.join(WORK, "alpha.cala");
const FILE_BRAVO = path.join(WORK, "bravo.cala");
const FILE_SPILL_ALPHA = path.join(WORK, "spill-alpha.cala");
const FILE_SPILL_BRAVO = path.join(WORK, "spill-bravo.cala");

/**
 * The cell the two workbooks DISAGREE about — the register's own coordinate
 * (row 0, col 105). The whole defect is that an undo entry names bare
 * coordinates and no document, so the entry from ALPHA lands here in BRAVO.
 */
const CELL = "DB1";

const ALPHA_VALUE = "ALPHA-ORIGINAL";
const BRAVO_VALUE = "BRAVO-ORIGINAL";
const EDIT_IN_ALPHA = "ZULU-EDITED-IN-ALPHA";
const EDIT_IN_BRAVO = "YANKEE-EDITED-IN-BRAVO";

// ---------------------------------------------------------------------------
// The native file picker. Tauri's IPC surface is non-writable, so the dialog
// cannot be stubbed from inside the page — it has to be driven from outside.
// Same technique as `image-ingress.spec.ts`, which uses it for Insert > Image.
// ---------------------------------------------------------------------------

const DIALOG_SCRIPT = `
param([string]$Path = "", [switch]$Cancel)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Dlg {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] public static extern IntPtr PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@
$procIds = @(Get-Process -Name "app" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if ($procIds.Count -eq 0) { Write-Output "NODIALOG"; exit 0 }
$dialog = [IntPtr]::Zero
$cb = [Dlg+EnumProc]{
  param($hWnd, $lParam)
  $p = 0
  [Dlg]::GetWindowThreadProcessId($hWnd, [ref]$p) | Out-Null
  if ($procIds -contains [int]$p) {
    $cls = New-Object System.Text.StringBuilder 256
    [Dlg]::GetClassName($hWnd, $cls, 256) | Out-Null
    if ($cls.ToString() -eq "#32770" -and [Dlg]::IsWindowVisible($hWnd)) { $script:dialog = $hWnd; return $false }
  }
  return $true
}
[Dlg]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($dialog -eq [IntPtr]::Zero) { Write-Output "NODIALOG"; exit 0 }
[Dlg]::SetForegroundWindow($dialog) | Out-Null
Start-Sleep -Milliseconds 250
if ($Cancel) {
  [Dlg]::PostMessageW($dialog, 0x0111, [IntPtr]2, [IntPtr]::Zero) | Out-Null
  Write-Output ("OK " + [int64]$dialog)
  exit 0
}
$edit = [IntPtr]::Zero
$ecb = [Dlg+EnumProc]{
  param($hWnd, $lParam)
  $cls = New-Object System.Text.StringBuilder 256
  [Dlg]::GetClassName($hWnd, $cls, 256) | Out-Null
  if ($cls.ToString() -eq "Edit" -and [Dlg]::IsWindowVisible($hWnd)) { $script:edit = $hWnd; return $false }
  return $true
}
[Dlg]::EnumChildWindows($dialog, $ecb, [IntPtr]::Zero) | Out-Null
if ($edit -eq [IntPtr]::Zero) { Write-Output "NOEDIT"; exit 0 }
[Dlg]::SendMessageW($edit, 0x000C, [IntPtr]::Zero, $Path) | Out-Null
Start-Sleep -Milliseconds 250
[Dlg]::PostMessageW($dialog, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null
Write-Output ("OK " + [int64]$dialog)
`;

/** One attempt at answering the native picker. "NODIALOG" when none is open. */
function answerNativeDialog(filePath: string | null): string {
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DIALOG_PS1];
  if (filePath === null) args.push("-Cancel");
  else args.push("-Path", filePath);
  try {
    return execFileSync("powershell", args, { encoding: "utf-8", timeout: 30_000 }).trim();
  } catch (err) {
    return `PSERROR ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Poll until the app raises the native picker, then answer it. THROWS if it never appears. */
async function answerWhenRaised(page: Page, filePath: string | null): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    await page.waitForTimeout(400);
    const result = answerNativeDialog(filePath);
    if (result.startsWith("OK")) return;
    if (result.startsWith("PSERROR")) throw new Error(`dialog helper failed: ${result}`);
    if (result.startsWith("NOEDIT")) throw new Error("the file dialog has no file-name edit box");
  }
  throw new Error("the native file dialog never appeared");
}

// ---------------------------------------------------------------------------
// THE ORACLE: the archive on disk
// ---------------------------------------------------------------------------

/**
 * The DECOMPRESSED text of every entry in a `.cala`, concatenated.
 *
 * THROWS on every failure path. "I could not read it" and "it does not contain
 * that string" must never share a return value: the assertions built on this are
 * absences, and "" satisfies every one of them.
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
    throw new Error(
      `${file} has no ZIP end-of-central-directory record — it is not a plain ` +
        `.cala archive (an encrypted one would look like this)`,
    );
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

// ---------------------------------------------------------------------------
// Backend access — READ-ONLY probes and fixture setup only. Every gesture that
// is under test goes through the UI.
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

/** The backend's undo/redo state — exactly what the ribbon's buttons read. */
async function undoState(page: Page): Promise<{
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
  undoDescription: string | null;
  redoDescription: string | null;
}> {
  return invoke(page, "get_undo_state");
}

/** One cell's displayed text, read the way the grid reads it. */
async function cellDisplay(page: Page, ref: string): Promise<string> {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) throw new Error(`bad cell ref ${ref}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]) - 1;
  const cells = await invoke<Array<{ row: number; col: number; display: string }>>(
    page,
    "get_cells_in_rows",
    { startRow: row, endRow: row },
  );
  return cells.find((c) => c.row === row && c.col === col - 1)?.display ?? "";
}

/**
 * Build a fixture workbook. SETUP, never the thing under test — the gestures
 * being tested (open, edit, undo, redo, save) are all driven through the UI
 * below. `newFile` here is the app's own module function, not the raw command.
 */
async function buildFixture(
  page: Page,
  target: string,
  cells: Array<[string, string]>,
): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.waitForTimeout(700);
  for (const [ref, value] of cells) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
    if (!m) throw new Error(`bad cell ref ${ref}`);
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    await invoke(page, "update_cell", { row: Number(m[2]) - 1, col: col - 1, value });
    await page.waitForTimeout(120);
  }
  if (fs.existsSync(target)) fs.unlinkSync(target);
  await invoke(page, "save_file", { path: target });
  await expect
    .poll(() => fs.existsSync(target), { timeout: 20_000, intervals: [200] })
    .toBe(true);
}

// ---------------------------------------------------------------------------
// THE REAL UI: the File menu, the picker, the grid, the ribbon
// ---------------------------------------------------------------------------

/**
 * Click one item of the OPEN File menu, scoped to the File menu's own container.
 *
 * A page-wide `button:has-text("Save")` would also match "Save As..." (and any
 * ribbon button carrying the word), and `.first()` would silently pick whichever
 * came first in the DOM. This resolves the item by its own text and THROWS
 * unless exactly one matches — a menu click that lands on the wrong item is the
 * kind of failure that looks like a product bug.
 */
async function clickFileMenuItem(page: Page, label: string): Promise<void> {
  const container = page
    .locator("button")
    .filter({ hasText: /^File$/ })
    .first()
    .locator("xpath=..");
  const buttons = container.locator("button");
  const count = await buttons.count();
  const matches: number[] = [];
  const texts: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = ((await buttons.nth(i).innerText()) ?? "").replace(/\s+/g, " ").trim();
    texts.push(raw);
    // The item renders as "<label> <shortcut>" ("Save Ctrl+S"). Strip the
    // shortcut and compare the label WHOLE: a `startsWith` would make "Save"
    // match "Save As... Ctrl+Shift+S" as well, and picking the first of two is
    // exactly the silent mis-click this helper exists to prevent.
    const labelPart = raw.replace(/\s+(?:Ctrl|Alt|Shift)\+\S+$/, "").trim();
    if (labelPart === label) matches.push(i);
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one File-menu item "${label}", found ${matches.length}. ` +
        `Menu contents: ${JSON.stringify(texts)}`,
    );
  }
  await buttons.nth(matches[0]).click();
  await page.waitForTimeout(400);
}

/** Wait for the frontend to come back after `fileOpen`'s `window.location.reload()`. */
async function waitForAppReady(page: Page, expectedPath: string | null): Promise<void> {
  await page.waitForSelector("[data-focus-container='spreadsheet']", {
    state: "visible",
    timeout: 120_000,
  });
  if (expectedPath !== null) {
    await expect
      .poll(
        async () => {
          try {
            const p = await invoke<string | null>(page, "get_current_file_path");
            return p === null ? null : path.resolve(p).toLowerCase();
          } catch {
            return "PAGE-NOT-READY";
          }
        },
        {
          timeout: 120_000,
          intervals: [500],
          message: "the backend never reported the opened document as the current file",
        },
      )
      .toBe(path.resolve(expectedPath).toLowerCase());
  }
  await page.waitForTimeout(800);
}

/** File ▸ Open... → the native picker → the app reloads onto the opened document. */
async function openThroughFileMenu(grid: GridHelper, target: string): Promise<void> {
  const page = grid.page;
  await grid.openMenu("File");
  await clickFileMenuItem(page, "Open...");
  await answerWhenRaised(page, target);
  await waitForAppReady(page, target);
}

/** File ▸ Save — no picker, the document already has a path. Returns when the bytes changed. */
async function saveThroughFileMenu(grid: GridHelper, target: string): Promise<void> {
  const page = grid.page;
  const before = fs.existsSync(target) ? fs.statSync(target).mtimeMs : -1;
  const beforeSize = fs.existsSync(target) ? fs.statSync(target).size : -1;
  await grid.openMenu("File");
  await clickFileMenuItem(page, "Save");
  await expect
    .poll(
      () => {
        if (!fs.existsSync(target)) return "missing";
        const st = fs.statSync(target);
        return st.mtimeMs !== before || st.size !== beforeSize ? "written" : "unchanged";
      },
      {
        timeout: 30_000,
        intervals: [250],
        message: `File > Save never rewrote ${target}`,
      },
    )
    .toBe("written");
  await page.waitForTimeout(400);
}

/** Type a value into a cell through the real inline editor. */
async function typeIntoCell(grid: GridHelper, ref: string, value: string): Promise<void> {
  await grid.navigateTo(ref);
  await grid.typeIntoCell(value);
  await grid.page.waitForTimeout(300);
}

/**
 * Press the ribbon's own Undo / Redo button — the OTHER gesture, alongside
 * Ctrl+Z on the grid. Both routes are tested because they are different code
 * paths (a registered command vs. the grid's key handler) and a user reaches for
 * either one.
 *
 * THROWS when the button is not on the ribbon: "I could not find it" must never
 * read as "the gesture was harmless".
 *
 * MEASURED, and worth stating because it is why this helper does not assert a
 * disabled state: Calcula's Undo/Redo affordances are NEVER disabled. The Home
 * tab renders them as plain buttons with no binding to `get_undo_state`, and the
 * Edit menu item has no enablement either. So the button is pressable on a
 * freshly-opened document with an empty stack — which is precisely why what the
 * press DOES is the thing that has to be pinned.
 */
async function pressRibbon(page: Page, which: "undo" | "redo"): Promise<void> {
  const btn = page.locator(`[data-testid="fmt-${which}"]`).first();
  if ((await btn.count()) === 0) {
    throw new Error(`the ribbon has no [data-testid="fmt-${which}"] button`);
  }
  await btn.click();
  await page.waitForTimeout(600);
}

// ---------------------------------------------------------------------------

test.describe("§2x through the real UI: the undo stack dies with its document", () => {
  test.beforeAll(() => {
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(DIALOG_PS1, DIALOG_SCRIPT, "utf-8");
  });

  // =========================================================================
  // 1. THE 4a REPRODUCTION — File ▸ Open, one Ctrl+Z, and the bytes
  // =========================================================================
  test("File > Open then ONE Ctrl+Z: the opened workbook's own value is what gets saved", async ({
    grid,
  }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    // ---- Fixtures (setup) ----
    await buildFixture(page, FILE_ALPHA, [[CELL, ALPHA_VALUE]]);
    await buildFixture(page, FILE_BRAVO, [[CELL, BRAVO_VALUE]]);

    // ---- PRECONDITION A: the two workbooks really disagree about THIS cell.
    // Without this the whole test could run against two identical fixtures and
    // assert nothing at all.
    const alphaBytes = calaText(FILE_ALPHA);
    const bravoBytes = calaText(FILE_BRAVO);
    expect(alphaBytes, "ALPHA must contain its own value").toContain(ALPHA_VALUE);
    expect(alphaBytes, "ALPHA must not already contain BRAVO's value").not.toContain(BRAVO_VALUE);
    expect(bravoBytes, "BRAVO must contain its own value").toContain(BRAVO_VALUE);
    expect(bravoBytes, "BRAVO must not already contain ALPHA's value").not.toContain(ALPHA_VALUE);

    // ---- Open ALPHA through File ▸ Open (native picker, then a full reload).
    await openThroughFileMenu(grid, FILE_ALPHA);
    expect(
      await cellDisplay(page, CELL),
      "precondition: ALPHA really is the document on screen",
    ).toBe(ALPHA_VALUE);

    // ---- Edit it, by typing into the grid. SAME CELL the two disagree about:
    // that is what makes the leaked entry visible in the bytes rather than
    // merely wrong. (The register records a version of this test that edited a
    // different cell and passed on a demonstrably broken build.)
    await typeIntoCell(grid, CELL, EDIT_IN_ALPHA);

    // ---- PRECONDITION B: the edit really registered as undoable history.
    expect(await cellDisplay(page, CELL), "the typed edit did not reach the cell").toBe(
      EDIT_IN_ALPHA,
    );
    const inAlpha = await undoState(page);
    expect(
      inAlpha.canUndo,
      "the edit in ALPHA produced no undo entry, so every absence asserted below " +
        "would pass on a stack that was never populated",
    ).toBe(true);
    expect(inAlpha.undoDepth, "ALPHA's stack must hold the edit just made").toBeGreaterThan(0);

    // ---- File ▸ Open BRAVO. The document on screen has never been edited.
    await openThroughFileMenu(grid, FILE_BRAVO);
    expect(await cellDisplay(page, CELL), "precondition: BRAVO is the document on screen").toBe(
      BRAVO_VALUE,
    );

    // ---- THE STORE-LEVEL ANSWER.
    //
    // SOFT, DELIBERATELY. A hard assertion here would abort a leaking build
    // before the gesture ran, and the byte oracle — the only place the damage is
    // permanent — would never be reached. The register records exactly this:
    // the store-level guard had to be relaxed by hand to see `ALPHA-ORIGINAL`
    // land in the saved archive. `expect.soft` still fails the test; it just
    // does not stop it, so a sabotaged build reports the store leak AND the
    // corrupted bytes in one run. The archive assertions below stay HARD.
    const inBravo = await undoState(page);
    expect
      .soft(
        inBravo.canUndo,
        `the freshly-opened workbook offers an undo it has not earned (depth ` +
          `${inBravo.undoDepth}, "${inBravo.undoDescription ?? ""}"). The stack belongs ` +
          `to a workbook that is no longer open, and its entries name bare ` +
          `(sheet, row, col) coordinates — applying one here overwrites a cell of ` +
          `THIS document with a value from THAT one`,
      )
      .toBe(false);
    expect.soft(inBravo.undoDepth, "a freshly-opened workbook has no undo history").toBe(0);

    // ---- THE GESTURE: one Ctrl+Z on the grid, which a user presses without
    // thinking. The Undo affordance is never disabled anywhere in this app (see
    // `pressRibbon`), so there is nothing between the user and this press.
    await grid.undo();
    await page.waitForTimeout(400);

    expect
      .soft(
        await cellDisplay(page, CELL),
        "one Ctrl+Z after File > Open replaced the open workbook's cell with the " +
          "PREVIOUS workbook's value",
      )
      .toBe(BRAVO_VALUE);

    // ---- AND THE BYTES, where the damage becomes permanent. File ▸ Save
    // writes BRAVO in place — no picker, exactly what a user does next.
    //
    // The save happens after exactly ONE undo, deliberately: a second undo pops
    // a second leaked entry and can leave the cell EMPTY instead, which is a
    // different (and weaker-looking) corruption. One Ctrl+Z is the register's
    // reproduction and it is the one that puts another document's value into
    // this document's archive.
    await saveThroughFileMenu(grid, FILE_BRAVO);
    const saved = calaText(FILE_BRAVO);
    expect(saved, "the saved workbook does not contain its own cell value at all").toContain(
      BRAVO_VALUE,
    );
    expect(
      saved,
      "THE 4a CORRUPTION, on disk: a workbook saved after one Ctrl+Z physically " +
        "contains a value from a DIFFERENT document, in a cell the user never touched",
    ).not.toContain(ALPHA_VALUE);
    expect(
      saved,
      "the saved workbook contains the edit that was made in the OTHER document",
    ).not.toContain(EDIT_IN_ALPHA);

    // ---- THE OTHER ROUTE TO THE SAME GESTURE: the ribbon's Undo button, which
    // runs the registered command rather than the grid's key handler. Same
    // question, second gesture, and the archive is re-read after it.
    await pressRibbon(page, "undo");
    expect
      .soft(
        await cellDisplay(page, CELL),
        "the ribbon's Undo button after File > Open replaced the open workbook's " +
          "cell with the PREVIOUS workbook's value",
      )
      .toBe(BRAVO_VALUE);

    await saveThroughFileMenu(grid, FILE_BRAVO);
    const savedAfterRibbon = calaText(FILE_BRAVO);
    expect(
      savedAfterRibbon,
      "after the ribbon's Undo button the saved workbook no longer contains its " +
        "own cell value",
    ).toContain(BRAVO_VALUE);
    expect(
      savedAfterRibbon,
      "the ribbon's Undo button put a DIFFERENT document's value into these bytes",
    ).not.toContain(ALPHA_VALUE);
    expect(
      savedAfterRibbon,
      "the ribbon's Undo button put the other document's EDIT into these bytes",
    ).not.toContain(EDIT_IN_ALPHA);
  });

  // =========================================================================
  // 2. THE COUNTERWEIGHT — undo must still work INSIDE a document
  // =========================================================================
  test("undo still works within one document, and the undone value is what gets saved", async ({
    grid,
  }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    await buildFixture(page, FILE_BRAVO, [[CELL, BRAVO_VALUE]]);
    await openThroughFileMenu(grid, FILE_BRAVO);
    expect(await cellDisplay(page, CELL), "precondition: BRAVO is on screen").toBe(BRAVO_VALUE);

    // A freshly opened document starts with no history — that is test 1's
    // guarantee, and here it is the baseline the edit is measured against.
    expect((await undoState(page)).undoDepth, "a freshly-opened document starts empty").toBe(0);

    await typeIntoCell(grid, CELL, EDIT_IN_BRAVO);
    expect(await cellDisplay(page, CELL), "the typed edit did not reach the cell").toBe(
      EDIT_IN_BRAVO,
    );
    const afterEdit = await undoState(page);
    expect(afterEdit.canUndo, "an edit inside the open document must be undoable").toBe(true);
    expect(afterEdit.undoDepth).toBe(1);

    // THE RIBBON'S OWN BUTTON, deliberately — test 1 presses Ctrl+Z, so between
    // them both routes are shown to work on the document that owns the history.
    await pressRibbon(page, "undo");

    expect(
      await cellDisplay(page, CELL),
      "Ctrl+Z inside the document did NOT undo the document's own edit — a fix " +
        "that bought test 1 by disabling undo would be worse than the defect",
    ).toBe(BRAVO_VALUE);
    expect((await undoState(page)).canRedo, "the undone edit must be redoable").toBe(true);

    await saveThroughFileMenu(grid, FILE_BRAVO);
    const saved = calaText(FILE_BRAVO);
    expect(saved, "the undone document must save its restored value").toContain(BRAVO_VALUE);
    expect(saved, "the undone edit must not be in the saved bytes").not.toContain(EDIT_IN_BRAVO);
  });

  // =========================================================================
  // 3. THE REDO STACK — the same question, the other half
  // =========================================================================
  test("File > Open then ONE Ctrl+Y: the opened workbook keeps its own value", async ({ grid }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    await buildFixture(page, FILE_ALPHA, [[CELL, ALPHA_VALUE]]);
    await buildFixture(page, FILE_BRAVO, [[CELL, BRAVO_VALUE]]);

    // Build a REDO entry in ALPHA: edit, then undo it. The redo entry now holds
    // "ZULU-EDITED-IN-ALPHA" at this coordinate, with no document identity.
    await openThroughFileMenu(grid, FILE_ALPHA);
    await typeIntoCell(grid, CELL, EDIT_IN_ALPHA);
    expect(await cellDisplay(page, CELL), "the typed edit did not reach the cell").toBe(
      EDIT_IN_ALPHA,
    );
    await grid.undo();
    await page.waitForTimeout(400);
    expect(await cellDisplay(page, CELL), "the undo inside ALPHA did not take").toBe(ALPHA_VALUE);

    const inAlpha = await undoState(page);
    expect(
      inAlpha.canRedo,
      "PRECONDITION: ALPHA must really hold a redo entry, or the absence asserted " +
        "below is vacuous",
    ).toBe(true);
    expect(inAlpha.redoDepth).toBeGreaterThan(0);

    // File ▸ Open BRAVO.
    await openThroughFileMenu(grid, FILE_BRAVO);
    expect(await cellDisplay(page, CELL), "precondition: BRAVO is on screen").toBe(BRAVO_VALUE);

    // SOFT for the same reason as test 1: a leaking build must still reach the
    // archive, which is where the loss is permanent.
    const inBravo = await undoState(page);
    expect
      .soft(
        inBravo.canRedo,
        `the freshly-opened workbook offers a REDO it has not earned (depth ` +
          `${inBravo.redoDepth}, "${inBravo.redoDescription ?? ""}") — the same defect ` +
          `as the undo stack, on the other half of the same store`,
      )
      .toBe(false);
    expect.soft(inBravo.redoDepth, "a freshly-opened workbook has no redo history").toBe(0);

    await grid.redo();
    await page.waitForTimeout(400);

    expect
      .soft(
        await cellDisplay(page, CELL),
        "one Ctrl+Y after File > Open wrote the PREVIOUS workbook's edit into this one",
      )
      .toBe(BRAVO_VALUE);

    // The bytes after exactly ONE Ctrl+Y — same reasoning as test 1.
    await saveThroughFileMenu(grid, FILE_BRAVO);
    const saved = calaText(FILE_BRAVO);
    expect(saved, "the saved workbook does not contain its own cell value at all").toContain(
      BRAVO_VALUE,
    );
    expect(
      saved,
      "THE REDO HALF OF 4a, on disk: the other document's edit was redone into this one",
    ).not.toContain(EDIT_IN_ALPHA);
    expect(saved, "the previous document's original value reached these bytes").not.toContain(
      ALPHA_VALUE,
    );

    // And the ribbon's Redo button, the second route.
    await pressRibbon(page, "redo");
    expect
      .soft(
        await cellDisplay(page, CELL),
        "the ribbon's Redo button after File > Open wrote the PREVIOUS workbook's " +
          "edit into this one",
      )
      .toBe(BRAVO_VALUE);

    await saveThroughFileMenu(grid, FILE_BRAVO);
    const savedAfterRibbon = calaText(FILE_BRAVO);
    expect(
      savedAfterRibbon,
      "after the ribbon's Redo button the saved workbook no longer contains its " +
        "own cell value",
    ).toContain(BRAVO_VALUE);
    expect(
      savedAfterRibbon,
      "the ribbon's Redo button put the other document's edit into these bytes",
    ).not.toContain(EDIT_IN_ALPHA);
  });

  // =========================================================================
  // 4. REDO INSIDE ONE DOCUMENT — the counterweight for test 3
  // =========================================================================
  test("redo still works within one document", async ({ grid }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    await buildFixture(page, FILE_BRAVO, [[CELL, BRAVO_VALUE]]);
    await openThroughFileMenu(grid, FILE_BRAVO);

    await typeIntoCell(grid, CELL, EDIT_IN_BRAVO);
    expect(await cellDisplay(page, CELL)).toBe(EDIT_IN_BRAVO);
    await grid.undo();
    await page.waitForTimeout(400);
    expect(await cellDisplay(page, CELL), "precondition: the undo took").toBe(BRAVO_VALUE);

    // The ribbon's Redo button, deliberately — test 3 presses Ctrl+Y, so both
    // routes are shown to work on the document that owns the history.
    await pressRibbon(page, "redo");
    expect(
      await cellDisplay(page, CELL),
      "the ribbon's Redo button inside the document did NOT redo the document's " +
        "own edit",
    ).toBe(EDIT_IN_BRAVO);

    await saveThroughFileMenu(grid, FILE_BRAVO);
    expect(calaText(FILE_BRAVO), "the redone edit must be in the saved bytes").toContain(
      EDIT_IN_BRAVO,
    );
  });

  // =========================================================================
  // 5. THE SPILL NEIGHBOUR — the refusal AND the deletion, through the real UI
  // =========================================================================
  test("File > Open then edit: the previous workbook's spill neither blocks nor deletes here", async ({
    grid,
  }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    // BRAVO FIRST, deliberately: ordinary literals at exactly the coordinates
    // ALPHA's spill will cover. Building it AFTER ALPHA fails on a leaking build
    // — the setup's own `update_cell` is refused by the stale `spill_hosts`,
    // which kills the test during fixture construction and hides the DELETION
    // half entirely. (Measured on the sabotaged build: "Cannot edit cell
    // (2, 106): it contains a spilled array value from cell (1, 106)".) The
    // refusal belongs in the assertions below, not in the scaffolding.
    await buildFixture(page, FILE_SPILL_BRAVO, [
      ["DB1", "BRAVO-ONE"],
      ["DB2", "BRAVO-TWO"],
      ["DB3", "BRAVO-THREE"],
      ["DB4", "BRAVO-FOUR"],
    ]);
    // ALPHA: one dynamic-array formula spilling DB1:DB4.
    await buildFixture(page, FILE_SPILL_ALPHA, [[CELL, "=SEQUENCE(4)"]]);

    await openThroughFileMenu(grid, FILE_SPILL_ALPHA);
    expect(
      await cellDisplay(page, "DB3"),
      "VACUITY GUARD: ALPHA's SEQUENCE must really spill in this session, or no " +
        "spill map exists to leak",
    ).not.toBe("");

    await openThroughFileMenu(grid, FILE_SPILL_BRAVO);
    expect(await cellDisplay(page, "DB2"), "precondition: BRAVO is on screen").toBe("BRAVO-TWO");

    // (1) THE REFUSAL. On a leaking build `check_spill_protection` reads the
    //     stale `spill_hosts` and rejects this edit, naming a formula in a
    //     workbook that is no longer open.
    await typeIntoCell(grid, "DB2", "BRAVO-TWO-EDITED");
    // SOFT: on a leaking build the refusal fires here and a hard stop would hide
    // the DELETION half, which is the one that loses data with no undo entry.
    expect
      .soft(
        await cellDisplay(page, "DB2"),
        "editing a cell of the newly-opened workbook was refused because the " +
          "PREVIOUS workbook had a spill at that coordinate",
      )
      .toBe("BRAVO-TWO-EDITED");

    // (2) THE DELETION, which is the half that loses data. Touching the stale
    //     spill ORIGIN takes the `spill_ranges.remove(...)` branch, which runs
    //     `grid.cells.remove(...)` over every coordinate the PREVIOUS document's
    //     spill covered — cells of THIS document, with no undo entry for them
    //     (the transaction records only the cell the user actually touched).
    //
    //     TWO gestures, because they are different commands and only one of them
    //     reaches that branch. MEASURED: the Delete key does NOT — it runs
    //     `clear_range`, which checks spill protection but never removes a spill
    //     range. Overwriting the origin does, through `update_cell`. Doing only
    //     the first would have looked like a clean run on a build that leaks.
    await grid.navigateTo("DB1");
    await grid.delete();
    await page.waitForTimeout(600);
    await typeIntoCell(grid, "DB1", "=1+1");
    await page.waitForTimeout(600);

    for (const [ref, expected] of [
      ["DB2", "BRAVO-TWO-EDITED"],
      ["DB3", "BRAVO-THREE"],
      ["DB4", "BRAVO-FOUR"],
    ] as Array<[string, string]>) {
      expect
        .soft(
          await cellDisplay(page, ref),
          `clearing DB1 deleted ${ref} — a cell of the open workbook the user never ` +
            `touched, because the PREVIOUS workbook's spill map still claimed that ` +
            `coordinate. There is no undo entry for it`,
        )
        .toBe(expected);
    }

    // AND THE BYTES, hard: the cells the user never touched must still be in the
    // archive the user saves. This is where the spill leak is permanent, and it
    // is worse than the undo stack's — those cells cannot be brought back.
    await saveThroughFileMenu(grid, FILE_SPILL_BRAVO);
    const saved = calaText(FILE_SPILL_BRAVO);
    for (const value of ["BRAVO-TWO-EDITED", "BRAVO-THREE", "BRAVO-FOUR"]) {
      expect(
        saved,
        `${value} is missing from the saved archive — a cell of the open workbook ` +
          `is gone from the bytes on disk`,
      ).toContain(value);
    }
  });
});
