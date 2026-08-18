//! FILENAME: app/e2e/__tests__/openItemsCitations.test.ts
// PURPOSE: Every `file.ext:NNN` citation in the live open-items list points at a
//          file that exists and is long enough to have that line.
// CONTEXT: `docs/design/open-items.md` is the authoritative list of what is open,
//          and its whole value is that every row cites the code it describes. Its
//          own section 3 records the failure mode: the list ASSERTS facts about
//          code, nothing fails when a fact stops being true, and the drift is
//          one-directional because filing an item is deliberate while un-filing it
//          is a side effect of unrelated work.
//
//          Line-number rot is the cheapest half of that to detect, and it is not
//          hypothetical. Measured 2026-08-18 in a single pass:
//
//            lexer.rs:76   -> the item's subject had moved to :89
//            parser.rs:526 -> :588      (both drifted when the intersection
//            parser.rs:566 -> :634       operator was added, by this same session)
//            scroll_areas  -> cited :556, actually at :573
//
//          and the file itself confesses to an older instance: an anchor that read
//          `§7142` into a 1.33 MB archive whose sections are numbered, not lined.
//
//          A citation that has rotted is a warning that the CLAIM around it may
//          have rotted too — that is the real signal here. This test cannot know
//          whether a claim is still true, but it can refuse to let the evidence
//          quietly stop pointing anywhere.
//
// WHY IT RESOLVES BY BASENAME. The list cites `sheets.rs:917`, not a repo-relative
// path, because that is how the rows read naturally. So a citation is checked only
// when its basename resolves to EXACTLY ONE file in the repo. Ambiguous basenames
// (`types.rs`, `index.ts`, `commands.rs`) are reported as unchecked rather than
// guessed at — a guess would either fail honest rows or, worse, pass by checking
// the wrong file. The count of unchecked citations is asserted too, so the
// unresolvable set cannot silently swallow the whole list.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const REPO_ROOT = resolve(process.cwd(), "..");
const OPEN_ITEMS = join(REPO_ROOT, "docs", "design", "open-items.md");

const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  ".git",
  "dist",
  "test-results",
  "results",
  ".vite",
  "__screenshots__",
  // `.claude/worktrees/` holds FULL COPIES of the repo for agent worktrees, so
  // every source file appears at least twice if this is walked. That is not real
  // ambiguity, and leaving it in made 18 of 32 cited filenames "unresolvable" —
  // i.e. it hollowed out this guard while it still passed its other two cases.
  ".claude",
]);

/** basename -> every repo path carrying it. */
function indexRepoFiles(): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else {
        const list = byName.get(e.name);
        if (list) list.push(join(dir, e.name));
        else byName.set(e.name, [join(dir, e.name)]);
      }
    }
  };
  walk(REPO_ROOT);
  return byName;
}

interface Citation {
  file: string;
  line: number;
  raw: string;
}

/**
 * Pull `name.ext:NNN` citations out of the document. Ranges (`:144-149`) and
 * comma lists (`:526,566`) are expanded to their individual line numbers, since
 * each is a separate claim about where something lives.
 */
function citations(md: string): Citation[] {
  const out: Citation[] = [];
  // A filename with a code-ish extension, then :N, then optional -N / ,N repeats.
  const re = /([A-Za-z0-9_.-]+\.(?:ts|tsx|rs|mjs|js|json|ps1|toml|yml|yaml))\s*:\s*(\d+(?:\s*[-,]\s*\d+)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const file = m[1];
    for (const part of m[2].split(",")) {
      for (const n of part.split("-")) {
        const line = Number(n.trim());
        if (Number.isFinite(line) && line > 0) out.push({ file, line, raw: m[0] });
      }
    }
  }
  return out;
}

const md = readFileSync(OPEN_ITEMS, "utf8");
const allCitations = citations(md);
const index = indexRepoFiles();

describe("open-items.md citations still point somewhere", () => {
  it("finds citations at all, in a document that is actually the list", () => {
    // Non-vacuity twice over: an empty parse, or a file that stopped being the
    // open-items list, would make every assertion below pass over nothing.
    expect(md).toContain("Scope of this list");
    expect(
      allCitations.length,
      "no `file.ext:NNN` citations were parsed out of open-items.md, so this " +
        "guard is checking nothing",
    ).toBeGreaterThan(40);
  });

  it("every RESOLVABLE citation names a file that exists and is long enough", () => {
    const rotted: string[] = [];
    let checked = 0;

    for (const c of allCitations) {
      const matches = index.get(basename(c.file));
      if (!matches || matches.length !== 1) continue; // ambiguous — see below
      checked++;
      const path = matches[0];
      let lineCount: number;
      try {
        if (statSync(path).size === 0) {
          rotted.push(`${c.raw} -> ${path} is EMPTY`);
          continue;
        }
        lineCount = readFileSync(path, "utf8").split(/\r?\n/).length;
      } catch {
        rotted.push(`${c.raw} -> ${path} could not be read`);
        continue;
      }
      if (c.line > lineCount) {
        rotted.push(
          `${c.raw} -> ${path} has only ${lineCount} lines, so line ${c.line} does not exist`,
        );
      }
    }

    expect(
      checked,
      "no citation resolved to exactly one file, so nothing was verified",
    ).toBeGreaterThan(20);

    expect(
      rotted,
      "these citations in docs/design/open-items.md point past the end of the " +
        "file they name. A citation that has rotted is a signal the CLAIM around " +
        "it may have rotted too — re-read the item before simply renumbering it. " +
        "This is the cheap half of the staleness problem section 3 describes.",
    ).toEqual([]);
  });

  it("reports how much of the list it could NOT check, so the gap stays visible", () => {
    const unresolvable = new Set<string>();
    for (const c of allCitations) {
      const matches = index.get(basename(c.file));
      if (!matches || matches.length !== 1) unresolvable.add(c.file);
    }
    // Not an error — `types.rs` and `index.ts` are genuinely ambiguous by
    // basename. But if MOST citations became uncheckable the guard would be
    // hollow while still passing, which is the exact failure it exists to catch.
    const ratio = unresolvable.size / new Set(allCitations.map((c) => c.file)).size;
    expect(
      ratio,
      `${unresolvable.size} of ${new Set(allCitations.map((c) => c.file)).size} cited ` +
        `filenames are ambiguous or missing, so most of the list is unchecked: ` +
        `${[...unresolvable].sort().join(", ")}`,
    ).toBeLessThan(0.5);
  });
});
