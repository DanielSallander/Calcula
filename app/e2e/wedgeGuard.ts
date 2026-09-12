//! FILENAME: app/e2e/wedgeGuard.ts
// PURPOSE: Detect an app that is REACHABLE BUT USELESS — process up, CDP
//          answering, React mounted, and the Rust backend not returning from
//          Tauri commands — and fail the run fast, loudly, and with attribution.
//
// THE GAP THIS CLOSES. The harness has two liveness notions and neither can see
// this state:
//
//   `assertAppMounted` (startupBarrier)  "a DOM node became visible" — and it
//                                        runs ONCE PER RUN, from global-setup
//                                        (:128 and :288; exactly two call sites,
//                                        pinned by startupBarrierWired.test.ts)
//   the worker-scoped `sharedPage`       "CDP accepted a connection"
//   fixture (fixtures.ts:244, :316)      + a 60 s wait for the spreadsheet
//                                        container — this is what re-runs on
//                                        every worker rebuild
//
// A wedged backend falsifies neither. On 2026-08-16 a journey run rebuilt its
// worker 64 times, the `sharedPage` checks passed every time and reported a
// healthy app, while every Tauri invoke hung. `assertAppMounted` had no mid-run
// counterpart at all; this is it.
//
// (An earlier version of this comment said all 64 restarts ran `assertAppMounted`.
// They did not — global-setup runs once per RUN. The substance was unaffected:
// the checks that DID re-run are the same shape and equally blind to this state.)
//
// WHY IT PROBES WITH AN INVOKE AND NOT A LOCATOR. The failure is BEHIND the IPC
// boundary. Every DOM-level signal stays green — that is the whole difficulty —
// so the only probe that can distinguish "busy" from "wedged" is one that asks
// the backend a question and requires an answer.
//
// WHY THE RACE IS DOUBLE. `page.evaluate` has no timeout in Playwright's API
// (`evaluate(pageFunction, arg)` takes no options), so the probe needs its own
// bound at BOTH levels:
//   * inside the page, a `Promise.race` against a timer bounds the INVOKE, which
//     tells "the backend is wedged" from "the renderer is fine";
//   * in Node, a second race bounds the EVALUATE itself, because a wedged
//     RENDERER would never run the first race at all.
// The two verdicts are reported separately because they have different causes
// and different owners. This is the technique `calc-progress-deadlock.spec.ts`
// already uses for one spec, generalised to every test.
//
// WHY TWO CONSECUTIVE VERDICTS. A single slow answer is not a wedge, and a guard
// that latches on one is worse than the disease. The app is declared wedged only
// after two probes in a row fail, which a legitimately busy app clears on its
// next test.
//
// IT FAILS — IT DOES NOT SKIP. §3bx is explicit that a doomed run must not
// swallow: a skipped test reports coverage it does not have. Every test after
// the latch fails immediately with the reason.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { APP_WEDGED_MARKER, WEDGE_PROBE_COUNT_FILE } from "./wedgeMarker";

/**
 * Read a millisecond budget from the environment, REFUSING a value that would
 * make the guard lie.
 *
 * `Number(process.env.X ?? 5_000)` — what this used to be — has two ways to
 * produce a budget that fires instantly, and an instant budget latches a
 * perfectly HEALTHY run as wedged:
 *
 *   E2E_WEDGE_BACKEND_MS=""      `??` does NOT catch an empty string (it is not
 *                                nullish), so `Number("")` is 0.
 *   E2E_WEDGE_BACKEND_MS="5s"    `Number("5s")` is NaN, and `setTimeout(fn, NaN)`
 *                                fires on the next tick.
 *
 * Either one turns this guard from a wedge detector into a wedge fabricator —
 * and the marker it writes is exactly the artefact somebody would later trust.
 * So a malformed value falls back to the default and SAYS SO.
 */
function budgetMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[wedge-guard] ignoring ${name}=${JSON.stringify(raw)} — not a positive ` +
        `number of milliseconds; using ${fallback}ms. A zero or NaN budget would ` +
        `latch a healthy run as wedged.`,
    );
    return fallback;
  }
  return parsed;
}

/** How long the BACKEND gets to answer one trivial read, inside the page. */
const BACKEND_BUDGET_MS = budgetMs("E2E_WEDGE_BACKEND_MS", 5_000);
/** How long the whole probe gets in Node, bounding the unbounded `evaluate`. */
const PROBE_BUDGET_MS = budgetMs("E2E_WEDGE_PROBE_MS", 15_000);

export type WedgeVerdict = "ok" | "backend-wedged" | "renderer-wedged";

/** True when the guard is switched off. Says so on stderr; never silent. */
export function wedgeGuardDisabled(): boolean {
  const off = process.env.E2E_WEDGE_GUARD === "off";
  if (off) {
    process.stderr.write(
      "[wedge-guard] DISABLED via E2E_WEDGE_GUARD=off — a wedged backend will " +
        "again cost this run one full test timeout per remaining test.\n",
    );
  }
  return off;
}

/**
 * Ask the backend one trivial, read-only question and require an answer.
 *
 * `get_cell` is chosen deliberately: it is a pure read, it touches the grid
 * locks that every wedge in this project's history has involved, and it cannot
 * mutate the document a test is about to assert on. A REFUSAL still counts as
 * "ok" — the guard is about whether the backend ANSWERS, not about what it says.
 */
export async function probeBackend(page: Page): Promise<WedgeVerdict> {
  const evaluated = page
    .evaluate(async (budgetMs: number) => {
      const tauri = (window as unknown as {
        __TAURI__?: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
      }).__TAURI__;
      if (!tauri) return "ok"; // Not a Tauri page; nothing to say about the backend.
      return await Promise.race([
        tauri.core
          .invoke("get_cell", { row: 0, col: 0 })
          .then(() => "ok" as const)
          .catch(() => "ok" as const),
        new Promise<"backend-wedged">((resolve) =>
          setTimeout(() => resolve("backend-wedged"), budgetMs),
        ),
      ]);
    }, BACKEND_BUDGET_MS)
    .catch((): WedgeVerdict => "ok");

  const timed = new Promise<WedgeVerdict>((resolve) =>
    setTimeout(() => resolve("renderer-wedged"), PROBE_BUDGET_MS),
  );

  return (await Promise.race([evaluated, timed])) as WedgeVerdict;
}

/**
 * Consecutive bad verdicts. Two in a row latches the guard.
 *
 * THIS COUNTER LIVES ON DISK, AND IT HAS TO. The obvious implementation — a
 * module-level `let` — is silently broken here, and broken in the exact
 * situation the guard exists for. **Playwright destroys and rebuilds the worker
 * after every FAILED test**, and a rebuilt worker is a new process that
 * re-imports this module with fresh state. So the sequence on a wedged app is:
 *
 *   test N    probe fails -> count 1 -> "not latching yet" -> test burns 300 s
 *             -> FAILS -> worker rebuilt -> module re-imported -> count back to 0
 *   test N+1  probe fails -> count 1 -> "not latching yet" -> test burns 300 s
 *   ...
 *
 * — the count can never reach 2, nothing ever latches, and the guard degrades
 * into a log line while the run still costs 5.4 hours. The latch marker was
 * already a file for the same reason; this needs to be one too.
 *
 * A unit test cannot catch this within a single module instance, which is why
 * `__tests__/wedgeGuard.test.ts` re-imports the module between probes to
 * simulate the restart.
 */
function readConsecutiveBad(): number {
  try {
    const n = Number.parseInt(fs.readFileSync(WEDGE_PROBE_COUNT_FILE, "utf-8").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeConsecutiveBad(n: number): void {
  try {
    if (n === 0) {
      if (fs.existsSync(WEDGE_PROBE_COUNT_FILE)) fs.unlinkSync(WEDGE_PROBE_COUNT_FILE);
      return;
    }
    fs.mkdirSync(path.dirname(WEDGE_PROBE_COUNT_FILE), { recursive: true });
    fs.writeFileSync(WEDGE_PROBE_COUNT_FILE, String(n), "utf-8");
  } catch {
    /* the counter is an aid, never a dependency */
  }
}

/** Once latched, every later test fails immediately rather than waiting. */
export function isLatched(): boolean {
  return fs.existsSync(APP_WEDGED_MARKER);
}

export function readLatch(): string {
  try {
    return fs.readFileSync(APP_WEDGED_MARKER, "utf-8");
  } catch {
    return "the application was found unresponsive earlier in this run";
  }
}

function writeLatch(verdict: WedgeVerdict, testTitle: string): void {
  const detail =
    verdict === "backend-wedged"
      ? "THE BACKEND STOPPED ANSWERING. The process is up, CDP answers and the " +
        "React tree is mounted, but a Tauri command did not return within " +
        `${BACKEND_BUDGET_MS} ms. This is a PRODUCT state, not a test failure: ` +
        "a deadlock or an unreturned command in the Rust layer, or a native " +
        "modal owning the main thread."
      : "THE RENDERER STOPPED ANSWERING. `page.evaluate` did not run within " +
        `${PROBE_BUDGET_MS} ms, so the WebView is not executing script.`;

  const body = [
    "APP WEDGED",
    "",
    detail,
    "",
    `First detected before: ${testTitle}`,
    `Detected at:           ${new Date().toISOString()}`,
    "",
    "Every failure in this run after this point is the SAME FACT, not " +
      "independent evidence. Do not read the failure count as a defect count.",
    "",
    // This paragraph told readers the app log is truncated on every app start
    // and to copy it before relaunching. That stopped being true on 2026-08-17,
    // when `init_log_file` began ROTATING instead of truncating
    // (app/src-tauri/src/logging.rs, RETAINED_SESSION_LOGS = 10). The marker is
    // the one artefact a future reader is told to trust, so a false instruction
    // in it is worse than none -- and it also named the wrong file: the harness
    // archives `results/app-dev.log`, the `cargo tauri dev` stdout tee, not the
    // backend's own log.
    "TWO DIFFERENT LOGS, and you want both:",
    "  1. The BACKEND's own log, context_manager/log.log. It is ROTATED, not " +
      "truncated, so relaunching does NOT destroy it -- the previous session " +
      "lands in context_manager/history/log-<stamp>.log and the last 10 are " +
      "kept. The harness does NOT archive this one; copy it yourself.",
    "  2. The harness tee, e2e/results/app-dev.log (`cargo tauri dev` stdout " +
      "and stderr). global-teardown archives it to the run's archive dir, but " +
      "it is OVERWRITTEN at the start of every run.",
    "",
  ].join("\n");

  try {
    fs.mkdirSync(path.dirname(APP_WEDGED_MARKER), { recursive: true });
    fs.writeFileSync(APP_WEDGED_MARKER, body, "utf-8");
  } catch {
    /* the marker is an aid, never a dependency */
  }
}

/**
 * The per-test gate. Returns a reason string when the run should stop paying
 * full price, or `null` when the app is answering.
 *
 * Cost on a healthy run: one `get_cell` per test — a read of one cell, well
 * under a millisecond of backend work.
 */
export async function checkForWedge(page: Page, testTitle: string): Promise<string | null> {
  if (wedgeGuardDisabled()) return null;

  if (isLatched()) {
    return (
      "[wedge-guard] the application was already proved unresponsive earlier in " +
      "this run, so this test was failed immediately instead of waiting for its " +
      "full timeout.\n\n" +
      readLatch()
    );
  }

  const verdict = await probeBackend(page);
  if (verdict === "ok") {
    writeConsecutiveBad(0);
    return null;
  }

  const consecutiveBad = readConsecutiveBad() + 1;
  writeConsecutiveBad(consecutiveBad);
  if (consecutiveBad < 2) {
    process.stderr.write(
      `[wedge-guard] one unanswered probe (${verdict}) before "${testTitle}" — ` +
        "not latching yet; a single slow answer is not a wedge.\n",
    );
    return null;
  }

  writeLatch(verdict, testTitle);
  return (
    `[wedge-guard] ${verdict}: two consecutive probes went unanswered.\n\n` + readLatch()
  );
}

/**
 * Clear the on-disk probe counter. Called by `global-setup` alongside the latch
 * marker so a run never inherits a half-count from the previous one.
 */
export function resetWedgeCounter(): void {
  writeConsecutiveBad(0);
}
