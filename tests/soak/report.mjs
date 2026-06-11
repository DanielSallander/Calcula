/**
 * FILENAME: tests/soak/report.mjs
 * PURPOSE: Soak run report — machine-readable JSON + human markdown summary
 *          written to app/e2e/results/soak/<runId>/.
 */

import fs from "fs";
import path from "path";

export function writeReport(runDir, summary) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "soak-report.json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );
  fs.writeFileSync(path.join(runDir, "soak-summary.md"), renderSummary(summary), "utf8");
}

function renderSummary(s) {
  const lines = [
    `# Soak Run Summary — ${s.runId}`,
    "",
    `Mode: ${s.mode} | Started: ${s.startedAt} | Elapsed: ${Math.round(s.elapsedMs / 60000)} min`,
    "",
    "## Phases",
    "",
  ];

  for (const phase of s.phases) {
    const status = phase.success ? "[OK]" : phase.skipped ? "[SKIP]" : "[FAIL]";
    lines.push(`- ${status} **${phase.name}**${phase.note ? ` — ${phase.note}` : ""}`);
  }

  lines.push("");
  lines.push("## Walks");
  lines.push("");
  if (s.walks.length === 0) {
    lines.push("(none ran)");
  }
  for (const walk of s.walks) {
    lines.push(
      `- seed ${walk.seed}: ${walk.passed ? "passed" : `FAILED (${walk.violationId ?? "?"})`}` +
        `${walk.newFailures?.length ? ` — ${walk.newFailures.length} failure bundle(s)` : ""}`
    );
  }

  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (s.findings.length === 0) {
    lines.push("No new findings this run.");
  }
  for (const f of s.findings) {
    lines.push(
      `- **${f.bugId ?? "(dedup)"}** [${f.status}] ${f.violationId}: ${f.summary}` +
        `${f.minimizedActions ? ` (repro: ${f.minimizedActions} actions)` : ""}`
    );
  }

  if (s.fixes.length > 0) {
    lines.push("");
    lines.push("## Fix attempts");
    lines.push("");
    for (const fix of s.fixes) {
      lines.push(`- ${fix.bugId}: ${fix.outcome}${fix.files?.length ? ` — files: ${fix.files.join(", ")}` : ""}`);
    }
  }

  if (s.corpus) {
    lines.push("");
    lines.push("## Corpus");
    lines.push("");
    lines.push(
      `Entries added: ${s.corpus.added}, updated: ${s.corpus.updated}` +
        (s.corpus.note ? ` — ${s.corpus.note}` : "")
    );
  }

  lines.push("");
  lines.push("## Artifacts");
  lines.push("");
  lines.push(`- Failure bundles: ${s.failuresDir}`);
  lines.push(`- Bug ledger: tests/regression/bug-ledger.md`);
  lines.push("");

  return lines.join("\n");
}
