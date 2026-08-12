/**
 * FILENAME: tests/soak/bug-ledger.mjs
 * PURPOSE: The bug ledger — machine-readable record of every bug found by
 *          the soak system. tests/regression/bug-ledger.json is the source
 *          of truth; bug-ledger.md is a generated human view (committed).
 *
 * Statuses: open -> triaged -> fixed -> verified-by-user | suppressed |
 *           wontfix | expected-behavior | fix-failed
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const LEDGER_JSON = path.join(PROJECT_ROOT, "tests", "regression", "bug-ledger.json");
const LEDGER_MD = path.join(PROJECT_ROOT, "tests", "regression", "bug-ledger.md");

export function loadLedger() {
  if (!fs.existsSync(LEDGER_JSON)) {
    return { version: 1, nextId: 1, bugs: [] };
  }
  return JSON.parse(fs.readFileSync(LEDGER_JSON, "utf8"));
}

export function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_JSON, JSON.stringify(ledger, null, 2), "utf8");
  fs.writeFileSync(LEDGER_MD, renderMarkdown(ledger), "utf8");
}

/**
 * The next free id, derived from the ENTRIES rather than from the counter.
 *
 * `nextId` is a hint, not the authority. Entries filed by hand -- BUG-0024
 * through BUG-0028 all were, from e2e and review passes rather than from a
 * soak run -- never bump it, so on 2026-08-12 the file held five bugs above a
 * `nextId` of 24. The next soak finding would have been issued "BUG-0024" a
 * second time, and `updateBug` resolves an id with `.find`, so every later
 * patch would have silently landed on the FIRST entry with that id: a triaged,
 * fixed, already-closed bug rewritten by an unrelated one.
 *
 * Deriving from the maximum makes a hand-edited ledger safe by construction and
 * keeps the counter as a floor, so ids still never go backwards even if an
 * entry is deleted.
 */
export function nextFreeId(ledger) {
  const highest = (ledger.bugs ?? []).reduce((max, b) => {
    const m = /^BUG-(\d+)$/.exec(b?.id ?? "");
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return Math.max(ledger.nextId ?? 1, highest + 1);
}

/** Add a bug; returns the assigned id (e.g. "BUG-0003"). */
export function addBug(ledger, bug) {
  const n = nextFreeId(ledger);
  const id = `BUG-${String(n).padStart(4, "0")}`;
  ledger.nextId = n + 1;
  ledger.bugs.push({ id, status: "open", ...bug });
  return id;
}

export function updateBug(ledger, id, patch) {
  const matches = (ledger.bugs ?? []).filter((b) => b.id === id);
  if (matches.length === 0) throw new Error(`Unknown bug id: ${id}`);
  if (matches.length > 1) {
    // Never patch one of several: a duplicate id means the allocator was
    // bypassed, and picking the first is exactly how the wrong bug gets
    // rewritten. Fail loudly instead.
    throw new Error(
      `Duplicate bug id ${id}: ${matches.length} entries share it. The ledger ` +
        `has been edited by hand past its allocator; renumber before writing.`,
    );
  }
  Object.assign(matches[0], patch);
  return matches[0];
}

/** Find an existing open/triaged bug matching an oracle + diff-path profile
 *  (avoids duplicate ledger entries for the same underlying bug). */
export function findSimilarBug(ledger, oracleId, digestDiffPaths) {
  const prefixes = (digestDiffPaths ?? []).map((p) => p.split(".")[0]);
  return ledger.bugs.find((b) => {
    if (b.violation?.oracleId !== oracleId) return false;
    if (["fixed", "verified-by-user", "wontfix"].includes(b.status)) return false;
    const bugPrefixes = (b.violation?.digestDiffPaths ?? []).map((p) => p.split(".")[0]);
    return prefixes.some((p) => bugPrefixes.some((bp) => p === bp || bp.startsWith(p)));
  });
}

export function renderMarkdown(ledger) {
  const lines = [
    "# Bug Ledger",
    "",
    "Bugs found by the automated soak/oracle system.",
    "GENERATED from bug-ledger.json by tests/soak/bug-ledger.mjs — do not edit by hand.",
    "",
    `Total: ${ledger.bugs.length} | Open: ${count(ledger, "open")} | ` +
      `Triaged: ${count(ledger, "triaged")} | Fixed: ${count(ledger, "fixed")} | ` +
      `Other: ${ledger.bugs.length - count(ledger, "open") - count(ledger, "triaged") - count(ledger, "fixed")}`,
    "",
  ];

  for (const bug of ledger.bugs) {
    lines.push(`## ${bug.id} \`[${bug.status}]\``);
    lines.push("");
    lines.push(`**Found:** ${bug.discovered ?? "?"} (${bug.source?.kind ?? "?"}${bug.source?.seed ? `, seed ${bug.source.seed}` : ""})`);
    lines.push(`**Oracle:** ${bug.violation?.oracleId ?? "?"}`);
    lines.push("");
    lines.push(bug.violation?.message ?? "(no message)");
    lines.push("");
    if (bug.repro?.trace) {
      lines.push(`**Repro:** \`${bug.repro.trace}\` (${bug.repro.actionCount ?? "?"} actions)`);
    } else if (bug.repro?.description) {
      lines.push(`**Repro:** ${bug.repro.description}`);
    }
    if (bug.triage?.verdict) {
      lines.push(
        `**Triage:** ${bug.triage.verdict} (confidence ${bug.triage.confidence ?? "?"}) — ` +
          `${bug.triage.rootCauseHypothesis ?? ""}`
      );
    }
    if (bug.fix?.status && bug.fix.status !== "open") {
      lines.push(`**Fix:** ${bug.fix.status}${bug.fix.diffSummary ? ` — ${bug.fix.diffSummary}` : ""}`);
      if (bug.fix.filesChanged?.length) {
        lines.push(`  Files: ${bug.fix.filesChanged.join(", ")}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function count(ledger, status) {
  return ledger.bugs.filter((b) => b.status === status).length;
}
