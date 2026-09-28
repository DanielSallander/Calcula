/**
 * THE CLOSE PROMPT'S CANCEL PATHS KEEP THE WINDOW -- proved live, on the real
 * native dialog.
 *
 * THE DEFECT. The save-before-closing prompt was a TWO-button box (Save /
 * Don't Save). A TaskDialog reads its title-bar X and the Escape key as its
 * refusing button, so X and Escape answered "Don't Save" -- and the handler in
 * `src/shell/Layout.tsx` then `destroy()`ed the window over the unsaved
 * document. Fix round 5 made it Excel's three buttons (Save / Don't Save /
 * Cancel) through `askSaveDiscardCancelAsync`, where only an explicit Save or
 * Don't Save closes, and moved the BEFORE_CLOSE teardown (which unmounts every
 * script) behind the decision, so Cancel no longer leaves the window open over a
 * torn-down script realm.
 *
 * WHY LIVE. The dialog is raised by tauri-plugin-dialog -> rfd -> a Win32
 * TaskDialog, and which label X/Escape come back as is decided by rfd's
 * IDCANCEL mapping and the plugin's relabel step -- none of which a jsdom test
 * executes. It is answered from OUTSIDE the app over Win32
 * (`e2e/answer-native-dialog.ps1`): the Cancel BUTTON by its exact label, the X
 * as WM_SYSCOMMAND/SC_CLOSE, and Escape as a key message to the dialog's own
 * modal loop -- never by position, because a positional guess on this dialog
 * presses Don't Save and destroys the app under test.
 *
 * WHAT IS ASSERTED, for each of Cancel, X and Escape:
 *   - the PROMPT really appeared (its text and all three buttons are read off
 *     the native window) -- the proof that the close request reached the
 *     handler, without which "the window is still open" proves nothing;
 *   - the answer was DELIVERED (the dialog window is destroyed), not merely
 *     sent;
 *   - the app process and its main window survive, the backend still answers,
 *     and the document is STILL DIRTY (`is_file_modified`);
 *   - BEFORE_CLOSE was never broadcast (nothing was torn down);
 *   - the NEXT close asks again (the handler's re-entrancy latch was reset --
 *     a stuck latch would make every later close a silent no-op).
 *
 * WHAT IS DELIBERATELY NOT DONE. Save and Don't Save are never pressed: both end
 * the app lifetime this whole project shares.
 *
 * ORDER. The file sorts after every journey but `zz-persisted-residue`. If the
 * defect comes back, the window is destroyed here and nothing after this file
 * can run -- so it runs where that costs only the residue guard.
 */
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_DRIVER = path.join(HERE, "..", "answer-native-dialog.ps1");
const WINDOW_LISTER = path.join(HERE, "..", "list-app-windows.ps1");
const FILE_API = "/src/core/lib/file-api.ts";

const PROMPT_TEXT = "Do you want to save changes before closing?";
const PROMPT_BUTTONS = ["Save", "Don't Save", "Cancel"];

interface AppWindow {
  __calcImport: (u: string) => Promise<unknown>;
  __TAURI__: {
    core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    window: { getCurrentWindow: () => { close: () => Promise<void> } };
  };
  __e2eBeforeClose?: number;
  __e2eBeforeCloseHooked?: boolean;
}

interface NativeWindow {
  pid: number;
  hwnd: number;
  class: string;
  title: string;
  visible: boolean;
}

interface DriverVerdict {
  raw: string;
  text: string;
  buttons: string[];
  sent: string | null;
  outcome: "GONE" | "STILLOPEN" | null;
  notFound: boolean;
}

// ---------------------------------------------------------------------------
// Outside the app: the native dialog and the process
// ---------------------------------------------------------------------------

/**
 * Answer the native prompt titled "Calcula". `button` presses the button with
 * EXACTLY that label; `close` and `escape` are the title-bar X and the Escape
 * key. Throws if the driver is missing: "no dialog" and "nothing looked" must
 * never share a result.
 */
