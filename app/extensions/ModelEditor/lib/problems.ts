// FILENAME: app/extensions/ModelEditor/lib/problems.ts
// PURPOSE: One list of everything wrong with the model, from every source that
//          can say so, each row navigable to the object it concerns.
// CONTEXT: "Something is wrong" was surfaced FIVE unaggregated ways — an
//          on-demand button on a page you visit once, a Monaco marker inside a
//          modal, a strategy findings strip, two hand-rolled amber banners, and
//          a last-wins error bar. Nothing added up, and nothing was reachable
//          from the object it was about.
//
//          THE HARD CONSTRAINT THAT SHAPES THIS FILE: `bi_model_validate`
//          (app/src-tauri/src/bi/model_editor.rs:8398) returns AT MOST ONE
//          issue, always `level: "error"`, with NO anchor — because
//          `DataModel::validate()` clones the model into a builder and `?`s out
//          on the first failure. It cannot feed a navigable panel. So the bulk
//          of what is useful here is computed CLIENT-SIDE from the
//          `ModelOverview` already in memory, and the engine's answer is
//          rendered as exactly one honest row.
//
//          WHY THE CHECKS BELOW AND NOT MORE: a problems list that cries wolf
//          gets ignored, and then the real row in it is missed too. "Measure
//          has no description" would be technically true of most measures in
//          most models and would bury everything else; "relationship is
//          inactive" flags a DELIBERATE choice (USERELATIONSHIP). Neither is
//          here. Every check below is either real breakage or a
//          before-you-ship question with a small, actionable answer.

import type { ModelOverview } from "@api";
import type { SectionId } from "../components/editorShared";
import type { Finding } from "./strategyTypes";

export type ProblemSeverity = "error" | "warning" | "info";

export interface Problem {
  severity: ProblemSeverity;
  /** Stable kebab-case id — groups rows and lets a test assert one. */
  code: string;
  /** The object this is about, e.g. `Fact_Sales` or `Dim_Date[Year]`. */
  subject: string;
  message: string;
  /** Where clicking the row goes. */
  section: SectionId;
  selection?: string;
}

/** A short title per code, used as the drawer's group heading. */
export const PROBLEM_TITLES: Record<string, string> = {
  "orphan-table": "Table joins nothing",
  "unbound-table": "Table is not bound to a source",
  "relationship-missing-table": "Relationship points at a missing table",
  "relationship-missing-column": "Relationship points at a missing column",
  "hierarchy-missing-column": "Hierarchy level points at a missing column",
  "sortby-missing-column": "Sort-by points at a missing column",
  "empty-perspective": "Perspective is empty",
  "empty-culture": "Culture translates nothing",
  "no-format-string": "Measure has no number format",
  "no-date-table": "No date table is marked",
  "model-build": "Model build",
  strategy: "Strategy",
};

const SEVERITY_RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

// ---------------------------------------------------------------------------
// Client-side checks
// ---------------------------------------------------------------------------

/**
 * Best-practice checks over the overview. PURE and cheap — no backend call —
 * so this can re-run on every model change without costing anything.
 */
