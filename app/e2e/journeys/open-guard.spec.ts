/**
 * F3 (§3ba) THROUGH THE REAL UI — File ▸ Open asks before it discards unsaved
 * work, and it asks BEFORE the picker.
 *
 * WHAT WAS WRONG. `fileNew` and the window-close handler both guarded on
 * `workspace.isModified()`; `fileOpen` did not. Opening replaces the whole
 * document AND resets the undo stack, so a single Ctrl+O threw away unsaved work
 * with no prompt and nothing to undo — the one document-replacing gesture in the
 * app that did not ask.
 *
 * THE ORDER IS PART OF THE FIX, and it is the half a naive version loses. Asking
 * AFTER the picker makes the user choose a file and only then learn that the
 * choice costs them their edits. So this spec asserts not just that a prompt
 * appears, but that the FIRST native window raised by File ▸ Open is the prompt
 * and not a file dialog.
 *
 * BOTH ANSWERS ARE DRIVEN. Cancel must leave the document exactly as it was —
 * same file, same edit, still dirty — and Ok must go on to the picker and really
 * open the other workbook. A guard that always refused would pass the first test
 * and fail the second; one that never fired would do the opposite.
 *
 * NATIVE DIALOGS. `confirmAsync` raises a real Win32 dialog through
 * `tauri-plugin-dialog`; Tauri's IPC surface is non-writable, so it can be
 * neither stubbed nor observed from inside the page. Both helpers below drive it
 * from OUTSIDE: `e2e/answer-native-dialog.ps1` (shared, reads the text through
 * UI Automation) and a small picker driver, the same one
 * `undo-across-open.spec.ts` uses.
 *
 * WHY A JOURNEY. It opens documents through the real File menu, which ends in
 * `window.location.reload()`.
 *
 * GRID REAL ESTATE. One cell, `EQ5`, in workbooks this spec creates itself.
 *
 * LOCALE. sv-SE. Nothing here is a formula.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef, type GridHelper } from "../helpers/grid";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_DRIVER = path.join(HERE, "..", "answer-native-dialog.ps1");

const WORK = path.join(os.tmpdir(), "calcula-open-guard");
const PICKER_PS1 = path.join(WORK, "answer-file-picker.ps1");
const FILE_ALPHA = path.join(WORK, "alpha.cala");
const FILE_BRAVO = path.join(WORK, "bravo.cala");

const CELL = "EQ5";
const ALPHA_VALUE = "ALPHA-SAVED";
const BRAVO_VALUE = "BRAVO-SAVED";
const UNSAVED_EDIT = "EDIT-THAT-MUST-SURVIVE-CANCEL";

/** The title `fileOpen` gives its prompt. */
const PROMPT_TITLE = "Unsaved changes";

// ---------------------------------------------------------------------------
// The file picker. Finds any visible #32770 owned by app.exe and looks for its
// file-name Edit box. A FILE DIALOG has one; a message box does not — that is
// how the two are told apart from outside the app, and it is how this spec
// asserts that no picker has been raised yet.
//
// EVERY TEST CLEANS UP AFTER ITSELF, and that is not tidiness. A file picker
// left open is OWNED BY THE APP and survives into every later spec: a run that
// aborted here once left TWELVE stacked "Öppna" dialogs behind, and everything
// downstream then measured the debris instead of the product. `afterEach`
// dismisses whatever is still up.
// ---------------------------------------------------------------------------