function answerPrompt(how: { action: "button"; label: string } | { action: "close" } | { action: "escape" }, waitMs = 20_000): DriverVerdict {
  if (!fs.existsSync(DIALOG_DRIVER)) {
    throw new Error(`the native-dialog driver is missing at ${DIALOG_DRIVER}`);
  }
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    DIALOG_DRIVER,
    "-TitleLike",
    "Calcula",
    "-Action",
    how.action,
    "-TimeoutMs",
    String(waitMs),
  ];
  if (how.action === "button") args.push("-Button", how.label);
  let raw: string;
  try {
    raw = execFileSync("powershell", args, { encoding: "utf-8", timeout: waitMs + 30_000 });
  } catch (e) {
    raw = `DRIVERERROR:${String(e)}`;
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const buttonsLine = lines.find((l) => l.startsWith("BUTTONS:"));
  const outcome = lines.find((l) => l === "GONE" || l === "STILLOPEN") as DriverVerdict["outcome"] | undefined;
  return {
    raw: lines.join(" | "),
    text: lines.filter((l) => l.startsWith("TEXT:")).map((l) => l.slice(5)).join(" "),
    buttons: buttonsLine ? buttonsLine.slice("BUTTONS:".length).split("|").filter(Boolean) : [],
    sent: lines.find((l) => l.startsWith("CLICKED:") || l.startsWith("CLOSED:") || l === "ESCAPED") ?? null,
    outcome: outcome ?? null,
    notFound: lines.includes("NOTFOUND"),
  };
}

/** Every top-level window owned by app.exe. Throws when the lister could not run. */
function appWindows(): NativeWindow[] {
  if (!fs.existsSync(WINDOW_LISTER)) {
    throw new Error(`the native-window lister is missing at ${WINDOW_LISTER}`);
  }
  const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WINDOW_LISTER], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as NativeWindow);
}

function visibleDialogs(): NativeWindow[] {
  return appWindows().filter((w) => w.visible && w.class === "#32770");
}

function mainWindowVisible(): boolean {
  return appWindows().some((w) => w.visible && w.class === "Tauri Window");
}

