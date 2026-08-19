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

/**
 * Source files carrying an embedded NUL byte.
 *
 * A NUL has no business in any extension this script walks, and it is the same
 * class of hazard as a mixed ending but nastier: an exact-string edit against
 * the NUL silently no-ops, AND the file goes INVISIBLE to grep, so the usual way
 * of finding the problem cannot see it. This project has already lost time to it
 * once -- a dialog-globals violation hid in a NUL-bearing file through a whole
 * audit -- and the same corruption was reproduced on 2026-08-19 when a generated
 * edit wrote three NULs where spaces belonged and every gate stayed green.
 *
 * Deliberately NOT auto-fixed. A wrong ending has an obvious correct rewrite; a
 * NUL does not -- it may stand for a space, or mark genuinely corrupt bytes, and
 * guessing would destroy the evidence.
 */
export const KNOWN_NUL_FILES = new Map([
  [
    "app/src/api/writebackValidators.ts",
    {
      count: 3,
      why:
        "Deliberate: a raw NUL is the separator in the composite cache key " +
        "`${regionId}\\0${value}` (lines 332, 338, 389). It cannot occur in either " +
        "component, which is what makes it a safe separator. Note the cost though -- " +
        "those three lines ARE invisible to grep, and writing the escape `\\0` instead " +
        "of the raw byte would keep the same runtime value while removing that. " +
        "Recorded rather than fixed: it is behaviour-adjacent code and not this " +
        "check's business to rewrite.",
    },
  ],
]);

export function findNulBytes(root = REPO_ROOT) {
  const hits = [];
  for (const file of collectSourceFiles(root)) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (buf.length > 8_000_000) continue;
    const offsets = [];
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0) offsets.push(i);
    if (offsets.length === 0) continue;

    const rel = path.relative(root, file).replace(/\\/g, "/");
    // A file with a KNOWN, deliberate use is tolerated only at its known count.
    // Exempting it outright would blind the check to a NEW corruption in the one
    // file most likely to attract one, so the exemption expires the moment the
    // count moves -- in either direction, because a deliberate use being removed
    // means the entry is stale.
    const known = KNOWN_NUL_FILES.get(rel);
    if (known && known.count === offsets.length) continue;

    hits.push({
      file: rel,
      absolute: file,
      count: offsets.length,
      // Report the LINE, because that is what a reader needs to open.
      firstLine: buf.subarray(0, offsets[0]).toString("latin1").split("\n").length,
      known,
    });
  }
  hits.sort((a, b) => a.file.localeCompare(b.file));
  return hits;
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

  // Checked even when endings are clean: the two failures are independent, and
  // reporting only the first would hide the one that also defeats grep.
  const nuls = findNulBytes();

  if (mixed.length === 0 && nuls.length === 0) {
    console.log("[OK] no mixed line endings, no embedded NUL bytes.");
    process.exit(0);
  }

  if (mixed.length > 0) {
    console.error(`[FAIL] ${mixed.length} file(s) have MIXED line endings.`);
    console.error("Exact-string edits against these files can silently no-op.\n");
    for (const m of mixed) {
      console.error(`  ${m.file}  CRLF=${m.crlf} LF=${m.lf}  (dominant: ${m.dominant})`);
    }
    console.error("\nFix with: node scripts/check-line-endings.mjs --fix");
  }

  if (nuls.length > 0) {
    if (mixed.length > 0) console.error("");
    console.error(`[FAIL] ${nuls.length} source file(s) contain an embedded NUL byte.`);
    console.error(
      "A NUL makes exact-string edits no-op AND makes the file invisible to grep,\n" +
        "so the usual way of finding the problem cannot see it. Not auto-fixable:\n" +
        "open the line and decide what the byte should have been.\n",
    );
    for (const n of nuls) {
      console.error(`  ${n.file}  first at line ${n.firstLine} (${n.count} total)`);
      if (n.known) {
        console.error(
          `    This file has a RECORDED deliberate use of ${n.known.count}, so the count moved. ` +
            `If the new one is also deliberate, update KNOWN_NUL_FILES in this script.\n` +
            `    Recorded reason: ${n.known.why}`,
        );
      }
    }
  }
  process.exit(1);
}