const PICKER_SCRIPT = `
param([string]$Path = "", [switch]$Cancel, [switch]$Probe)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Pick {
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
$cb = [Pick+EnumProc]{
  param($hWnd, $lParam)
  $p = 0
  [Pick]::GetWindowThreadProcessId($hWnd, [ref]$p) | Out-Null
  if ($procIds -contains [int]$p) {
    $cls = New-Object System.Text.StringBuilder 256
    [Pick]::GetClassName($hWnd, $cls, 256) | Out-Null
    if ($cls.ToString() -eq "#32770" -and [Pick]::IsWindowVisible($hWnd)) { $script:dialog = $hWnd; return $false }
  }
  return $true
}
[Pick]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($dialog -eq [IntPtr]::Zero) { Write-Output "NODIALOG"; exit 0 }
$edit = [IntPtr]::Zero
$ecb = [Pick+EnumProc]{
  param($hWnd, $lParam)
  $cls = New-Object System.Text.StringBuilder 256
  [Pick]::GetClassName($hWnd, $cls, 256) | Out-Null
  if ($cls.ToString() -eq "Edit" -and [Pick]::IsWindowVisible($hWnd)) { $script:edit = $hWnd; return $false }
  return $true
}
[Pick]::EnumChildWindows($dialog, $ecb, [IntPtr]::Zero) | Out-Null
if ($edit -eq [IntPtr]::Zero) { Write-Output "NOPICKER"; exit 0 }
if ($Probe) { Write-Output "PICKER"; exit 0 }
[Pick]::SetForegroundWindow($dialog) | Out-Null
Start-Sleep -Milliseconds 250
if ($Cancel) {
  [Pick]::PostMessageW($dialog, 0x0111, [IntPtr]2, [IntPtr]::Zero) | Out-Null
  Write-Output ("OK " + [int64]$dialog)
  exit 0
}
[Pick]::SendMessageW($edit, 0x000C, [IntPtr]::Zero, $Path) | Out-Null
Start-Sleep -Milliseconds 250
[Pick]::PostMessageW($dialog, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null
Write-Output ("OK " + [int64]$dialog)
`;

/**
 * "PICKER"   — a file dialog is open (a #32770 with a file-name Edit child).
 * "NOPICKER" — a native dialog is open but it is NOT a file dialog (a message
 *              box has no Edit child; that is how the two are told apart from
 *              outside the app).
 * "NODIALOG" — no native dialog at all.
 *
 * The distinction that matters here is PICKER vs. not-PICKER. The unsaved-changes
 * prompt is an rfd TASKDIALOG whose presence is established through the shared
 * UIA driver instead, because Win32 text APIs cannot read a DirectUI body.
 */
type PickerVerdict = "NODIALOG" | "NOPICKER" | "PICKER" | string;