function appIsRunning(): boolean {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", "@(Get-Process -Name app -ErrorAction SilentlyContinue).Count"], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    return Number(out.trim()) > 0;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Inside the app
// ---------------------------------------------------------------------------

/** A page call that cannot hang the test: `page.evaluate` has no timeout of its own. */
async function bounded<T>(label: string, p: Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: no answer within ${ms} ms -- is the app blocked by a native prompt?`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function isDirty(page: Page): Promise<boolean> {
  return bounded(
    "is_file_modified",
    page.evaluate(async () => (await (window as unknown as AppWindow).__TAURI__.core.invoke("is_file_modified")) as boolean),
  );
}

async function beforeCloseCount(page: Page): Promise<number> {
  return bounded("BEFORE_CLOSE counter", page.evaluate(() => (window as unknown as AppWindow).__e2eBeforeClose ?? -1));
}

/** Count `app:before-close` broadcasts from here on (the event is a window CustomEvent). */
async function hookBeforeClose(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as AppWindow;
    w.__e2eBeforeClose = 0;
    if (!w.__e2eBeforeCloseHooked) {
      window.addEventListener("app:before-close", () => {
        w.__e2eBeforeClose = (w.__e2eBeforeClose ?? 0) + 1;
      });
      w.__e2eBeforeCloseHooked = true;
    }
  });
}

/**
 * The window's own close request -- what the title-bar X of the MAIN window
 * sends. Rust sees the JS listener on tauri://close-requested, prevents the
 * native close and hands the decision to Layout.tsx.
 *
 * THE EVALUATE IS AWAITED; THE CLOSE IS NOT. The close settles only once the
 * prompt is answered, so the page fires it and returns at once -- but the
 * evaluate itself MUST complete before the dialog driver runs. The driver is an
 * `execFileSync`, which blocks this process's event loop, and a Playwright call
 * that was merely STARTED has not yet written its CDP message: measured here,
 * a fire-and-forget close sat unsent for the driver's whole 20 s wait (so "no
 * prompt appeared"), went out only when the test's cleanup next awaited, and
 * then closed the window for real once that cleanup's File > New had made the
 * document clean.
 */
async function requestWindowClose(page: Page): Promise<void> {
  await bounded(
    "close request",
    page.evaluate(() => {
      void (window as unknown as AppWindow).__TAURI__.window
        .getCurrentWindow()
        .close()
        .catch(() => {});
    }),
  );
}

async function newFile(page: Page): Promise<void> {
  await page.evaluate(async (mod) => {
    const m = (await (window as unknown as AppWindow).__calcImport(new URL(mod, document.baseURI).href)) as {
      newFile: () => Promise<void>;
    };
    await m.newFile();
  }, FILE_API);
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

test.describe("the save-before-closing prompt keeps the window over unsaved work (L3)", () => {
  test("Cancel, then the X, then Escape: each keeps the window open and the document dirty, tears nothing down, and the next close asks again", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(240_000);

    // The page's own account of the close, printed at the end: when the prompt
    // does not appear, "why" lives here and nowhere else.
    const consoleTail: string[] = [];
    const onConsole = (m: { type: () => string; text: () => string }): void => {
      const line = `${m.type()}: ${m.text().slice(0, 300)}`;
      if (/\[Layout\]|lifecycleGuards|before-close|unsaved|prompt/i.test(line)) consoleTail.push(line);
    };
    page.on("console", onConsole);

    // ---- Baseline: the app is up, and no native dialog is already on screen
    // (one left over would be read and answered in place of ours).
    expect(appIsRunning(), "app.exe is not running").toBe(true);
    expect(mainWindowVisible(), "the main window is not visible -- is the window lister working?").toBe(true);
    expect(
      visibleDialogs().map((w) => w.title),
      "a native dialog was already open before this test",
    ).toEqual([]);

    try {
      // ---- A dirty document, made by a real edit. ----
      await newFile(page);
      expect(await isDirty(page), "File > New did not give a clean document").toBe(false);
      await grid.clickCell("C3");
      await grid.typeIntoCell("unsaved work");
      await expect.poll(() => isDirty(page), { timeout: 10_000 }).toBe(true);
      await hookBeforeClose(page);

      const answers: Array<{ name: string; how: Parameters<typeof answerPrompt>[0]; sent: RegExp }> = [
        { name: "the Cancel button", how: { action: "button", label: "Cancel" }, sent: /^CLICKED:Cancel$/ },
        { name: "the title-bar X", how: { action: "close" }, sent: /^CLOSED:X$/ },
        { name: "the Escape key", how: { action: "escape" }, sent: /^ESCAPED$/ },
      ];

      for (const { name, how, sent } of answers) {
        await requestWindowClose(page);
        const v = answerPrompt(how);

        // THE PROMPT REALLY APPEARED -- read off the native window itself.
        expect(v.notFound, `${name}: no native prompt appeared for a dirty document (driver: ${v.raw})`).toBe(false);
        expect(v.text, `${name}: the prompt on screen is not the save-before-closing prompt (driver: ${v.raw})`).toContain(PROMPT_TEXT);
        expect([...v.buttons].sort(), `${name}: the prompt does not offer Save / Don't Save / Cancel (driver: ${v.raw})`).toEqual(
          [...PROMPT_BUTTONS].sort(),
        );
        // THE ANSWER WAS DELIVERED, not merely sent.
        expect(v.sent, `${name}: the driver did not send the answer (driver: ${v.raw})`).toMatch(sent);
        expect(v.outcome, `${name}: the prompt did not go away (driver: ${v.raw})`).toBe("GONE");

        // THE WINDOW STAYS. Given time to be destroyed, it is not.
        await sleep(2000);
        expect(appIsRunning(), `${name}: the app EXITED -- the unsaved document is gone`).toBe(true);
        expect(mainWindowVisible(), `${name}: the main window is gone`).toBe(true);
        expect(visibleDialogs().map((w) => w.title), `${name}: a native dialog is still up`).toEqual([]);

        // The backend answers, and the work is still unsaved.
        expect(await isDirty(page), `${name}: the document is no longer dirty`).toBe(true);
        // Nothing was torn down: BEFORE_CLOSE goes out only on a real close.
        expect(await beforeCloseCount(page), `${name}: BEFORE_CLOSE was broadcast although the window stayed open`).toBe(0);
        // The cell the user typed is still there.
        const c3 = await bounded(
          "get_cell",
          page.evaluate(async () => (await (window as unknown as AppWindow).__TAURI__.core.invoke("get_cell", { row: 2, col: 2 })) as {
            display?: string;
          } | null),
        );
        expect(c3?.display, `${name}: the unsaved edit is gone`).toBe("unsaved work");
      }
      // Reaching the third answer at all is the "the next close asks again"
      // assertion: each iteration fails on `notFound` if the latch stuck.

      // Every close request has been answered, so none is pending: only NOW is
      // it safe to hand the next spec a clean workbook. (A close still pending
      // in the handler would read the clean document as "nothing to ask" and
      // close the window for real.)
      await bounded("newFile", newFile(page));
    } finally {
      page.off("console", onConsole);
      if (consoleTail.length > 0) console.log(`[close-prompt] page console:\n  ${consoleTail.join("\n  ")}`);
      // Never leave a prompt up for the next spec -- and never answer it with
      // anything but its Cancel button. On a failure the workbook is left DIRTY
      // on purpose, for the reason given above.
      if (appIsRunning() && visibleDialogs().length > 0) {
        answerPrompt({ action: "button", label: "Cancel" }, 2_000);
      }
    }
  });
});
