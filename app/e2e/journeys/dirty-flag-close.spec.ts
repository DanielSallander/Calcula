/**
 * THE CLOSE PROMPT, for real.
 *
 * The unsaved-changes prompt is a NATIVE dialog (`ask()` -> rfd -> Win32
 * TaskDialog), and the handler that raises it ends in
 * `getCurrentWindow().destroy()`. Tauri defines its whole IPC surface with
 * `Object.defineProperty(window.__TAURI_INTERNALS__, 'invoke', { value })` —
 * writable:false, configurable:false — and `__TAURI_INTERNALS__` itself is
 * defined the same way on `window`. So the dialog CANNOT be stubbed, answered or
 * observed from inside the page: any interception is a silent no-op.
 *
 * This spec therefore asserts on what a user would actually see, from OUTSIDE
 * the app:
 *   - does a NEW native top-level window appear (the prompt), and
 *   - does the app process survive the close request (blocked) or exit (closed)?
 *
 * Answering the prompt always ends in `destroy()`, so each case consumes one app
 * lifetime. The case is selected by CLOSE_CASE=dirty|clean and the runner
 * relaunches the app between them.
 *
 *   CLOSE_CASE=dirty  a CF rule added through the real dialog -> prompt appears,
 *                     close is BLOCKED (before the fix: no prompt, work lost)
 *   CLOSE_CASE=clean  a just-saved workbook -> NO prompt, the app closes
 *
 * The pair matters: without the clean case, "a window appeared" could be
 * anything; without the dirty case, "no window appeared" could be a broken probe.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as os from "os";
import * as path from "path";

const CASE = process.env.CLOSE_CASE ?? "dirty";
const WINDOW_LISTER = path.join(
  os.homedir(),
  "AppData",
  "Local",
  "Temp",
  "claude",
  "c--Dropbox-Projekt-Calcula",
  "ffc06ccd-ce77-42f8-bee3-71899bcec1e9",
  "scratchpad",
  "list-app-windows.ps1",
);
const BASE_FILE = path.join(os.tmpdir(), "calcula-dirty-close.cala");

interface AppWindow {
  pid: number;
  hwnd: number;
  class: string;
  title: string;
  visible: boolean;
}

/** Enumerate every top-level window owned by a running `app.exe`. */
function listAppWindows(): AppWindow[] {
  let out = "";
  try {
    out = execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WINDOW_LISTER],
      { encoding: "utf-8", timeout: 30_000 },
    );
  } catch {
    return [];
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as AppWindow);
}

/** True while any Calcula app.exe process is running. */
function appIsRunning(): boolean {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "@(Get-Process -Name app -ErrorAction SilentlyContinue).Count",
      ],
      { encoding: "utf-8", timeout: 30_000 },
    );
    return Number(out.trim()) > 0;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

/**
 * Windows that are NOT part of the app's steady state. The main window is
 * "Tauri Window"; the rest of the baseline is IME/message-only plumbing.
 */
function extraWindows(windows: AppWindow[]): AppWindow[] {
  const baseline = new Set([
    "Tauri Window",
    "Tao Thread Event Target",
    "MSCTFIME UI",
    "IME",
  ]);
  return windows.filter((w) => !baseline.has(w.class));
}

test.describe.serial(`Close prompt (CLOSE_CASE=${CASE})`, () => {
  // This spec ENDS the app lifetime by design, so it must never run as part of
  // an ordinary functional sweep — it would kill the app for every spec after
  // it. Opt in explicitly with CLOSE_CASE=dirty|clean.
  test.skip(!process.env.CLOSE_CASE, "set CLOSE_CASE=dirty|clean to run the close-prompt journey");

  test(`a ${CASE} document ${CASE === "dirty" ? "prompts and blocks the close" : "closes with no prompt"}`, async ({
    grid,
  }) => {
    test.setTimeout(180_000);
    const page = grid.page;

    // ---- Baseline: the app is up and shows only its steady-state windows. ----
    expect(appIsRunning(), "app.exe is not running").toBe(true);
    const before = listAppWindows();
    expect(before.length, "no app windows found — is the window lister working?").toBeGreaterThan(0);
    expect(
      extraWindows(before).map((w) => `${w.class}:${w.title}`),
      "an unexpected native window was already open before the close",
    ).toEqual([]);

    // ---- Set up the document state for this case. ----
    await grid.setCellValueDirect("AE1", "10");
    await grid.setCellValueDirect("AE2", "50");
    await grid.setCellValueDirect("AE3", "90");
    await invoke(page, "save_file", { path: BASE_FILE });
    await page.waitForTimeout(500);
    expect(await invoke<boolean>(page, "is_file_modified")).toBe(false);

    if (CASE === "dirty") {
      // The census's flagship example, through the real menu and real dialog.
      await grid.selectRange("AE1", "AE3");
      await grid.openMenu("Format");
      await grid.hoverMenuItem("Conditional Formatting");
      await grid.hoverMenuItem("Highlight Cells Rules");
      await grid.clickMenuItem("Greater Than");
      await expect(page.locator("text=GREATER THAN").first()).toBeVisible({ timeout: 8000 });
      await page.locator('input[type="text"]:visible').last().fill("50");
      await page.locator("button").filter({ hasText: /^OK$/ }).last().click();
      await page.waitForTimeout(800);

      expect(await invoke<boolean>(page, "is_file_modified")).toBe(true);
    } else {
      expect(await invoke<boolean>(page, "is_file_modified")).toBe(false);
    }

    // ---- Issue a REAL close request. ----
    // Rust sees a JS listener on tauri://close-requested, so it calls
    // api.prevent_close() and hands the decision to Layout.tsx's real handler.
    // The page may die (clean case), so failures here are expected and ignored.
    page
      .evaluate(async () => {
        const w = window as unknown as {
          __TAURI__: { window: { getCurrentWindow: () => { close: () => Promise<void> } } };
        };
        await w.__TAURI__.window.getCurrentWindow().close();
      })
      .catch(() => {});

    // ---- Observe from OUTSIDE the app. ----
    let promptSeen: AppWindow | null = null;
    let exited = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      if (!appIsRunning()) {
        exited = true;
        break;
      }
      const extras = extraWindows(listAppWindows()).filter((w) => w.visible);
      if (extras.length > 0) {
        promptSeen = extras[0];
        break;
      }
    }

    if (CASE === "dirty") {
      // THE HEADLINE: the prompt is really on screen and the close is blocked.
      expect(promptSeen, "no native prompt window appeared for a dirty document").not.toBeNull();
      expect(exited, "the app exited without prompting — the work would be lost").toBe(false);

      // It is a dialog window (Win32 dialog class), owned by the app.
      expect(promptSeen!.class).toBe("#32770");

      // Still blocked a moment later: this is a modal prompt, not a flicker.
      await sleep(3000);
      expect(appIsRunning(), "the app closed while the prompt was up").toBe(true);

      // Clean up: the prompt owns the UI thread, so end this app lifetime here.
      // The runner relaunches for the next case.
      try {
        execFileSync(
          "powershell",
          ["-NoProfile", "-Command", "Get-Process -Name app -ErrorAction SilentlyContinue | Stop-Process -Force"],
          { encoding: "utf-8", timeout: 30_000 },
        );
      } catch { /* already gone */ }
    } else {
      // THE CONTROL: a clean document must close silently.
      expect(
        promptSeen,
        `a native prompt appeared for a CLEAN document: ${JSON.stringify(promptSeen)}`,
      ).toBeNull();
      expect(exited, "the app did not close even though the document was clean").toBe(true);
    }
  });
});
