//! FILENAME: app/e2e/scenarios/lib/scenario.ts
// PURPOSE: Scenario DSL — long, real-user workflows broken into phases, with
//          the semantic oracle battery (undo round-trip, save/reload
//          round-trip, recalc consistency) verified after EVERY phase plus
//          optional targeted assertions and screenshot checkpoints.
//
// A scenario is a serial test suite: each phase is a Playwright test, state
// carries over between phases (single app instance), and the first test
// resets to a fresh workbook.
//
// Locale note (sv-SE): formulas entered via grid.setCellValueDirect must use
// ';' as the argument separator (update_cell delocalizes input).
//
// Usage:
//   defineScenario("monthly-report", [
//     { name: "enter data", behaviors: ["edit.bulk-entry"],
//       async run({ grid }) { ... },
//       async assertions({ grid }) { expect(...) },
//       screenshot: "monthly-report-data" },
//     ...
//   ]);

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../../fixtures";
import type { GridHelper } from "../../helpers/grid";
import { OracleBattery } from "../../oracles";
import type { OracleBaseline, OracleViolation } from "../../oracles/types";
import { takeCheckpoint, softly } from "../../helpers/screenshots";
import { deepResetForWalk } from "../../walker/reset";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORACLE_TMP_DIR = path.resolve(HERE, "../../results/soak/tmp");

export interface ScenarioContext {
  page: Page;
  grid: GridHelper;
}

export type OracleName = "undo" | "saveReload" | "recalc";

export interface ScenarioPhase {
  name: string;
  /** Expected-behavior IDs this phase exercises (docs/expected-behavior.md).
   *  Used by coverage tooling; purely declarative here. */
  behaviors?: string[];
  /** Perform the user actions of this phase. */
  run(ctx: ScenarioContext): Promise<void>;
  /** Targeted assertions after the actions (optional). */
  assertions?(ctx: ScenarioContext): Promise<void>;
  /** Which oracles RUN after this phase. Default: all three. Excluded
   *  oracles are NOT EXECUTED (not merely filtered): the save/reload oracle
   *  mutates state via open_file, so running it "for measurement" while a
   *  persistence bug is open would corrupt the rest of the scenario. */
  oracles?: OracleName[];
  /** Screenshot checkpoint name (soft — missing baseline only warns). */
  screenshot?: string;
}

const ALL_ORACLES: OracleName[] = ["undo", "saveReload", "recalc"];

const DISABLE_KEY: Record<
  OracleName,
  "undo-round-trip" | "save-reload-round-trip" | "recalc-consistency"
> = {
  undo: "undo-round-trip",
  saveReload: "save-reload-round-trip",
  recalc: "recalc-consistency",
};

function formatViolations(violations: OracleViolation[]): string {
  return violations
    .map((v) => {
      const diffs = v.digestDiff?.diffs ?? [];
      const diffLines = diffs
        .slice(0, 10)
        .map(
          (d) =>
            `  diff: ${d.path}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`
        )
        .join("\n");
      return `[${v.invariantId}] ${v.message}` + (diffLines ? `\n${diffLines}` : "");
    })
    .join("\n\n");
}

/**
 * Define a scenario as a serial Playwright suite with oracle checkpoints
 * after every phase.
 */
export function defineScenario(name: string, phases: ScenarioPhase[]): void {
  test.describe.serial(`Scenario: ${name}`, () => {
    // Phases are long; budget generously per phase.
    test.setTimeout(240_000);

    test(`00 reset workbook`, async ({ appPage }) => {
      // Thorough reset: walks and earlier scenarios share the app instance,
      // and plain new_file leaks object state (BUG-0004).
      await deepResetForWalk(appPage);
      await appPage.waitForTimeout(300);
    });

    phases.forEach((phase, index) => {
      const label = `${String(index + 1).padStart(2, "0")} ${phase.name}`;
      test(label, async ({ appPage, gridPersistent }) => {
        const ctx: ScenarioContext = { page: appPage, grid: gridPersistent };

        // Per-phase battery: excluded oracles are disabled (never executed).
        const enabled = phase.oracles ?? ALL_ORACLES;
        const battery = new OracleBattery({
          tmpDir: ORACLE_TMP_DIR,
          saveReloadEvery: 1, // when enabled, save/reload runs every phase
          disable: ALL_ORACLES.filter((o) => !enabled.includes(o)).map(
            (o) => DISABLE_KEY[o]
          ),
        });
        const baseline: OracleBaseline = await battery.begin(appPage);

        await phase.run(ctx);
        await appPage.waitForTimeout(300);

        if (phase.assertions) {
          await phase.assertions(ctx);
        }

        const result = await battery.checkpoint(appPage, baseline);
        expect(
          result.violations.length,
          `Oracle violations after phase "${phase.name}":\n${formatViolations(result.violations)}`
        ).toBe(0);

        if (phase.screenshot) {
          await softly(takeCheckpoint(appPage, phase.screenshot));
        }
      });
    });
  });
}

// ============================================================================
// Shared helpers for scenario authors
// ============================================================================

/** Bulk-load a 2D block of values via the batch Tauri command.
 *  startRow/startCol are 0-based. */
export async function loadBlock(
  page: Page,
  startRow: number,
  startCol: number,
  data: string[][]
): Promise<void> {
  await page.evaluate(
    async ({ startRow, startCol, data }) => {
      const tauri = (window as any).__TAURI__;
      const updates = data.flatMap((row, r) =>
        row.map((value, c) => ({ row: startRow + r, col: startCol + c, value }))
      );
      await tauri.core.invoke("update_cells_batch", { updates });
      window.dispatchEvent(new Event("grid:refresh"));
    },
    { startRow, startCol, data }
  );
  await page.waitForTimeout(400);
}

/** Invoke a Tauri command from scenario code (thin sugar). */
export async function invokeTauri(
  page: Page,
  command: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  return page.evaluate(
    async ({ command, args }) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke(command, args);
    },
    { command, args }
  );
}
