#!/usr/bin/env node
//! FILENAME: app/scripts/check-line-endings.mjs
// PURPOSE: Fail when any tracked source file carries MIXED line endings.
// CONTEXT: A file that is mostly CRLF with a handful of LF lines (or the
//          reverse) silently breaks exact-string edits: a tool that reads the
//          file, matches an LF-normalised snippet and writes it back finds no
//          match in the CRLF region and NO-OPS without error. That is not a
//          cosmetic problem — it is a class of edits that appear to succeed and
//          change nothing. Seven files in this repo were in that state.
//
// WHY THIS AND NOT .gitattributes
//   A `.gitattributes` with `* text=auto` fixes endings at CHECKOUT: git stores
//   LF in the index and materialises one ending per platform on the way out. It
//   is a real mechanism, but it is the wrong one for this failure:
//
//     1. The damage happens in the WORKING TREE, between checkouts. A tool that
//        rewrites one hunk with the wrong ending produces a mixed file that
//        git will not touch until the next checkout — which may be never on a
//        single-developer Windows repo. This check runs where the hazard lives.
//     2. Turning `text=auto` on retroactively renormalises essentially every
//        file in the repository on the next checkout. This tree contains
//        byte-exact fixtures and snapshot baselines; a mass ending rewrite is a
//        change that has to be verified, not assumed, and that verification
//        needs git operations.
//
//   The two are complementary rather than alternatives. If a `.gitattributes`
//   is added later, this check still earns its place: it catches the mixed file
//   the moment it is written, instead of at the next checkout.
//
// USAGE
//   node scripts/check-line-endings.mjs          # report + non-zero exit
//   node scripts/check-line-endings.mjs --fix    # normalise to each file's
//                                                # DOMINANT ending, then report

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SKIP_DIRS = new Set([
  "node_modules", "target", ".git", "dist", "coverage", "playwright-report",
  "test-results", ".vite", "output", "xlsx-workbooks", "__snapshots__",
]);

const EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".json", ".md",
  ".toml", ".html", ".css", ".ps1", ".yml", ".yaml",
]);

/** Count line terminators without loading the file as a string. */
export function countEndings(buf) {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
      crlf++;
      i++;
    } else if (buf[i] === 0x0a) {
      lf++;
    }
  }
  return { crlf, lf };
}

/** Every candidate source file under `root`, relative-pathed. */
export function collectSourceFiles(root = REPO_ROOT) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (EXTENSIONS.has(path.extname(entry.name))) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Files whose endings are mixed. Each entry carries the DOMINANT target. */
export function findMixedLineEndings(root = REPO_ROOT) {
  const mixed = [];
  for (const file of collectSourceFiles(root)) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (buf.length > 8_000_000) continue;
    const { crlf, lf } = countEndings(buf);
    if (crlf > 0 && lf > 0) {
      mixed.push({
        file: path.relative(root, file).replace(/\\/g, "/"),
        absolute: file,
        crlf,
        lf,
        dominant: crlf >= lf ? "CRLF" : "LF",
      });
    }
  }
  mixed.sort((a, b) => a.file.localeCompare(b.file));
  return mixed;
}

/** Rewrite one file to a single ending. Content is otherwise untouched. */
export function normalizeFile(absolute, dominant) {
  const text = fs.readFileSync(absolute, "utf8");
  const lfBody = text.replace(/\r\n/g, "\n");
  fs.writeFileSync(absolute, dominant === "CRLF" ? lfBody.replace(/\n/g, "\r\n") : lfBody, "utf8");
}

// --- CLI --------------------------------------------------------------------
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const fix = process.argv.includes("--fix");
  let mixed = findMixedLineEndings();

  if (fix && mixed.length > 0) {
    for (const m of mixed) {
      normalizeFile(m.absolute, m.dominant);
      console.log(`[FIXED] ${m.file} (CRLF=${m.crlf} LF=${m.lf}) -> uniform ${m.dominant}`);
    }
    mixed = findMixedLineEndings();
  }

  if (mixed.length === 0) {
    console.log("[OK] no mixed line endings.");
    process.exit(0);
  }

  console.error(`[FAIL] ${mixed.length} file(s) have MIXED line endings.`);
  console.error("Exact-string edits against these files can silently no-op.\n");
  for (const m of mixed) {
    console.error(`  ${m.file}  CRLF=${m.crlf} LF=${m.lf}  (dominant: ${m.dominant})`);
  }
  console.error("\nFix with: node scripts/check-line-endings.mjs --fix");
  process.exit(1);
}
