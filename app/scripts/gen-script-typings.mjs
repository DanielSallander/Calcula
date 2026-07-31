//! FILENAME: app/scripts/gen-script-typings.mjs
// PURPOSE: CLI for the object-script typings generator —
//          `npm run gen:script-typings` (add --check to verify without writing).
// CONTEXT: The generator itself is TypeScript and imports the real worker
//          context shim, so it is bundled with esbuild (already present as a
//          Vite dependency) and executed in-process. Node cannot import the
//          .ts sources directly, and adding ts-node/tsx for one script would be
//          a new dependency for no gain.
//
//          The SAME generator runs in the lockstep unit test
//          (app/extensions/ScriptableObjects/__tests__/objectContextsTypings.test.ts),
//          so "the committed file is what this script produces" is enforced by
//          the test suite, not by remembering to run this.

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";


const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");

const TEMPLATE = path.join(here, "scriptTypings", "objectContexts.template.d.ts");
const OUTPUT = path.join(appRoot, "extensions", "ScriptableObjects", "objectContexts.d.ts");
const ENTRY = path.join(here, "scriptTypings", "generateObjectContexts.ts");

const checkOnly = process.argv.includes("--check");

async function loadGenerator() {
  // Inside node_modules/.cache, NOT the OS temp dir: `typescript` is left
  // external (below), so the emitted module must sit somewhere Node's resolver
  // can still find app/node_modules from.
  const outDir = path.join(appRoot, "node_modules", ".cache", `calcula-script-typings-${process.pid}`);
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, "generator.mjs");
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    logLevel: "silent",
    // `typescript` is a real npm package with its own resolution; leaving it
    // external keeps the bundle small and avoids re-parsing 10 MB of compiler.
    external: ["typescript"],
  });
  const mod = await import(pathToFileURL(outfile).href);
  rmSync(outDir, { recursive: true, force: true });
  return mod;
}

const { generateObjectContexts } = await loadGenerator();
const template = readFileSync(TEMPLATE, "utf8");
const result = generateObjectContexts(template, path.basename(TEMPLATE));

if (result.problems.length > 0) {
  console.error("[FAIL] the typings and the script shim disagree:\n");
  for (const problem of result.problems) console.error("  - " + problem);
  console.error(
    "\nFix the template at " +
      path.relative(appRoot, TEMPLATE) +
      " and re-run. The generator will not emit a knowingly wrong .d.ts.",
  );
  process.exit(1);
}

if (result.unverified.length > 0) {
  console.log(
    "[INFO] declared but not reachable by the runtime probe (data shapes, awaited results): " +
      result.unverified.join(", "),
  );
}

const existing = (() => {
  try {
    return readFileSync(OUTPUT, "utf8");
  } catch {
    return null;
  }
})();

if (checkOnly) {
  if (existing !== result.output) {
    console.error("[FAIL] " + path.relative(appRoot, OUTPUT) + " is stale. Run: npm run gen:script-typings");
    process.exit(1);
  }
  console.log("[OK] typings are current.");
} else {
  if (existing === result.output) {
    console.log("[OK] typings already current (no write).");
  } else {
    writeFileSync(OUTPUT, result.output, "utf8");
    console.log("[OK] wrote " + path.relative(appRoot, OUTPUT));
  }
}

console.log(
  `[OK] ${result.stats.interfaces} interfaces verified, ${result.stats.members} members probed, ` +
    `${result.stats.documented} carry generated broker policy.`,
);

// The probe arms RPC deadline timers inside the shim; they are cleared, but a
// bundled worker realm may still hold a microtask. Exit explicitly.
process.exit(0);
