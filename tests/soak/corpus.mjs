/**
 * FILENAME: tests/soak/corpus.mjs
 * PURPOSE: Parser/writer for docs/expected-behavior.md — the corpus of
 *          documented expected behaviors used by the triage phase and by
 *          scenario expansion.
 *
 * Format (managed markers; corpus.mjs is the ONLY writer):
 *
 *   <!-- BEGIN:undo.pivot-filter -->
 *   ### undo.pivot-filter  `[verified]`
 *   <prose>
 *   - covered-by: app/e2e/tests/pivot.spec.ts
 *   - source: user
 *   <!-- END:undo.pivot-filter -->
 *
 * Rules:
 *  - IDs are `area.kebab-feature`. Areas group into ## sections.
 *  - Status is [verified] | [unverified] | [disputed]. The user flips
 *    unverified -> verified BY HAND; this module NEVER downgrades verified.
 *  - upsert adds missing IDs and may update [unverified] entries only.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
export const CORPUS_FILE = path.join(PROJECT_ROOT, "docs", "expected-behavior.md");

export const AREAS = {
  undo: "Undo / Redo",
  save: "Save / Load",
  recalc: "Recalculation",
  edit: "Editing",
  format: "Formatting",
  structure: "Rows / Columns / Structure",
  pivot: "Pivot Tables",
  chart: "Charts",
  table: "Tables",
  slicer: "Slicers & Timelines",
  filter: "Sort & Filter",
  sheet: "Sheets",
  names: "Named Ranges",
  validation: "Data Validation",
  cf: "Conditional Formatting",
  clipboard: "Clipboard",
  ui: "UI / Ribbon",
};

const ENTRY_RE =
  /<!-- BEGIN:([a-z0-9.-]+) -->\s*\n### \1\s+`\[(verified|unverified|disputed)\]`\s*\n([\s\S]*?)<!-- END:\1 -->/g;

/**
 * @returns {{ entries: Array<{id, area, status, text, coveredBy, source}> }}
 */
export function parseCorpus(filePath = CORPUS_FILE) {
  if (!fs.existsSync(filePath)) return { entries: [] };
  const raw = fs.readFileSync(filePath, "utf8");
  const entries = [];
  let m;
  while ((m = ENTRY_RE.exec(raw)) !== null) {
    const [, id, status, body] = m;
    const lines = body.trim().split("\n");
    const coveredBy = [];
    let source = "";
    const textLines = [];
    for (const line of lines) {
      const covered = line.match(/^- covered-by:\s*(.*)$/);
      const src = line.match(/^- source:\s*(.*)$/);
      if (covered) {
        const value = covered[1].trim();
        if (value && value !== "(none)") {
          coveredBy.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
        }
      } else if (src) {
        source = src[1].trim();
      } else {
        textLines.push(line);
      }
    }
    entries.push({
      id,
      area: id.split(".")[0],
      status,
      text: textLines.join("\n").trim(),
      coveredBy,
      source,
    });
  }
  return { entries };
}

export function renderEntry(entry) {
  return [
    `<!-- BEGIN:${entry.id} -->`,
    `### ${entry.id}  \`[${entry.status}]\``,
    entry.text,
    `- covered-by: ${entry.coveredBy.length ? entry.coveredBy.join(", ") : "(none)"}`,
    `- source: ${entry.source || "unknown"}`,
    `<!-- END:${entry.id} -->`,
  ].join("\n");
}

export function renderCorpus(entries) {
  const lines = [
    "# Expected Behavior",
    "",
    "Documented expected behaviors of Calcula, used as the reference for the",
    "automated soak/regression system (triage: \"is this an app bug or a stale",
    "test?\") and as the gap list for scenario expansion.",
    "",
    "<!-- managed-by: tests/soak/corpus.mjs — entry blocks between BEGIN/END",
    "     markers are machine-edited. To verify an entry, change [unverified]",
    "     to [verified] by hand; the tooling never downgrades verified. -->",
    "",
  ];

  const byArea = new Map();
  for (const entry of entries) {
    if (!byArea.has(entry.area)) byArea.set(entry.area, []);
    byArea.get(entry.area).push(entry);
  }

  // Known areas in declaration order first, then any unknown areas.
  const orderedAreas = [
    ...Object.keys(AREAS).filter((a) => byArea.has(a)),
    ...[...byArea.keys()].filter((a) => !(a in AREAS)),
  ];

  for (const area of orderedAreas) {
    lines.push(`## ${AREAS[area] ?? area}`);
    lines.push("");
    for (const entry of byArea.get(area)) {
      lines.push(renderEntry(entry));
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Add new entries / update existing [unverified] ones. Never touches
 * [verified] or [disputed] entries. Returns {added, updated, skipped}.
 */
export function upsertEntries(newEntries, filePath = CORPUS_FILE) {
  const { entries } = parseCorpus(filePath);
  const byId = new Map(entries.map((e) => [e.id, e]));
  let added = 0,
    updated = 0,
    skipped = 0;

  for (const entry of newEntries) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, {
        status: "unverified",
        coveredBy: [],
        source: "",
        ...entry,
        area: entry.id.split(".")[0],
      });
      added++;
    } else if (existing.status === "unverified") {
      byId.set(entry.id, {
        ...existing,
        text: entry.text || existing.text,
        coveredBy: [...new Set([...existing.coveredBy, ...(entry.coveredBy ?? [])])],
        source: entry.source || existing.source,
      });
      updated++;
    } else {
      // verified/disputed entries are user-owned; only merge coverage info.
      if (entry.coveredBy?.length) {
        existing.coveredBy = [...new Set([...existing.coveredBy, ...entry.coveredBy])];
        updated++;
      } else {
        skipped++;
      }
    }
  }

  fs.writeFileSync(filePath, renderCorpus([...byId.values()]), "utf8");
  return { added, updated, skipped };
}

/** Behaviors with no covering test — the gap list for scenario expansion. */
export function coverage(filePath = CORPUS_FILE) {
  const { entries } = parseCorpus(filePath);
  return {
    covered: entries.filter((e) => e.coveredBy.length > 0),
    uncovered: entries.filter((e) => e.coveredBy.length === 0),
  };
}

/** Select corpus entries relevant to a set of action ids/categories (for
 *  triage prompts). Falls back to all entries when the corpus is small. */
export function selectRelevant(actionIds, filePath = CORPUS_FILE) {
  const { entries } = parseCorpus(filePath);
  if (entries.length <= 30) return entries;

  const areas = new Set();
  for (const id of actionIds) {
    const head = id.split(".")[0];
    // Map action categories to corpus areas.
    const map = {
      slicer: "slicer", chart: "chart", table: "table", sparkline: "chart",
      structure: "structure", cell: "edit", format: "format", merge: "structure",
      fill: "edit", sort: "filter", filter: "filter", sheet: "sheet",
      names: "names", cf: "cf", validation: "validation", freeze: "ui",
      comment: "edit", note: "edit", hyperlink: "edit", replace: "edit",
      undo: "undo", redo: "undo", ribbon: "ui", nav: "ui", clipboard: "clipboard",
    };
    if (map[head]) areas.add(map[head]);
  }
  areas.add("undo");
  areas.add("save");
  areas.add("recalc");
  return entries.filter((e) => areas.has(e.area));
}
