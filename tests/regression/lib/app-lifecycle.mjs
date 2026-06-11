/**
 * FILENAME: tests/regression/lib/app-lifecycle.mjs
 * PURPOSE: Launch / wait-for / kill the Calcula app (Tauri + WebView2 with
 *          CDP). Extracted from regression-runner.mjs; shared by the
 *          regression and soak runners.
 */

import { execSync, spawn } from "child_process";
import { log } from "./exec.mjs";

/**
 * Launch the Calcula app with CDP enabled.
 * Uses PowerShell to source setup-rust-env.ps1 (MSVC environment), then runs
 * `yarn tauri dev` with WebView2 remote debugging.
 *
 * @param {{appDir: string, setupRustEnvPath: string, cdpPort: number}} opts
 * @returns {import("child_process").ChildProcess}
 */
export function launchApp({ appDir, setupRustEnvPath, cdpPort }) {
  log("  Launching Calcula with CDP on port " + cdpPort + "...");

  // Kill any leftover processes on the CDP port
  try {
    execSync(
      `powershell -Command "Get-NetTCPConnection -LocalPort ${cdpPort} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: "ignore" }
    );
  } catch { /* no process on port */ }

  const psScript = `
    & '${setupRustEnvPath}'
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=${cdpPort}'
    Set-Location '${appDir}'
    yarn tauri dev
  `;

  const child = spawn("powershell", ["-NoProfile", "-Command", psScript], {
    cwd: appDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    shell: false,
  });

  const logMilestone = (data) => {
    const line = data.toString();
    if (
      line.includes("Compiling") || line.includes("Finished") ||
      line.includes("Running") || line.includes("VITE") ||
      line.includes("ready in") || line.includes("error")
    ) {
      process.stdout.write(`  [tauri] ${line.trim()}\n`);
    }
  };
  child.stdout?.on("data", logMilestone);
  child.stderr?.on("data", logMilestone);

  child.on("error", (err) => {
    log("  Failed to start Tauri: " + err.message);
  });

  return child;
}

/**
 * Wait for CDP to become available on the given port.
 */
export async function waitForCDP(port, timeoutMs) {
  const http = await import("http");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/json/version`, (res) => {
        let body = "";
        res.on("data", (d) => (body += d.toString()));
        res.on("end", () => resolve(res.statusCode === 200));
      });
      req.on("error", () => resolve(false));
      req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    });

    if (ready) {
      log(`  CDP ready on port ${port} (took ${Math.round((Date.now() - start) / 1000)}s)`);
      return true;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  log(`  CDP not ready after ${Math.round(timeoutMs / 1000)}s`);
  return false;
}

/**
 * Kill the app process tree, orphaned app.exe processes, and anything on the
 * CDP port.
 */
export function killApp(child, cdpPort) {
  if (child && child.pid) {
    log("  Stopping Calcula (PID " + child.pid + ")...");
    try {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" });
    } catch { /* already gone */ }
  }
  try {
    execSync(`taskkill /F /IM app.exe`, { stdio: "ignore" });
  } catch { /* none running */ }
  try {
    execSync(
      `powershell -Command "Get-NetTCPConnection -LocalPort ${cdpPort} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: "ignore" }
    );
  } catch { /* nothing on port */ }
}

/**
 * Restart the app: kill, relaunch, wait for CDP.
 * @returns the new child process, or null if CDP never came up.
 */
export async function restartApp(child, opts, cdpTimeoutMs = 900_000) {
  killApp(child, opts.cdpPort);
  await new Promise((r) => setTimeout(r, 3000));
  const next = launchApp(opts);
  const ready = await waitForCDP(opts.cdpPort, cdpTimeoutMs);
  if (!ready) {
    killApp(next, opts.cdpPort);
    return null;
  }
  return next;
}
