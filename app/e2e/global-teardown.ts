/**
 * Global teardown: kills the Tauri dev process launched by global-setup.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { APP_DIED_MARKER } from "./appDiedMarker";
import { APP_WEDGED_MARKER } from "./wedgeMarker";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(__dirname, ".tauri-pid");

export default async function globalTeardown() {
  // ANNOUNCE A RUN WHOSE APPLICATION DIED, BEFORE ANYTHING ELSE.
  //
  // `e2e/fixtures.ts` writes this marker the moment a CDP connect proves the
  // app is gone. Every test attempted afterwards fails in ~1 ms for a reason
  // that has nothing to do with the product, and the summary line at the end of
  // the log ("N failed") is then a lie by omission. The banner goes here
  // because this is the last thing the reader sees — and BEFORE the manual-mode
  // early return, since manual mode (E2E_MANUAL=1) is exactly how these runs
  // are driven and therefore exactly where the lie was told.
  if (fs.existsSync(APP_DIED_MARKER)) {
    const detail = fs.readFileSync(APP_DIED_MARKER, "utf-8").trim();
    console.error(
      "\n" +
        "==============================================================================\n" +
        "  THE APPLICATION WENT AWAY DURING THIS RUN.\n" +
        "  Results recorded after that point are NOT test results — re-launch the app\n" +
        "  and re-run before reading any number from this report.\n" +
        `${detail
          .split("\n")
          .map((l) => "  " + l)
          .join("\n")}\n` +
        "==============================================================================\n",
    );
  }

  // ...and the OTHER shape: the application never went away, it stopped
  // ANSWERING. Same three-stage mechanism, different fact and different remedy.
  //
  // This one is more expensive and less obvious than a dead app: every health
  // check keeps saying "healthy" (the process is up, CDP answers, the React
  // tree is mounted), so nothing stops the run and each remaining test pays its
  // FULL timeout instead of failing in a millisecond. Measured 2026-08-16:
  // 64 tests, 5.4 hours, no attribution anywhere in the report.
  if (fs.existsSync(APP_WEDGED_MARKER)) {
    const detail = fs.readFileSync(APP_WEDGED_MARKER, "utf-8").trim();
    console.error(
      "\n" +
        "==============================================================================\n" +
        "  THE APPLICATION STOPPED ANSWERING DURING THIS RUN.\n" +
        "  The process stayed up and the page stayed alive — so the failure count\n" +
        "  below counts ONE fact, not that many defects. Read it as a single\n" +
        "  product event and re-run before drawing any conclusion from the rest.\n" +
        `${detail
          .split("\n")
          .map((l) => "  " + l)
          .join("\n")}\n` +
        "==============================================================================\n",
    );
  }

  // KEEP THE APP'S OWN LOG. It is opened with `flags: "w"` at every launch
  // (global-setup), so the next run destroys the evidence of this one — which
  // is precisely why the 2026-08-16 wedge could never be diagnosed: by the time
  // anyone looked, four later runs had overwritten it. Archiving costs a file
  // copy and is the difference between "unexplainable again" and a log to read.
  try {
    const live = path.join(__dirname, "results", "app-dev.log");
    if (fs.existsSync(live)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archiveDir = path.join(__dirname, "results", "app-logs");
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.copyFileSync(live, path.join(archiveDir, `app-dev-${stamp}.log`));
      // Keep the last 10 so the directory cannot grow without bound.
      const kept = fs
        .readdirSync(archiveDir)
        .filter((f) => f.startsWith("app-dev-"))
        .sort()
        .reverse();
      for (const stale of kept.slice(10)) {
        fs.unlinkSync(path.join(archiveDir, stale));
      }
    }
  } catch { /* archiving is an aid, never a dependency */ }

  if (process.env.E2E_MANUAL === "1") {
    return; // user manages the app
  }

  if (!fs.existsSync(PID_FILE)) {
    return;
  }

  const pid = fs.readFileSync(PID_FILE, "utf-8").trim();
  console.log(`[e2e] Shutting down Tauri (PID ${pid})...`);

  try {
    // /T kills the whole process tree (cargo, vite, the Tauri app)
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
  } catch {
    // already exited
  }

  fs.unlinkSync(PID_FILE);
  console.log("[e2e] Tauri stopped.");
}
