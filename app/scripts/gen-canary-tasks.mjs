//! FILENAME: app/scripts/gen-canary-tasks.mjs
// PURPOSE: Generate app/src/api/scriptHost/generated/canaryTasks.ts from the
//          eval corpus — `npm run gen:canary-tasks` (add --check to verify).
// CONTEXT: Owner decision §11.3 — the in-app probe's `canaryScore` and the CI
//          corpus must read the SAME task definitions, so the number a user sees
//          in the model picker and the number CI reports cannot diverge.
//
//          The corpus lives at tests/eval/tasks.json, deliberately outside
//          `app/` (it ships as a public developer artifact). Vite cannot import
//          across the project root, so the canary subset is generated IN rather
//          than imported. `canaryTasks.test.ts` re-derives it from the corpus at
//          test time and fails when the committed file drifts.
//
//          REFERENCE SOLUTIONS ARE STRIPPED. The probe scores a MODEL's answer;
//          shipping the answers would put ~8 KB of dead weight in the renderer
//          bundle and, worse, would sit in the same process as the thing being
//          measured.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const repoRoot = path.resolve(appRoot, "..");

const CORPUS = path.join(repoRoot, "tests", "eval", "tasks.json");
const OUTPUT = path.join(appRoot, "src", "api", "scriptHost", "generated", "canaryTasks.ts");

const checkOnly = process.argv.includes("--check");

/** Build the module text. Exported so the lockstep test uses THIS function. */
export function renderCanaryModule(corpus) {
  const canaries = corpus.tasks
    .filter((t) => t.canary)
    .map((t) => ({
      id: t.id,
      objectType: t.objectType,
      intent: t.intent,
      hints: t.hints,
      expectCapabilities: t.expectCapabilities,
      mustCall: t.mustCall,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const rows = canaries.map((t) => `  ${JSON.stringify(t)},`);

  return [
    "// =============================================================================",
    "// GENERATED FILE - DO NOT EDIT.",
    "// =============================================================================",
    "// Produced by:  npm run gen:canary-tasks",
    "// Source:       tests/eval/tasks.json  (tasks marked `canary: true`)",
    "//",
    "// The in-app probe's canaryScore runs THESE, and the CI corpus check runs the",
    "// same definitions from the same file. That is what stops the number a user",
    "// sees in the model picker from drifting away from the number CI reports.",
    "//",
    "// Reference solutions are deliberately stripped: the probe scores a MODEL's",
    "// answer, and shipping the answers alongside the questions would put dead",
    "// weight in the renderer bundle.",
    "// =============================================================================",
    "",
    "/** One probe task. A subset of the corpus shape — no reference solution. */",
    "export interface CanaryTask {",
    "  readonly id: string;",
    "  readonly objectType: string;",
    "  readonly intent: string;",
    "  readonly hints: readonly string[];",
    "  readonly expectCapabilities: readonly string[];",
    "  readonly mustCall: readonly string[];",
    "}",
    "",
    "export const CANARY_TASKS: readonly CanaryTask[] = [",
    ...rows,
    "];",
    "",
  ].join("\n");
}

// --- CLI --------------------------------------------------------------------
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const corpus = JSON.parse(readFileSync(CORPUS, "utf8"));
  const output = renderCanaryModule(corpus);

  let existing = null;
  try {
    existing = readFileSync(OUTPUT, "utf8");
  } catch {
    existing = null;
  }

  if (checkOnly) {
    if (existing !== output) {
      console.error("[FAIL] " + path.relative(appRoot, OUTPUT) + " is stale. Run: npm run gen:canary-tasks");
      process.exit(1);
    }
    console.log("[OK] canary tasks are current.");
  } else if (existing === output) {
    console.log("[OK] canary tasks already current (no write).");
  } else {
    mkdirSync(path.dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, output, "utf8");
    console.log("[OK] wrote " + path.relative(appRoot, OUTPUT));
  }
  const n = corpus.tasks.filter((t) => t.canary).length;
  console.log(`[OK] ${n} canary task(s) of ${corpus.tasks.length} in the corpus.`);
}
