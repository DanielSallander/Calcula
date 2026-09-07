//! FILENAME: tests/eval/lib/appBundle.mjs
// PURPOSE: Bundle the product's own TypeScript modules so an eval runner can
//          call them from Node, instead of porting them and measuring the port.
// CONTEXT: Extracted from `run-eval.mjs`, which had it inline, when a second
//          runner (`run-formula-eval.mjs`) needed the same thing. Two copies of
//          this would drift on the first change to a bundle path, and the
//          symptom would be an eval quietly scoring a stale build.
//
//          Node cannot import the `.ts` sources directly, and adding a loader
//          for one script is a dependency for no gain — the same reasoning
//          `gen-script-typings.mjs` records.

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

/** Bundle dirs older than this are debris from a crashed run, not a live one. */
const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Bundle a set of app modules and import the result.
 *
 * `exports` is a list of `{ from, names }`: `from` is a path relative to
 * `app/`, and `names` is either `"*"` for a star re-export or an array of named
 * exports. The caller names what it needs so the bundle stays as small as the
 * run requires.
 *
 * Returns `{ mod, bundlePath, outDir }`. The bundle is left on disk — a caller
 * may need to hand its path to a subprocess — and removed on process exit.
 */
export async function bundleAppModules({ appRoot, exports: wanted, tag = "eval" }) {
  // esbuild lives in app/node_modules and this runs from tests/, so it is
  // resolved from the app's package rather than from here. Imported lazily so a
  // usage message still works in a checkout with no npm install.
  const appRequire = createRequire(path.join(appRoot, "package.json"));
  const { build } = await import(pathToFileURL(appRequire.resolve("esbuild")).href);

  const cacheRoot = path.join(appRoot, "node_modules", ".cache");
  // Sweep bundle dirs leaked by crashed runs: the exit handler cannot fire on a
  // SIGKILL or a task-manager kill, pids recycle, and nothing else reclaims
  // them. Anything older than an hour is not a concurrent run.
  try {
    for (const entry of readdirSync(cacheRoot)) {
      if (!entry.startsWith("calcula-eval-")) continue;
      const dir = path.join(cacheRoot, entry);
      if (Date.now() - statSync(dir).mtimeMs > STALE_AFTER_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch {
    /* a missing cache dir or a locked stale dir is not worth failing the run */
  }

  const outDir = path.join(cacheRoot, `calcula-eval-${tag}-${process.pid}`);
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, "eval.mjs");
  const entryFile = path.join(outDir, "entry.ts");

  const lines = wanted.map(({ from, names }) => {
    const spec = JSON.stringify(path.join(appRoot, from).replace(/\\/g, "/"));
    return names === "*"
      ? `export * from ${spec};`
      : `export { ${names.join(", ")} } from ${spec};`;
  });
  writeFileSync(entryFile, lines.join("\n"), "utf8");

  await build({
    entryPoints: [entryFile],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    logLevel: "silent",
  });

  const mod = await import(`file://${outfile.replace(/\\/g, "/")}`);
  process.on("exit", () => {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* a transient lock on a temp dir is not worth failing the run over */
    }
  });
  return { mod, bundlePath: outfile, outDir };
}