export function bestPracticeProblems(o: ModelOverview): Problem[] {
  const out: Problem[] = [];
  const tableNames = new Set(o.tables.map((t) => t.name));
  const columnsOf = new Map(o.tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));

  // --- Real breakage -------------------------------------------------------

  for (const r of o.relationships) {
    for (const [side, tableName] of [
      ["from", r.fromTable],
      ["to", r.toTable],
    ] as const) {
      if (!tableNames.has(tableName)) {
        out.push({
          severity: "error",
          code: "relationship-missing-table",
          subject: r.name,
          message: `Its ${side} table '${tableName}' is not in the model.`,
          section: "relationships",
          selection: r.name,
        });
      }
    }
    for (const c of r.conditions) {
      const fromCols = columnsOf.get(r.fromTable);
      const toCols = columnsOf.get(r.toTable);
      if (fromCols && !fromCols.has(c.fromColumn)) {
        out.push({
          severity: "error",
          code: "relationship-missing-column",
          subject: r.name,
          message: `'${r.fromTable}[${c.fromColumn}]' does not exist.`,
          section: "relationships",
          selection: r.name,
        });
      }
      if (toCols && !toCols.has(c.toColumn)) {
        out.push({
          severity: "error",
          code: "relationship-missing-column",
          subject: r.name,
          message: `'${r.toTable}[${c.toColumn}]' does not exist.`,
          section: "relationships",
          selection: r.name,
        });
      }
    }
  }

  for (const h of o.hierarchies) {
    const cols = columnsOf.get(h.table);
    if (!cols) continue; // the missing TABLE is reported by its own check
    for (const level of h.levels) {
      if (!cols.has(level.column)) {
        out.push({
          severity: "error",
          code: "hierarchy-missing-column",
          subject: h.name,
          message: `Level '${level.column}' does not exist on ${h.table}.`,
          section: "hierarchies",
          selection: h.name,
        });
      }
    }
  }

  for (const t of o.tables) {
    const cols = columnsOf.get(t.name)!;
    for (const c of t.columns) {
      if (c.sortByColumn && !cols.has(c.sortByColumn)) {
        out.push({
          severity: "error",
          code: "sortby-missing-column",
          subject: `${t.name}[${c.name}]`,
          message: `Sorts by '${c.sortByColumn}', which does not exist on this table.`,
          section: "tables",
          selection: t.name,
        });
      }
    }
  }

  // --- Before you ship -----------------------------------------------------

  // A table joined to nothing answers no cross-table question. On a star this
  // is nearly always an unfinished import. Skipped when the model has no
  // relationships AT ALL, because then it is one fact about the model rather
  // than one fact per table.
  if (o.relationships.length > 0) {
    const joined = new Set<string>();
    for (const r of o.relationships) {
      joined.add(r.fromTable);
      joined.add(r.toTable);
    }
    for (const t of o.tables) {
      if (!joined.has(t.name)) {
        out.push({
          severity: "warning",
          code: "orphan-table",
          subject: t.name,
          message: "It takes part in no relationship, so nothing can slice it.",
          section: "relationships",
        });
      }
    }
  }

  for (const t of o.tables) {
    if (!t.bound) {
      out.push({
        severity: "warning",
        code: "unbound-table",
        subject: t.name,
        message: "It is not bound to a data source, so it cannot be queried.",
        section: "tables",
        selection: t.name,
      });
    }
  }

  for (const p of o.perspectives) {
    if (p.tables.length === 0 && p.columns.length === 0 && p.measures.length === 0) {
      out.push({
        severity: "warning",
        code: "empty-perspective",
        subject: p.name,
        message: "It exposes nothing, so anyone who picks it sees an empty model.",
        section: "perspectives",
        selection: p.name,
      });
    }
  }

  for (const c of o.cultures) {
    if (c.tables.length === 0 && c.columns.length === 0 && c.measures.length === 0) {
      out.push({
        severity: "warning",
        code: "empty-culture",
        subject: c.locale,
        message: "It carries no translations, so it changes nothing for its users.",
        section: "translations",
        selection: c.locale,
      });
    }
  }

  // Only for VISIBLE measures: a hidden one is an intermediate that nobody
  // formats on purpose, and flagging those is exactly the noise that gets a
  // problems list ignored.
  for (const m of o.measures) {
    if (!m.isHidden && !m.formatString && !m.formatStringExpression) {
      out.push({
        severity: "warning",
        code: "no-format-string",
        subject: m.name,
        message: "It has no number format, so it renders raw in every report.",
        section: "measures",
        selection: m.name,
      });
    }
  }

  // One row, not per-measure: time intelligence (YTD/QTD/PRIORYEAR) needs a
  // marked date table, and without one it silently does nothing.
  if (!o.dateTable && o.tables.length > 0) {
    out.push({
      severity: "info",
      code: "no-date-table",
      subject: "Model",
      message:
        "No table is marked as the date table, so time-intelligence functions have no calendar.",
      section: "settings",
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Folding in the other sources
// ---------------------------------------------------------------------------

/**
 * A strategy finding's path -> the section and the selection token to navigate
 * with.
 *
 * THE TOKEN IS THE WHOLE PATH, not the object's name. `selection` is opaque —
 * every consumer decides what it means — and Strategy addresses everything by
 * path: the path says which of the four views the row lives in, which row it
 * is, and (for a column or an attribute) which part of that row. A bare name
 * threw all of that away and could not even say whether "Sales" was a table or
 * a measure, so the tab could do nothing useful with it and did nothing at all.
 *
 * The paths that reach here are `measures['X']…`, `tables['X']…` (including
 * `.columns['Y']`), `rules[N]…` and `model…`; anything else carries no
 * selection rather than a guess.
 */
export function locateStrategyFinding(path: string): { section: SectionId; selection?: string } {
  const known =
    path.startsWith("measures[") ||
    path.startsWith("tables[") ||
    path.startsWith("rules[") ||
    path === "model" ||
    path.startsWith("model.") ||
    path.startsWith("model[");
  return known ? { section: "strategy", selection: path } : { section: "strategy" };
}

export function strategyProblems(findings: Finding[]): Problem[] {
  return findings.map((f) => ({
    severity: f.severity,
    code: "strategy",
    subject: f.path,
    message: f.message,
    ...locateStrategyFinding(f.path),
  }));
}

/**
 * The engine's own answer, as ONE row. Never dressed up as a list: it can only
 * ever be one anchorless error, and rendering it as a list implies a
 * completeness it does not have.
 */
export function modelBuildProblem(issues: Array<{ level: string; message: string }>): Problem[] {
  if (issues.length === 0) return [];
  return [
    {
      severity: "error",
      code: "model-build",
      subject: "Model",
      message: `Model does not build: ${issues[0].message}`,
      section: "overview",
    },
  ];
}

/** Stable ordering: errors first, then by code, then by subject. */
export function sortProblems(problems: Problem[]): Problem[] {
  return [...problems].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.code.localeCompare(b.code) ||
      a.subject.localeCompare(b.subject),
  );
}

export interface ProblemGroup {
  code: string;
  title: string;
  severity: ProblemSeverity;
  items: Problem[];
}

/**
 * Group by code so twelve unformatted measures read as ONE line with a count
 * rather than twelve rows that bury the single broken relationship above them.
 */
export function groupProblems(problems: Problem[]): ProblemGroup[] {
  const byCode = new Map<string, Problem[]>();
  for (const p of sortProblems(problems)) {
    const arr = byCode.get(p.code) ?? [];
    arr.push(p);
    byCode.set(p.code, arr);
  }
  return [...byCode.entries()]
    .map(([code, items]) => ({
      code,
      title: PROBLEM_TITLES[code] ?? code,
      severity: items.reduce<ProblemSeverity>(
        (worst, p) => (SEVERITY_RANK[p.severity] < SEVERITY_RANK[worst] ? p.severity : worst),
        "info",
      ),
      items,
    }))
    .sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.title.localeCompare(b.title),
    );
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * What was actually CHECKED.
 *
 * "Problems 0" must never be readable as "checked and clean" when it means
 * "nothing was checked". The deep sources (the engine's build check, the
 * strategy document) cost a backend call, so they run on open and on an
 * explicit re-check — not on every keystroke — and between those the panel has
 * to say so rather than imply a freshness it does not have.
 */
export interface ProblemCoverage {
  /** Client-side checks always run. */
  bestPractice: number;
  /** null = not run yet this session. */
  modelBuild: "ok" | "failed" | null;
  /** null = not run, 0 = ran and found nothing. */
  strategy: number | null;
}

export function describeCoverage(c: ProblemCoverage): string {
  const parts: string[] = [];
  parts.push(
    c.modelBuild === null
      ? "Model build: not checked yet"
      : c.modelBuild === "ok"
        ? "Model build: OK"
        : "Model build: FAILED",
  );
  parts.push(`${c.bestPractice} best-practice finding${c.bestPractice === 1 ? "" : "s"}`);
  parts.push(
    c.strategy === null
      ? "strategy not checked"
      : `${c.strategy} strategy finding${c.strategy === 1 ? "" : "s"}`,
  );
  return parts.join(" · ");
}

/** The worst severity present, or null when clean. */
export function worstSeverity(problems: Problem[]): ProblemSeverity | null {
  if (problems.length === 0) return null;
  return problems.reduce<ProblemSeverity>(
    (worst, p) => (SEVERITY_RANK[p.severity] < SEVERITY_RANK[worst] ? p.severity : worst),
    "info",
  );
}

/** Problems attributable to one rail section, for its dot. */
export function problemsBySection(problems: Problem[]): Map<SectionId, ProblemSeverity> {
  const out = new Map<SectionId, ProblemSeverity>();
  for (const p of problems) {
    const cur = out.get(p.section);
    if (!cur || SEVERITY_RANK[p.severity] < SEVERITY_RANK[cur]) out.set(p.section, p.severity);
  }
  return out;
}
