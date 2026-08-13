//! FILENAME: app/e2e/helpers/nativeDialogs.ts
// PURPOSE: Read and dismiss NATIVE (Win32) dialogs raised by the app, from the
//          Node side, so an automated walk can survive one instead of hanging
//          on it forever.
//
// WHY THIS EXISTS. A native dialog is invisible to everything the harness
// normally looks at. It is a separate top-level window (class `#32770`), so it
// does not appear in a page screenshot, it carries no DOM, and the new
// `ui-not-blocked` invariant — which hit-tests the ribbon with
// `elementFromPoint` — cannot see it either. Meanwhile the WebView's JavaScript
// keeps running, so the page looks perfectly healthy: `page.evaluate` returns,
// the canvas paints, nothing throws.
//
// What it DOES block is Tauri IPC. Every `invoke` issued after the dialog opens
// simply never settles.
//
// MEASURED 2026-08-12 (BUG-0039). A soak walk stopped printing at
// `[shrink] replay 22` and sat there. Fifteen minutes later the app was still
// responding to `page.evaluate`, the screenshot showed an ordinary spreadsheet,
// and `list-app-windows.ps1` reported **twelve** visible `#32770` windows
// stacked on it. Reading one:
//
//     TEXT:Failed to rename sheet: Sheet index 2 out of range
//
// The shrinker replays a trace dozens of times; each replay re-raised the alert
// and nothing ever answered it. The walk burned its whole 30-minute spec
// timeout, and — this is the part that matters — it burned it SILENTLY. A hang
// is invisible to an exit-status check, which is the one failure mode this
// programme keeps deleting.
//
// Playwright cannot touch these dialogs: Tauri defines its IPC surface with
// non-writable, non-configurable properties, so the dialog can neither be
// stubbed nor observed from inside the page. It can only be driven from
// outside, which is what `e2e/answer-native-dialog.ps1` does and what this
// module wraps.

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWER_SCRIPT = path.resolve(HERE, "../answer-native-dialog.ps1");

function runAnswerScript(action: "read" | "ok" | "cancel", timeoutMs: number): string {
  try {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ANSWER_SCRIPT,
        "-TitleLike",
        "Calcula",
        "-Action",
        action,
        "-TimeoutMs",
        String(timeoutMs),
      ],
      { encoding: "utf8", timeout: timeoutMs + 15_000, windowsHide: true }
    );
  } catch (err) {
    // The script exits non-zero when it finds nothing, and a spawn failure
    // (no PowerShell, wrong platform) must never mask the thing being
    // diagnosed. Either way: report "nothing found".
    const out = (err as { stdout?: string }).stdout;
    return typeof out === "string" ? out : "";
  }
}

/**
 * The message of the native dialog currently on screen, or null.
 * Reads only — clicks nothing.
 */
export function readNativeDialogText(timeoutMs = 4000): string | null {
  const out = runAnswerScript("read", timeoutMs);
  const line = out.split(/\r?\n/).find((l) => l.startsWith("TEXT:"));
  return line ? line.slice("TEXT:".length).trim() : null;
}

export interface DialogSweep {
  /** Messages of the dialogs that were dismissed, in the order dismissed. */
  dismissed: string[];
}

/**
 * Dismiss every native dialog the app currently has open, up to `max`.
 *
 * They STACK — the measured pile-up was twelve deep, one per shrink replay —
 * so a single answer is not a sweep. Each dialog's text is read before it is
 * clicked, because the text is the only evidence of what raised it.
 */
export function sweepNativeDialogs(max = 30, timeoutMs = 2500): DialogSweep {
  const dismissed: string[] = [];
  for (let i = 0; i < max; i++) {
    const text = readNativeDialogText(timeoutMs);
    if (text === null) break;
    const out = runAnswerScript("ok", timeoutMs);
    if (!out.includes("CLICKED:")) break;
    dismissed.push(text);
  }
  return { dismissed };
}
