//! FILENAME: app/e2e/oracles/calculationBudget.ts
// PURPOSE: THE ANTI-FLAKE GATE for the formula evaluation budget. Asserts that
//          no cell in a soak or regression run ever becomes `#LIMIT!`.
// CONTEXT: The budget was made a DETERMINISTIC fuel counter rather than a wall
//          clock precisely so that a cell's value can never depend on machine
//          speed or ambient load (core/engine/src/budget.rs). That decision is
//          only worth something if it is checked.
//
//          Two different failures both show up here, and both matter:
//
//          1. CALIBRATION. The soak walker generates ordinary workbooks with
//             ordinary formulas. If `DEFAULT_CELL_FUEL` is set too low, one of
//             them trips, and a legitimate formula silently becomes an error.
//             That is a product bug affecting real users, and it must fail the
//             suite LOUDLY once rather than surface as an intermittent digest
//             mismatch that somebody eventually marks as a known issue.
//
//          2. NONDETERMINISM. If a budget ever became time-shaped — a wall
//             clock reintroduced on a cell path, a charge that depends on
//             iteration order — the same generated workbook would trip on a
//             loaded CI box and not on a fast laptop. The recalc-consistency
//             and save/reload oracles would then start disagreeing at random,
//             and the cause would be extremely hard to find from a digest diff.
//             This oracle names it directly.
//
//          Deliberately NOT suppressible through the known-issues ledger: an
//          entry there would convert exactly the signal this exists to produce
//          back into silence.

import type { Digest } from "./digest";
import type { OracleViolation } from "./types";

/** The calculation-budget error literal. Mirrors `CellError::Limit`. */
export const LIMIT_LITERAL = "#LIMIT!";

/**
 * How many offending cells to name in the message. A calibration bug tends to
 * hit many cells at once, and a violation listing 40,000 coordinates is not
 * more useful than one listing the first handful.
 */
const MAX_REPORTED = 8;

/**
 * Scan a workbook digest for cells that hit the calculation limit.
 *
 * Runs off the digest the checkpoint already captured, so it costs one walk of
 * data that is in memory anyway — no extra IPC, no extra recalculation.
 */
export function checkNoCalculationLimit(digest: Digest): OracleViolation[] {
  const hits: string[] = [];
  let total = 0;

  const sheets = digest.digest.sheets ?? [];
  for (const sheet of sheets) {
    const cells = sheet.cells ?? {};
    for (const [coord, cell] of Object.entries(cells)) {
      if (cell && typeof cell === "object" && cell.v === LIMIT_LITERAL) {
        total += 1;
        if (hits.length < MAX_REPORTED) {
          hits.push(`${sheet.name}!${coord}${cell.f ? ` (=${cell.f})` : ""}`);
        }
      }
    }
  }

  if (total === 0) return [];

  return [
    {
      oracleId: "no-calculation-limit",
      invariantId: "no-calculation-limit",
      message:
        `${total} cell(s) hit the formula calculation limit (${LIMIT_LITERAL}). ` +
        `The soak walker only generates ordinary formulas, so this is either a ` +
        `CALIBRATION bug (DEFAULT_CELL_FUEL is too small and legitimate work is ` +
        `being killed) or a DETERMINISM bug (something time-shaped crept onto a ` +
        `cell path, and this run will not reproduce). First offenders: ` +
        hits.join(", "),
      details: { count: total, offenders: hits },
    },
  ];
}
