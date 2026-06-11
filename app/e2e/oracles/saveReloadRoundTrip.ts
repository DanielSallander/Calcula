//! FILENAME: app/e2e/oracles/saveReloadRoundTrip.ts
// PURPOSE: Save/reload round-trip oracle. Saving to .cala and reopening the
//          file must reproduce the same workbook state. Catches persistence
//          gaps (features not saved, not restored, or restored differently).
//
// IMPORTANT side effects:
//  - open_file CLEARS the undo stack. The caller must reset its undo baseline
//    after this oracle runs (signalled via `undoBaselineReset`).
//  - The baseline digest is captured AFTER save (save_file may run a full
//    recalculation when calculate_before_save is enabled; capturing after
//    save excludes that mutation from the comparison).

import type { Page } from "@playwright/test";
import * as path from "node:path";
import * as fs from "node:fs";
import { getWorkbookDigest, diffDigests } from "./digest";
import type { OracleContext, OracleViolation } from "./types";

let saveCounter = 0;

export async function checkSaveReloadRoundTrip(
  ctx: OracleContext
): Promise<OracleViolation[]> {
  const { page, tmpDir } = ctx;
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(
    tmpDir,
    `oracle-save-${process.pid}-${saveCounter++}.cala`
  );

  // ---- Save ----
  const saveError = (await page.evaluate(async (p) => {
    const tauri = (window as any).__TAURI__;
    try {
      await tauri.core.invoke("save_file", { path: p });
      return null;
    } catch (e) {
      return String(e);
    }
  }, filePath)) as string | null;

  if (saveError !== null) {
    return [
      {
        invariantId: "save-reload-round-trip",
        oracleId: "save-reload-round-trip",
        message: `save_file failed: ${saveError}`,
        details: { filePath, stage: "save" },
      },
    ];
  }

  // Baseline: state as it exists right after saving.
  const before = await getWorkbookDigest(page);

  // ---- Reload ----
  const openError = (await page.evaluate(async (p) => {
    const tauri = (window as any).__TAURI__;
    try {
      await tauri.core.invoke("open_file", { path: p });
      window.dispatchEvent(new Event("grid:refresh"));
      return null;
    } catch (e) {
      return String(e);
    }
  }, filePath)) as string | null;

  if (openError !== null) {
    return [
      {
        invariantId: "save-reload-round-trip",
        oracleId: "save-reload-round-trip",
        message: `open_file failed on a file the app just saved: ${openError}`,
        details: { filePath, stage: "open" },
      },
    ];
  }

  // Give async restoration (pivots, extensions reacting to load events) a
  // moment to settle before digesting.
  await page.waitForTimeout(500);

  const after = await getWorkbookDigest(page);
  const diff = diffDigests(before, after, "saveReload");

  cleanupQuietly(filePath);

  if (!diff.equal) {
    const first = diff.diffs[0];
    return [
      {
        invariantId: "save-reload-round-trip",
        oracleId: "save-reload-round-trip",
        message:
          `Workbook state changed across save/reload. ` +
          `${diff.diffs.length}${diff.truncated ? "+" : ""} differences; ` +
          `first: ${first.path}: ${JSON.stringify(first.before)} -> ` +
          `${JSON.stringify(first.after)}`,
        details: { filePath },
        digestDiff: diff,
      },
    ];
  }

  return [];
}

function cleanupQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Leave the temp file for forensics if deletion fails.
  }
}