function runPicker(args: string[]): PickerVerdict {
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PICKER_PS1, ...args],
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
  } catch (err) {
    return `PSERROR ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** What kind of native window, if any, the app currently has open. */
function probeNativeWindow(): PickerVerdict {
  return runPicker(["-Probe"]);
}

/** Answer the picker with a path. THROWS if it never appears. */
async function answerPickerWhenRaised(page: Page, filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    await page.waitForTimeout(400);
    const result = runPicker(["-Path", filePath]);
    if (result.startsWith("OK")) return;
    if (result.startsWith("PSERROR")) throw new Error(`picker driver failed: ${result}`);
  }
  throw new Error("the native file picker never appeared");
}

// ---------------------------------------------------------------------------
// The shared native-dialog driver (message boxes).
// ---------------------------------------------------------------------------

/**
 * Poll until the unsaved-changes prompt is on screen, and return its text.
 *
 * The prompt's presence is established through UI AUTOMATION, not through the
 * window walk above: rfd raises a TASKDIALOG whose body is DirectUI, so Win32
 * text APIs report nothing for it. Returns "" when it never appears.
 */
function readPromptWhenRaised(timeoutMs = 15_000): string {
  const deadline = Date.now() + timeoutMs;
  do {
    const seen = driveNativeDialog(PROMPT_TITLE, "read", 2000);
    if (seen.text.trim() !== "") return seen.text;
  } while (Date.now() < deadline);
  return "";
}

function driveNativeDialog(
  titleLike: string,
  action: "ok" | "cancel" | "read",
  waitMs = 20_000,
): { text: string; verdict: string } {
  if (!fs.existsSync(DIALOG_DRIVER)) {
    throw new Error(
      `the native-dialog driver is missing at ${DIALOG_DRIVER} — this spec cannot ` +
        `tell "no prompt appeared" from "nothing looked"`,
    );
  }
  let out: string;
  try {
    out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        DIALOG_DRIVER,
        "-TitleLike",
        titleLike,
        "-Action",
        action,
        "-TimeoutMs",
        String(waitMs),
      ],
      { encoding: "utf-8", timeout: 60_000 },
    );
  } catch (e) {
    out = `DRIVERERROR:${String(e)}`;
  }
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return {
    text: lines.filter((l) => l.startsWith("TEXT:")).map((l) => l.slice(5)).join(" "),
    verdict: lines.find((l) => !l.startsWith("TEXT:")) ?? lines.join("|"),
  };
}

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

async function cellDisplay(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const cells = await invoke<Array<{ row: number; col: number; display: string }>>(
    page,
    "get_viewport_cells",
    { startRow: row, startCol: col, endRow: row, endCol: col },
  );
  return String(cells[0]?.display ?? "");
}

async function currentFile(page: Page): Promise<string | null> {
  const p = await invoke<string | null>(page, "get_current_file_path");
  return p === null ? null : path.resolve(p).toLowerCase();
}

async function isDirty(page: Page): Promise<boolean> {
  return invoke<boolean>(page, "is_file_modified");
}

/** Build a fixture workbook. Setup — the gesture under test is File ▸ Open. */
async function buildFixture(page: Page, target: string, value: string): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.waitForTimeout(800);
  const { row, col } = parseCellRef(CELL);
  await invoke(page, "update_cell", { row, col, value });
  if (fs.existsSync(target)) fs.unlinkSync(target);
  await invoke(page, "save_file", { path: target });
  await expect
    .poll(() => fs.existsSync(target), { timeout: 20_000, intervals: [200] })
    .toBe(true);
}

/** Click one item of the OPEN File menu, resolved by WHOLE label. */
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
}

async function waitForAppReady(page: Page, expectedPath: string): Promise<void> {
  await page.waitForSelector("[data-focus-container='spreadsheet']", {
    state: "visible",
    timeout: 120_000,
  });
  await expect
    .poll(
      async () => {
        try {
          return await currentFile(page);
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
  await page.waitForTimeout(800);
}

/** Open ALPHA and leave one unsaved edit in it. */
async function alphaWithAnUnsavedEdit(grid: GridHelper): Promise<void> {
  const page = grid.page;
  await callModule(page, "/src/core/lib/file-api.ts", "openFileAtPath", [FILE_ALPHA]);
  await page.waitForTimeout(2000);
  expect(await currentFile(page), "precondition: ALPHA must be the open document").toBe(
    path.resolve(FILE_ALPHA).toLowerCase(),
  );
  expect(await isDirty(page), "precondition: a freshly opened document is clean").toBe(false);

  await grid.navigateTo(CELL);
  await grid.typeIntoCell(UNSAVED_EDIT);
  await page.waitForTimeout(500);
  expect(await cellDisplay(page, CELL), "the edit did not reach the cell").toBe(UNSAVED_EDIT);
  expect(
    await isDirty(page),
    "precondition: the document must really be modified, or there is nothing for " +
      "the guard to protect and the prompt would correctly never appear",
  ).toBe(true);
}

// ===========================================================================

test.describe.serial("F3 — File ▸ Open asks before discarding unsaved work", () => {
  test.beforeAll(async () => {
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(PICKER_PS1, PICKER_SCRIPT, "utf-8");
  });

  test.afterEach(async ({ appPage: page }) => {
    // A file picker left open is owned by the app and outlives this spec. See
    // the header: an aborted run once left twelve of them stacked, and every
    // later spec measured the debris. Dismiss both kinds, repeatedly, until the
    // app has no native window left.
    for (let attempt = 0; attempt < 15; attempt++) {
      const seen = probeNativeWindow();
      if (seen === "NODIALOG") break;
      if (seen === "PICKER") runPicker(["-Cancel"]);
      else driveNativeDialog(PROMPT_TITLE, "cancel", 1500);
      await page.waitForTimeout(400);
    }
  });

  test.beforeEach(async ({ appPage: page }) => {
    // Any native window left by a previous attempt would answer this test's
    // prompt for it.
    for (let attempt = 0; attempt < 15; attempt++) {
      const seen = probeNativeWindow();
      if (seen === "NODIALOG") break;
      if (seen === "PICKER") runPicker(["-Cancel"]);
      else driveNativeDialog(PROMPT_TITLE, "cancel", 1500);
      await page.waitForTimeout(400);
    }
    expect(
      probeNativeWindow(),
      "a native dialog from an earlier run is still open; it would answer this " +
        "test's question for it",
    ).toBe("NODIALOG");
  });

  // =========================================================================
  // 1. THE PROMPT COMES FIRST, AND CANCEL KEEPS EVERYTHING
  // =========================================================================
  test("the prompt precedes the picker, and Cancel leaves the document exactly as it was", async ({
    grid,
  }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    await buildFixture(page, FILE_ALPHA, ALPHA_VALUE);
    await buildFixture(page, FILE_BRAVO, BRAVO_VALUE);
    await alphaWithAnUnsavedEdit(grid);

    // ---- THE GESTURE.
    await grid.openMenu("File");
    await clickFileMenuItem(page, "Open...");

    // ---- (a) THE PROMPT IS UP, read out of the dialog itself by UI Automation.
    const promptText = readPromptWhenRaised();
    expect(
      promptText.toLowerCase(),
      "File ▸ Open on a document with unsaved changes raised no unsaved-changes " +
        "prompt within 15s — the one document-replacing gesture in the app that " +
        "used to discard work silently",
    ).toContain("unsaved changes");

    // ---- (b) AND NO FILE PICKER HAS BEEN RAISED YET.
    //
    // This is the half a naive fix loses: asking AFTER the picker makes the user
    // choose a file and only then learn the choice costs them their edits. A file
    // dialog carries a file-name Edit child; the prompt does not.
    expect(
      probeNativeWindow(),
      "the file picker was raised BEFORE the question: the user is made to choose " +
        "a file and only then told the choice will discard their unsaved work",
    ).not.toBe("PICKER");

    // ---- (c) CANCEL.
    const cancelled = driveNativeDialog(PROMPT_TITLE, "cancel");
    expect(cancelled.verdict, "the prompt's Cancel button was not clicked").toMatch(/^CLICKED:/);
    await page.waitForTimeout(2000);

    // ---- (d) NOTHING WAS TAKEN AWAY, AND NO PICKER FOLLOWED.
    expect(
      probeNativeWindow(),
      "cancelling the prompt went on to raise the file picker anyway",
    ).not.toBe("PICKER");
    expect(
      await currentFile(page),
      "cancelling the unsaved-changes prompt still replaced the document",
    ).toBe(path.resolve(FILE_ALPHA).toLowerCase());
    expect(
      await cellDisplay(page, CELL),
      "cancelling the prompt cost the user the edit the prompt was protecting",
    ).toBe(UNSAVED_EDIT);
    expect(
      await isDirty(page),
      "the document is no longer marked modified, so the next gesture will not ask",
    ).toBe(true);
  });

  // =========================================================================
  // 2. AND CONFIRMING REALLY OPENS THE OTHER WORKBOOK
  // =========================================================================
  test("confirming the prompt goes on to the picker and opens the chosen file", async ({
    grid,
  }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    await alphaWithAnUnsavedEdit(grid);

    await grid.openMenu("File");
    await clickFileMenuItem(page, "Open...");

    expect(
      readPromptWhenRaised().toLowerCase(),
      "the unsaved-changes prompt did not appear, so this test would be proving " +
        "nothing about the guard",
    ).toContain("unsaved changes");
    const confirmed = driveNativeDialog(PROMPT_TITLE, "ok");
    expect(confirmed.verdict, "the prompt's Ok button was not clicked").toMatch(/^CLICKED:/);

    // ---- The picker follows, and the open really happens.
    await answerPickerWhenRaised(page, FILE_BRAVO);
    await waitForAppReady(page, FILE_BRAVO);

    expect(
      await cellDisplay(page, CELL),
      "the confirmed open did not actually replace the document — a guard that " +
        "refuses everything would pass test 1 and fail here",
    ).toBe(BRAVO_VALUE);
    expect(
      await isDirty(page),
      "a freshly opened document must be clean",
    ).toBe(false);
  });

  // =========================================================================
  // 3. AND A CLEAN DOCUMENT IS NOT INTERROGATED
  // =========================================================================
  test("with nothing unsaved, File ▸ Open goes straight to the picker", async ({ grid }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    await callModule(page, "/src/core/lib/file-api.ts", "openFileAtPath", [FILE_ALPHA]);
    await page.waitForTimeout(2000);
    expect(
      await isDirty(page),
      "precondition: the document must be CLEAN for this test to mean anything",
    ).toBe(false);

    await grid.openMenu("File");
    await clickFileMenuItem(page, "Open...");

    // The picker must come up with no question asked — the guard must not have
    // become an unconditional nag.
    let seen: PickerVerdict = "NODIALOG";
    for (let attempt = 0; attempt < 40 && seen !== "PICKER"; attempt++) {
      await page.waitForTimeout(300);
      seen = probeNativeWindow();
    }
    expect(
      seen,
      "File ▸ Open on a CLEAN document never reached the file picker",
    ).toBe("PICKER");
    expect(
      driveNativeDialog(PROMPT_TITLE, "read", 2000).text,
      "a CLEAN document was interrogated about unsaved changes it does not have",
    ).toBe("");
  });
});
