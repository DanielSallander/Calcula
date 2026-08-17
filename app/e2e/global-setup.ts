/**
 * Global setup: launches `cargo tauri dev` with WebView2 remote-debugging
 * on port 9222 so Playwright can connect via CDP.
 *
 * Skipped when E2E_MANUAL=1 (user already has the app running).
 */
import { execSync, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { fileURLToPath } from "url";
import type { FullConfig } from "@playwright/test";
import { webview2BrowserArguments } from "./webview2Args.mjs";
import { APP_DIED_MARKER } from "./appDiedMarker";
import { assertCollectionGuardPresent } from "./collectionGuard";
import { clearStartupFailure } from "./startupGuard";
import { assertAppMounted } from "./startupBarrier";
import { APP_WEDGED_MARKER } from "./wedgeMarker";
import { resetWedgeCounter } from "./wedgeGuard";
import { resetVolatilePersistedStateOverCdp } from "./volatilePersistedState";
import {
  resolveBuildTarget,
  describeBinary,
  formatBuildTargetBanner,
} from "./buildTarget";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);
// Module scope, because BOTH the auto-launch branch (which kills whatever holds
// the port) and the startup barrier (which checks the page is actually ON this
// origin) need it, and the barrier runs before the auto-launch branch is reached.
const VITE_PORT = Number(process.env.VITE_PORT ?? 5173);
const STARTUP_TIMEOUT_MS = 300_000; // 5 min — Rust rebuild after engine changes can be slow
const PID_FILE = path.join(__dirname, ".tauri-pid");

/** Poll http://localhost:<CDP_PORT>/json/version until it responds. */
function waitForCDP(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let body = "";
        res.on("data", (d: Buffer) => (body += d.toString()));
        res.on("end", () => {
          if (res.statusCode === 200) {
            console.log(`[e2e] CDP ready on port ${port}`);
            resolve();
          } else {
            retry();
          }
        });
      });
      req.on("error", () => retry());
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`CDP on port ${port} did not become ready within ${timeoutMs / 1000}s`));
        return;
      }
      setTimeout(poll, 1000);
    };

    poll();
  });
}

