/**
 * Global teardown: kills the Tauri dev process launched by global-setup.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { APP_DIED_MARKER } from "./appDiedMarker";

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
