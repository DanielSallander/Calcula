//! FILENAME: app/e2e/launch-app.mjs
// PURPOSE: Spawn `tauri dev` for a MANUAL E2E batch and tee its output to
//          app/e2e/results/app-dev.log, which is where walker failure bundles
//          look for the backend's account of a failure.
//
// WHY THIS EXISTS AS A NODE SCRIPT. The launcher used to tee through a
// PowerShell pipeline. Measured, not assumed: the log ended up containing
// exactly two lines — yarn's own banner — and nothing `tauri dev` printed ever
// reached it, through `Tee-Object` and through `ForEach-Object` alike. A
// bundle that says it carries the app log and carries two lines of yarn is
// worse than one that says it has none. Node's `spawn` with piped stdio is the
// mechanism `global-setup.ts` already uses to stream `[tauri] …` lines, so it
// is the one that is known to work here.
//
// The PowerShell launcher keeps everything else it does (killing stale
// processes, MSVC's link.exe ahead of Git's, CARGO_TARGET_DIR outside Dropbox,
// the WebView2 CDP argument) and calls this for the spawn.
//
//   node e2e/launch-app.mjs            # from the app/ directory
//
// Env it reads: CDP_PORT (default 9222), E2E_APP_LOG (default the path below).
// Everything else is inherited, which is how the PowerShell script's MSVC and
// CARGO_TARGET_DIR settings reach cargo.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const CDP_PORT = process.env.CDP_PORT ?? "9222";
const LOG_PATH = process.env.E2E_APP_LOG
  ? path.resolve(process.env.E2E_APP_LOG)
  : path.resolve(HERE, "results", "app-dev.log");

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
const log = fs.createWriteStream(LOG_PATH, { flags: "w" });

const stamp = () => new Date().toISOString();
log.write(`[launch] ${stamp()} tauri dev, CDP ${CDP_PORT}\n`);
console.log(`[launch] app log -> ${LOG_PATH}`);

const child = spawn(
  "yarn",
  ["tauri", "dev", "--config", "src-tauri/tauri.e2e.conf.json"],
  {
    cwd: APP_DIR,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  }
);

const tee = (stream, sink, prefix) => {
  stream?.on("data", (chunk) => {
    sink.write(`[tauri] ${chunk}`);
    log.write(chunk);
  });
  void prefix;
};

tee(child.stdout, process.stdout);
tee(child.stderr, process.stderr);

child.on("error", (err) => {
  const line = `[launch] failed to start: ${err.message}\n`;
  process.stderr.write(line);
  log.write(line);
});

child.on("exit", (code, signal) => {
  const line = `[launch] ${stamp()} tauri dev exited code=${code} signal=${signal}\n`;
  process.stdout.write(line);
  log.write(line);
  log.end();
  process.exit(code ?? 1);
});

// Forward Ctrl+C so the app goes down with the launcher.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  });
}
