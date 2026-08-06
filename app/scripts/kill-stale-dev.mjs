/**
 * Kill leftovers from a previous `tauri dev` run so a new one can start.
 *
 * Two symptoms this fixes:
 *   1. "Port 5173 is already in use" -- an orphaned Vite dev server.
 *   2. A zombie Calcula window that the previous run never shut down (it would
 *      otherwise reconnect to the new Vite server, leaving two app windows).
 *
 * Wired as npm's `predev` / `predev:data`, so it runs automatically for
 * `yarn tauri dev`, `yarn tauri:dev:data` and plain `npm run dev` (Tauri's
 * beforeDevCommand is `npm run dev`). Run it on its own with `yarn dev:kill`.
 *
 * Safety: only processes that are (a) LISTENING on the Vite port, or
 * (b) executables inside THIS repo's src-tauri/target directory are killed.
 * An unrelated `app.exe` elsewhere on the machine (e.g. "ollama app.exe") is
 * never touched. Set CALCULA_SKIP_KILL=1 to disable entirely.
 */
import { execFileSync } from "child_process";
import * as net from "net";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "..");
const TARGET_DIR = path.join(APP_DIR, "src-tauri", "target").toLowerCase();
const VITE_PORT = Number(process.env.VITE_PORT ?? 5173);
const PORT_FREE_TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * PIDs LISTENING on `port`, excluding this process.
 *
 * Deliberately NO `-p TCP`: on Windows that filters to IPv4 only, and Vite
 * binds "localhost", which resolves to ::1 here -- so the listener that
 * actually blocks a restart shows up as `[::1]:5173` under TCPv6. Plain
 * `netstat -ano` lists both families.
 */
function pidsOnPort(port) {
  let out = "";
  try {
    out = execFileSync("netstat", ["-ano"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return []; // netstat unavailable -- nothing we can do
  }

  const pids = new Set();
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    // TCP  <local>  <remote>  LISTENING  <pid>   (UDP rows have no state -> skipped)
    if (parts.length < 5 || parts[0] !== "TCP" || parts[3] !== "LISTENING") continue;
    if (!new RegExp(`:${port}$`).test(parts[1])) continue;
    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

/** PIDs of Calcula binaries running out of this repo's target directory. */
function pidsOfStaleApp() {
  let json = "";
  try {
    json = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='app.exe' OR Name='Calcula.exe'\" " +
          "| Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress",
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
    ).trim();
  } catch {
    return [];
  }
  if (!json) return [];

  let rows;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) rows = [rows]; // ConvertTo-Json unwraps a single row

  return rows
    .filter((r) => typeof r?.ExecutablePath === "string")
    .filter((r) => r.ExecutablePath.toLowerCase().startsWith(TARGET_DIR))
    .map((r) => Number(r.ProcessId))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

/**
 * Can Vite actually bind the port right now?
 *
 * netstat is NOT a reliable answer: a force-killed process disappears from the
 * LISTENING list a moment before Windows releases its socket, so "no listener"
 * can still mean EADDRINUSE. Binding it ourselves -- on the same host Vite uses
 * -- is the only honest test.
 */
function isPortBindable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "localhost");
  });
}

/** Force-kill a process and its whole tree (WebView2 children included). */
function killTree(pid, what) {
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    console.log(`[dev] Killed ${what} (PID ${pid})`);
    return true;
  } catch {
    return false; // already gone, or not ours to kill
  }
}

if (process.env.CALCULA_SKIP_KILL === "1") {
  console.log("[dev] CALCULA_SKIP_KILL=1 -- skipping stale-instance cleanup.");
  process.exit(0);
}

// 1. The zombie app window (and its cargo parent, which exits once its child does).
for (const pid of pidsOfStaleApp()) {
  killTree(pid, "stale Calcula app");
}

// 2. Whatever still holds the Vite port -- kill it, then wait until the port is
//    genuinely bindable again (Windows frees the socket slightly after the
//    process dies). Re-killing each round also catches a listener that appeared
//    in the meantime.
const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
for (;;) {
  for (const pid of pidsOnPort(VITE_PORT)) {
    killTree(pid, `process on port ${VITE_PORT}`);
  }
  if (await isPortBindable(VITE_PORT)) break;
  if (Date.now() > deadline) {
    console.warn(
      `[dev] Port ${VITE_PORT} is still in use after ${PORT_FREE_TIMEOUT_MS / 1000}s -- ` +
        "starting anyway; Vite will report the conflict."
    );
    break;
  }
  await sleep(250);
}