export default async function globalSetup(config: FullConfig) {
  // REFUSE a run whose resolved reporter list lost the collection guard (a CLI
  // --reporter flag replaces the config's reporters). Without the guard, a run
  // that silently collects fewer tests than `--list` reports can produce a
  // clean green number for a suite it did not run — measured 2026-08-13:
  // 134 of 143 journey tests collected, reported as a clean pass. `--list`
  // itself never executes global-setup, so listing stays cheap and unguarded.
  assertCollectionGuardPresent(config);

  // Clear the "the application went away" marker from any earlier run, so the
  // banner the teardown prints can only ever be about THIS one. Written by
  // e2e/fixtures.ts the moment a CDP connect proves the app is gone.
  try {
    if (fs.existsSync(APP_DIED_MARKER)) fs.unlinkSync(APP_DIED_MARKER);
  } catch { /* a stale marker we cannot remove must not stop the run */ }

  // Same three-stage mechanism for the OTHER way a run is dead on arrival: the
  // app is up, the page loaded, and the frontend never mounted (BUG-0082). This
  // clears; `startupBarrier.ts`/`fixtures.ts` write; `collectionGuard.ts` reads.
  clearStartupFailure();

  // And the third way, which is the expensive one: the app is up, CDP answers,
  // the frontend IS mounted, and the BACKEND stops returning from Tauri
  // commands. Every existing detector keys on unreachability, so none of them
  // fires — measured 2026-08-16 at 64 consecutive full-timeout failures, 5.4
  // hours, and a run abandoned at test 101 of 157. This clears;
  // `e2e/fixtures.ts` writes; `global-teardown.ts` reads.
  try {
    if (fs.existsSync(APP_WEDGED_MARKER)) fs.unlinkSync(APP_WEDGED_MARKER);
  } catch { /* a stale marker we cannot remove must not stop the run */ }
  // The pre-latch probe counter is on disk too — it HAS to be, because a
  // rebuilt worker re-imports the module and would reset an in-memory count
  // before it could ever reach two (see `wedgeGuard.ts`). Being on disk, it
  // also outlives the run, so it is cleared here with the marker.
  resetWedgeCounter();

  // NOTE ON THE DEPENDENCY CACHE (BUG-0082's second mechanism, §32). Nothing is
  // done about it HERE, and that is deliberate. The repair --
  // `app/scripts/ensure-dep-cache.mjs` -- runs from npm's `predev`, which
  // Tauri's `beforeDevCommand` invokes, so it covers the auto-launch below AND
  // the manual launcher, always BEFORE a dev server exists. Running the
  // optimiser from here would be worse than useless: in manual mode the server
  // is already up and serving, and re-optimising underneath a live server is how
  // a page ends up holding two generations of React in the first place. What
  // this file contributes instead is DETECTION: `assertAppMounted` reads the
  // page's own resource timings and fails the run by name if it finds a
  // dependency loaded under more than one optimiser hash.

  // Manual mode — caller manages the app lifecycle.
  if (process.env.E2E_MANUAL === "1") {
    console.log("[e2e] Manual mode — expecting Calcula already running with CDP on port", CDP_PORT);
    await waitForCDP(CDP_PORT, 15_000);
    // THE BARRIER RUNS IN MANUAL MODE TOO — in fact especially here. Every
    // BUG-0082 occurrence was a manual-mode run (`soak`, `invariant`, `visual`
    // are all driven with E2E_MANUAL=1 against an app the operator launched), so
    // a barrier that skipped this branch would skip every case it exists for.
    await assertAppMounted({ cdpPort: CDP_PORT, vitePort: VITE_PORT });
    // Manual mode needs this MORE, not less: the operator's app has been alive
    // across however many earlier runs, so it is the likeliest to be carrying
    // another run's residue.
    await resetInheritedUiState();
    return;
  }

  // Kill any leftover instance from a previous aborted run.
  if (fs.existsSync(PID_FILE)) {
    const oldPid = fs.readFileSync(PID_FILE, "utf-8").trim();
    try {
      execSync(`taskkill /F /T /PID ${oldPid}`, { stdio: "ignore" });
    } catch { /* already gone */ }
    fs.unlinkSync(PID_FILE);
  }

  // Kill any process occupying the Vite port so `cargo tauri dev` can start cleanly.
  try {
    const netstatOut = execSync(`netstat -ano | findstr :${VITE_PORT} | findstr LISTENING`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = new Set(
      netstatOut
        .split("\n")
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((pid): pid is string => !!pid && /^\d+$/.test(pid))
    );
    for (const pid of pids) {
      console.log(`[e2e] Killing process ${pid} occupying port ${VITE_PORT}`);
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
      } catch { /* already gone */ }
    }
  } catch { /* no process on port — good */ }

  // SAY WHICH BINARY THIS RUN IS ABOUT TO EXERCISE.
  //
  // Everything above carefully constructs the MSVC environment; nothing
  // anywhere sets CARGO_TARGET_DIR. There is no .cargo/config.toml and no
  // persistent user value, so the target directory is whatever the invoking
  // shell exports -- in-repo when it exports nothing. Two terminals therefore
  // build and run two DIFFERENT binaries and no run output ever said which.
  // Measured 2026-08-16: the in-repo tree failed to link app_lib.dll (~40
  // LNK2001 out of libcalp) while the same source linked cleanly out-of-repo,
  // and the run read as "E2E is broken". See open-decisions 2026-08 section 39d.
  {
    const workspace = path.resolve(__dirname, "..", "src-tauri");
    const repoRoot = path.resolve(__dirname, "..", "..");
    const info = resolveBuildTarget(process.env, workspace, repoRoot);
    for (const line of formatBuildTargetBanner(info, describeBinary(info.targetDir))) {
      console.log(line);
    }
  }

  console.log("[e2e] Launching cargo tauri dev with CDP on port", CDP_PORT, "...");

  // Build the MSVC environment so Rust can find the correct link.exe.
  // Without this, Git's link.exe shadows MSVC's and the build fails.
  // These match core/setup-rust-env.ps1.
  const msvcBinDir =
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\arm64";
  const rustEnv: Record<string, string> = {
    LIB: [
      "C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.26100.0\\um\\arm64",
      "C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.26100.0\\ucrt\\arm64",
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207\\lib\\arm64",
    ].join(";"),
    INCLUDE: [
      "C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\um",
      "C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\ucrt",
      "C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\shared",
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207\\include",
    ].join(";"),
    // Prepend MSVC bin to PATH so its link.exe is found before Git's
    PATH: `${msvcBinDir};${process.env.PATH ?? ""}`,
  };

  // Clear CC/AR/CFLAGS so cc crate uses MSVC directly
  const cleanEnv = { ...process.env };
  delete cleanEnv.CC;
  delete cleanEnv.AR;
  delete cleanEnv.CFLAGS;

  // The e2e overlay re-enables withGlobalTauri (the harness drives the app
  // through window.__TAURI__ from page.evaluate). It is a dev-merge config —
  // production builds never include it.
  const child: ChildProcess = spawn("yarn", ["tauri", "dev", "--config", "src-tauri/tauri.e2e.conf.json"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...cleanEnv,
      ...rustEnv,
      // The CDP port plus the flags that make a screenshot a function of the
      // PAGE rather than of the machine it was taken on. Defined ONCE, in
      // e2e/webview2Args.mjs, which also records how each flag was measured —
      // this file and the manual launcher had drifted apart, and the drift cost
      // the whole golden corpus its meaning twice over.
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webview2BrowserArguments(CDP_PORT),
      // THE APP UNDER TEST IS NOT HOT-RELOADABLE. Vite pushes to whatever is
      // connected, and a source save mid-run fast-refreshes the provider tree:
      // GridProvider's `useReducer` restarts from `getInitialState()`, so the
      // selection snaps to A1 and the scroll to 0 with NO navigation --
      // `performance.timeOrigin` unchanged, window markers intact, nothing in
      // the page able to tell. Measured 2026-08-15: ~170 modules updated and
      // the parked selection reset 2.5 s after the harness parked it. A capture
      // taken across that window photographs the editor. See vite.config.ts and
      // e2e/__tests__/hmrDisabledForE2E.test.ts.
      CALCULA_E2E: "1",
    },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Stream output so the user can see build progress — AND tee it to a file.
  //
  // Nothing was recording the app's own output, so every walker failure bundle
  // this harness has ever written contained the browser console and nothing
  // else: a failure whose cause was on the Rust side left no trace at all. The
  // manual launcher (scratchpad/launch-vba-batch.ps1) writes the same file, and
  // walker/failureBundle.ts copies its tail into the bundle.
  const appLogPath = path.join(__dirname, "results", "app-dev.log");
  fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
  const appLog = fs.createWriteStream(appLogPath, { flags: "w" });
  child.stdout?.on("data", (d: Buffer) => {
    process.stdout.write(`[tauri] ${d}`);
    appLog.write(d);
  });
  child.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(`[tauri] ${d}`);
    appLog.write(d);
  });

  child.on("error", (err) => {
    console.error("[e2e] Failed to start Tauri:", err.message);
  });

  // Save PID so teardown (and next run) can kill it.
  if (child.pid) {
    fs.writeFileSync(PID_FILE, String(child.pid));
  }

  // Wait for the CDP endpoint to appear.
  await waitForCDP(CDP_PORT, STARTUP_TIMEOUT_MS);

  // Also wait for the Vite dev server to be ready.
  // Without this, WebView2 may load before Vite is serving, showing an error page.
  // On cold builds, Rust compiles first (3-5 min) before Vite starts, so use
  // the same generous timeout as CDP.
  await waitForHTTP(VITE_PORT, STARTUP_TIMEOUT_MS);

  // THE LAST GATE BEFORE THE FIRST TEST: the frontend has to be MOUNTED, not
  // merely served. Vite answering `/` says the dev server is up; it says nothing
  // about whether `/src/main.tsx` ever executed, and BUG-0082 is precisely the
  // gap between those two facts -- a page with the full index.html DOM, a
  // `<title>app</title>`, and an EMPTY `#root`. Without this line the harness
  // discovers it 60 seconds later, once per test, as N identical
  // `waitForSelector` timeouts that read as a product collapse (18 of 18 in the
  // visual project). Throwing here fails the RUN with zero test results instead.
  await assertAppMounted({ cdpPort: CDP_PORT, vitePort: VITE_PORT });

  // ...and only now, with the app proved healthy, put its PERSISTED UI state
  // back to defaults. Ordering matters: this needs a mounted page to reload.
  await resetInheritedUiState();
}

