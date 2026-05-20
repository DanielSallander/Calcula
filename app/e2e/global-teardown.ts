/**
 * Global teardown: kills the Tauri dev process launched by global-setup.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(__dirname, ".tauri-pid");

export default async function globalTeardown() {
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
