/**
 * Native-window plumbing for the "edit" area's close-prompt check (E8), taken
 * from journeys/zy-close-prompt-cancel.spec.ts: the prompt and the Save As
 * picker are Win32 dialogs, answered from OUTSIDE the app over Win32
 * (`e2e/answer-native-dialog.ps1`) -- never by position.
 *
 * THE EVALUATE IS AWAITED; THE CLOSE IS NOT (see zy-close-prompt-cancel): a
 * Playwright call that was merely started has not written its CDP message, and
 * the driver below is an execFileSync that blocks this process.
 */
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bounded } from "./edit-harness";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_DRIVER = path.join(HERE, "..", "answer-native-dialog.ps1");
const WINDOW_LISTER = path.join(HERE, "..", "list-app-windows.ps1");

export interface NativeWindow {
  pid: number;
  hwnd: number;
  class: string;
  title: string;
  visible: boolean;
}

export interface DriverVerdict {
  raw: string;
  text: string;
  buttons: string[];
  sent: string | null;
  outcome: "GONE" | "STILLOPEN" | null;
  notFound: boolean;
}

export function answerNativeDialog(
  titleLike: string,
  how: { action: "button"; label: string } | { action: "close" } | { action: "escape" } | { action: "ok" } | { action: "cancel" },
  waitMs = 20_000,
): DriverVerdict {
  if (!fs.existsSync(DIALOG_DRIVER)) throw new Error(`the native-dialog driver is missing at ${DIALOG_DRIVER}`);
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DIALOG_DRIVER, "-TitleLike", titleLike, "-Action", how.action, "-TimeoutMs", String(waitMs)];
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

export function appWindows(): NativeWindow[] {
  if (!fs.existsSync(WINDOW_LISTER)) throw new Error(`the native-window lister is missing at ${WINDOW_LISTER}`);
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

export function visibleDialogs(): NativeWindow[] {
  return appWindows().filter((w) => w.visible && w.class === "#32770");
}

export function mainWindowVisible(): boolean {
  return appWindows().some((w) => w.visible && w.class === "Tauri Window");
}

export function appIsRunning(): boolean {
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

interface CloseWindow {
  __TAURI__: {
    core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    window: { getCurrentWindow: () => { close: () => Promise<void> } };
  };
  __e2eBeforeClose?: number;
  __e2eBeforeCloseHooked?: boolean;
}

/** The main window's own close request (what its title-bar X sends). Awaited evaluate, un-awaited close. */
export async function requestWindowClose(page: Page): Promise<void> {
  await bounded(
    "close request",
    page.evaluate(() => {
      void (window as unknown as CloseWindow).__TAURI__.window
        .getCurrentWindow()
        .close()
        .catch(() => {});
    }),
  );
}

/** Count `app:before-close` broadcasts from here on. */
export async function hookBeforeClose(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as CloseWindow;
    w.__e2eBeforeClose = 0;
    if (!w.__e2eBeforeCloseHooked) {
      window.addEventListener("app:before-close", () => {
        w.__e2eBeforeClose = (w.__e2eBeforeClose ?? 0) + 1;
      });
      w.__e2eBeforeCloseHooked = true;
    }
  });
}

export async function beforeCloseCount(page: Page): Promise<number> {
  return bounded("BEFORE_CLOSE counter", page.evaluate(() => (window as unknown as CloseWindow).__e2eBeforeClose ?? -1));
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
