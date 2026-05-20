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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);
const STARTUP_TIMEOUT_MS = 180_000; // 3 min — first build can be slow
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

export default async function globalSetup() {
  // Manual mode — caller manages the app lifecycle.
  if (process.env.E2E_MANUAL === "1") {
    console.log("[e2e] Manual mode — expecting Calcula already running with CDP on port", CDP_PORT);
    await waitForCDP(CDP_PORT, 15_000);
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

  console.log("[e2e] Launching cargo tauri dev with CDP on port", CDP_PORT, "...");

  const child: ChildProcess = spawn("yarn", ["tauri", "dev"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      // Tell WebView2 to open a CDP port.
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Stream output so the user can see build progress.
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[tauri] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[tauri] ${d}`));

  child.on("error", (err) => {
    console.error("[e2e] Failed to start Tauri:", err.message);
  });

  // Save PID so teardown (and next run) can kill it.
  if (child.pid) {
    fs.writeFileSync(PID_FILE, String(child.pid));
  }

  // Wait for the CDP endpoint to appear.
  await waitForCDP(CDP_PORT, STARTUP_TIMEOUT_MS);
}
