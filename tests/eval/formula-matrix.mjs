//! FILENAME: tests/eval/formula-matrix.mjs
// PURPOSE: Run the formula eval across a grid of configurations, one at a time,
//          and print the table the design decisions rest on.
// CONTEXT: M0 of the AI plan has to answer three questions with numbers rather
//          than argument: which model to default to, whether constraining the
//          reply shape helps, and whether the prompt's context block and worked
//          examples earn the seconds they cost. Each is a cell in this grid.
//
//          STRICTLY SEQUENTIAL, and that is not laziness. Local inference is
//          CPU-bound here; two runs at once starve each other and every latency
//          number in both becomes meaningless. The repo has already been caught
//          by this once, when a "failure" during a live probe turned out to be
//          contention.
//
// USAGE
//   node tests/eval/formula-matrix.mjs --models llama3.2:1b,qwen2.5-coder:3b \
//        --out out/matrix --split hand
//   node tests/eval/formula-matrix.mjs --models qwen2.5:7b --cells schema,retrieval

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const models = String(arg("models", "")).split(",").map((s) => s.trim()).filter(Boolean);
const provider = String(arg("provider", "ollama"));
const split = String(arg("split", "hand"));
const outDir = path.resolve(String(arg("out", "out/matrix")));
const only = String(arg("cells", "all"));

if (models.length === 0) {
  console.error("Usage: node tests/eval/formula-matrix.mjs --models a,b [--provider p] [--out dir]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

/**
 * The cells, and why each one exists.
 *
 * `baseline` is the shipped-intent configuration. Every other cell changes ONE
 * thing from it, so the pair can be compared with McNemar and the difference
 * attributed to that thing. A cell that changed two would answer nothing.
 */
const ALL_CELLS = [
  { key: "baseline", label: "schema+context+retrieval", args: ["--schema", "on", "--context", "on", "--retrieval", "3"] },
  { key: "retrieval", label: "no retrieval", args: ["--schema", "on", "--context", "on", "--retrieval", "0"] },
  { key: "context", label: "no context", args: ["--schema", "on", "--context", "off", "--retrieval", "3"] },
  { key: "schema", label: "no schema", args: ["--schema", "off", "--context", "on", "--retrieval", "3"] },
];
const cells = only === "all" ? ALL_CELLS : ALL_CELLS.filter((c) => c.key === "baseline" || only.split(",").includes(c.key));

const rows = [];
for (const model of models) {
  for (const cell of cells) {
    const file = path.join(outDir, `${model.replace(/[:/]/g, "_")}--${cell.key}.json`);
    if (existsSync(file)) {
      console.log(`[matrix] ${model} / ${cell.key}: reusing ${path.basename(file)}`);
    } else {
      console.log(`[matrix] ${model} / ${cell.key} (${cell.label}) ...`);
      const r = spawnSync(
        process.execPath,
        [
          path.join(here, "run-formula-eval.mjs"),
          "--provider", provider,
          "--model", model,
          "--split", split,
          ...cell.args,
          "--json", file,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      if (r.status !== 0 && !existsSync(file)) {
        console.error(`[matrix] ${model} / ${cell.key} produced no results; skipping`);
        continue;
      }
    }
    const data = JSON.parse(readFileSync(file, "utf8"));
    rows.push({ model, cell: cell.key, label: cell.label, ...data.summary, file });
  }
}

console.log("\n=== formula eval matrix ===\n");
const header = ["model", "cell", "pass", "rate", "median ms", "p90 ms", "prompt tok", "no formula"];
const widths = [22, 10, 7, 7, 10, 8, 11, 11];
const line = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join(" ");
console.log(line(header));
console.log(widths.map((w) => "-".repeat(w)).join(" "));
for (const r of rows) {
  console.log(
    line([
      r.model,
      r.cell,
      `${r.passed}/${r.ran}`,
      `${(r.passRate * 100).toFixed(1)}%`,
      r.medianMs,
      r.p90Ms,
      r.meanPromptTokens,
      r.noFormulaReplies,
    ]),
  );
}

console.log(
  "\nA pass rate difference is not a finding on its own. Compare a pair with:\n" +
    "  node tests/eval/compare-runs.mjs <baseline.json> <variant.json>",
);
