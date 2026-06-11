//! FILENAME: app/e2e/oracles/recalcConsistency.ts
// PURPOSE: Recalculation consistency oracle. A full recalculation
//          (calculate_now) must not change any cell value — if it does, the
//          incremental dependency-graph recalc missed something, a classic
//          spreadsheet engine bug class.
//
// Volatile functions (NOW, TODAY, RAND, ...) legitimately change on recalc
// and are excluded, but cells whose formulas merely DEPEND on volatile cells
// are not detected — keep volatile functions out of generated test data.

import type { Page } from "@playwright/test";
import { getWorkbookDigest } from "./digest";
import type { CellDigestJson, SheetDigestJson } from "./digest";
import type { OracleViolation } from "./types";

const VOLATILE_FORMULA =
  /\b(NOW|TODAY|RAND|RANDBETWEEN|RANDARRAY|INDIRECT|OFFSET)\s*\(/i;

export async function checkRecalcConsistency(
  page: Page
): Promise<OracleViolation[]> {
  const before = await getWorkbookDigest(page, { cellsOnly: true });

  const recalcError = (await page.evaluate(async () => {
    const tauri = (window as any).__TAURI__;
    try {
      await tauri.core.invoke("calculate_now");
      return null;
    } catch (e) {
      return String(e);
    }
  })) as string | null;

  if (recalcError !== null) {
    return [
      {
        invariantId: "recalc-consistency",
        oracleId: "recalc-consistency",
        message: `calculate_now failed: ${recalcError}`,
        details: {},
      },
    ];
  }

  const after = await getWorkbookDigest(page, { cellsOnly: true });

  const changes: Array<{ sheet: number; cell: string; before: string; after: string }> = [];
  const sheetsBefore = (before.digest.sheets ?? []) as SheetDigestJson[];
  const sheetsAfter = (after.digest.sheets ?? []) as SheetDigestJson[];

  for (let i = 0; i < Math.max(sheetsBefore.length, sheetsAfter.length); i++) {
    const cellsBefore = sheetsBefore[i]?.cells ?? {};
    const cellsAfter = sheetsAfter[i]?.cells ?? {};
    const keys = new Set([...Object.keys(cellsBefore), ...Object.keys(cellsAfter)]);
    for (const key of keys) {
      const a: CellDigestJson | undefined = cellsBefore[key];
      const b: CellDigestJson | undefined = cellsAfter[key];
      const formula = a?.f ?? b?.f ?? "";
      if (formula && VOLATILE_FORMULA.test(formula)) continue;
      const va = JSON.stringify({ v: a?.v, raw: a?.raw });
      const vb = JSON.stringify({ v: b?.v, raw: b?.raw });
      if (va !== vb) {
        changes.push({ sheet: i, cell: key, before: va, after: vb });
      }
    }
  }

  if (changes.length > 0) {
    const first = changes[0];
    return [
      {
        invariantId: "recalc-consistency",
        oracleId: "recalc-consistency",
        message:
          `Full recalculation changed ${changes.length} cell(s) — the ` +
          `incremental recalc had produced different values. First: sheet ` +
          `${first.sheet} cell ${first.cell}: ${first.before} -> ${first.after}`,
        details: { changes: changes.slice(0, 25) },
      },
    ];
  }

  return [];
}