/**
 * Reset the app-owned storage namespaces so this run cannot inherit another
 * run's residue.
 *
 * WHY ON THE WAY IN, AND NOT IN ANYBODY'S TEARDOWN. On 2026-08-16 a journey run
 * wedged inside `shapes-hometab.spec.ts` test 8. That test DOES restore the
 * Home-tab layout in a `finally`, and the `finally` DID run — but restoring
 * needs a living app to reload, so it swallowed its own failure and the
 * customised layout stayed on disk. The next project (visual) then failed
 * `ribbon-core-default-ribbon.png` for something no visual spec did.
 *
 * The lesson generalises: cleanup-on-exit cannot be relied on when the failure
 * mode is "the app died", because the cases that leave residue are exactly the
 * cases with no app left to clean up with. A reset on the way IN runs at the one
 * moment the app is known-healthy. Both belong — the `finally` keeps a passing
 * run tidy, this keeps a CRASHED run from spreading.
 *
 * IT IS LOUD WHEN IT FINDS ANYTHING. Silently repairing inherited residue would
 * conceal that a previous run leaked, which is the fact worth knowing.
 */
async function resetInheritedUiState(): Promise<void> {
  const reset = await resetVolatilePersistedStateOverCdp(CDP_PORT);
  if (!reset) {
    console.warn(
      "[e2e] could not reset persisted UI state (CDP unavailable) — this run may " +
        "inherit residue from an earlier one; the residue guard will say so.",
    );
    return;
  }
  // SWEEPING IS ROUTINE; FINDING A NON-DEFAULT VALUE IS NOT. Several of these
  // keys belong to `zustand/persist` stores that write themselves on hydration,
  // so a sweep clears something on essentially every run. Reporting that as
  // "a previous run left the application reconfigured" would cry wolf every
  // time — and an alarm that always fires is one nobody reads. Only a value
  // that differs from the store's own default is evidence of a leak.
  if (reset.disturbed.length > 0) {
    console.warn(
      "[e2e] INHERITED NON-DEFAULT UI STATE FROM AN EARLIER RUN — a previous run " +
        "left the application reconfigured and did not put it back. Cleared " +
        "before the first test:\n" +
        reset.disturbed
          .map((d) => `        ${d.key} = ${d.value}\n          -> ${d.consequence}`)
          .join("\n") +
        "\n      This reset only stops it spreading; the leak is in whichever spec " +
        "set them.",
    );
    return;
  }
  if (reset.cleared.length === 0) {
    console.log("[e2e] persisted UI state: clean (nothing to clear)");
    return;
  }
  console.log(
    `[e2e] persisted UI state: reset ${reset.cleared.length} key(s) to defaults ` +
      "(all were already at default — self-writing stores, not residue)",
  );
}

/** Poll http://localhost:<port>/ until it responds with a 2xx/3xx status. */
function waitForHTTP(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(`http://localhost:${port}/`, (res) => {
        if (res.statusCode && res.statusCode < 400) {
          console.log(`[e2e] Vite dev server ready on port ${port}`);
          res.resume(); // drain the response
          resolve();
        } else {
          res.resume();
          retry();
        }
      });
      req.on("error", () => retry());
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Vite dev server on port ${port} did not become ready within ${timeoutMs / 1000}s`));
        return;
      }
      setTimeout(poll, 1000);
    };

    poll();
  });
}
