/**
 * FILENAME: tests/regression/lib/exec.mjs
 * PURPOSE: Shared shell/logging utilities for the regression and soak
 *          runners. Extracted from regression-runner.mjs so both runners
 *          use identical machinery.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export function timestamp() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z/, "");
}

export function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

/**
 * Run a shell command synchronously, never throwing.
 * @returns {{success: boolean, output: string, code: number}}
 */
export function execCmd(cmd, options = {}) {
  const opts = {
    stdio: "pipe",
    timeout: 600_000, // 10 min default
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  };
  try {
    const result = execSync(cmd, opts);
    return { success: true, output: result?.toString() || "", code: 0 };
  } catch (err) {
    return {
      success: false,
      output: (err.stdout?.toString() || "") + "\n" + (err.stderr?.toString() || ""),
      code: err.status || 1,
    };
  }
}

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Recursively find files under `dir` whose names end with `suffix`. */
export function findFiles(dir, suffix) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, suffix));
    } else if (entry.name.endsWith(suffix)) {
      results.push(fullPath);
    }
  }
  return results;
}
