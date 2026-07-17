// FILENAME: app/extensions/ModelEditor/cli/readers.ts
// PURPOSE: The CLI's inspection commands: `ls <kind> [pattern]`,
//          `show <kind> <name>` and `validate`. Pure reads over the session's
//          ModelOverview (plus the async source-table / extension-data reads).

import type {
  ModelColumnInfo,
  ModelOverview,
  ModelRelationshipInfo,
  ModelTableInfo,
} from "@api";
import { CliError } from "./lex";
import type { ValueTok } from "./lex";
import type { Command } from "./parse";
import type { CliIo, CliSession } from "./execute";
import { detailBlock, plural, textTable, yesNo } from "./format";
import { filterNames, globToRegex, matchColumns, matchNamed, matchRelationships, matchTables, requireOne } from "./resolve";

export async function runRead(cmd: Command, s: CliSession, io: CliIo): Promise<void> {
  if (cmd.verb === "validate") {
    const issues = await s.gateway.validate(s.connectionId);
    if (issues.length === 0) {
      io.print("Model is valid — no issues.", "info");
    } else {
      io.print(issues.map((i) => `${i.level.toUpperCase()}: ${i.message}`).join("\n"));
    }
    return;
  }
  if (cmd.verb === "ls") {
    await runLs(cmd, s, io);
    return;
  }
  await runShow(cmd, s, io);
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

/** The primary positional as a pattern string (null = list everything). */
function patternOf(cmd: Command): string | null {
  const t = cmd.pos[0];
  return t ? t.text : null;
}

function printTable(io: CliIo, headers: string[], rows: string[][], emptyMsg: string): void {
  if (rows.length === 0) {
    io.print(emptyMsg, "info");
  } else {
    io.print(textTable(headers, rows));
  }
}

async function runLs(cmd: Command, s: CliSession, io: CliIo): Promise<void> {
  const o = s.overview;
  const pat = patternOf(cmd) ?? "*";

  switch (cmd.kind) {
    case null: {
      // Bare `ls`: model summary.
      io.print(
        detailBlock([
          ["model", o.modelName ?? "(unnamed)"],
          ["tables", String(o.tables.length)],
          ["relationships", String(o.relationships.length)],
          ["measures", String(o.measures.length)],
          ["hierarchies", String(o.hierarchies.length)],
          ["KPIs", String(o.kpis.length)],
          ["calculation groups", String(o.calculationGroups.length)],
          ["calculated tables", String(o.globalVariables.length)],
          ["table variables", String(o.tableVariables.length)],
          ["contexts", String(o.contexts.length)],
          ["context columns", String(o.contextColumns.length)],
          ["script functions", String(o.scriptFunctions.length)],
          ["security roles", String(o.securityRoles.length)],
          ["perspectives", String(o.perspectives.length)],
          ["cultures", String(o.cultures.length)],
          ["writeback columns", String(o.writebackColumns.length)],
          ["sources", String(o.sources.length)],
          ["date table", o.dateTable ?? "(none)"],
        ]),
      );
      return;
    }
    case "table": {
      const rows = matchTables(o, pat).map((t) => [
        t.name,
        t.displayName ?? "",
        t.storageMode,
        String(t.columns.length),
        yesNo(t.isHidden),
        t.bound ? "yes" : "no",
      ]);
      printTable(io, ["table", "display", "storage", "cols", "hidden", "bound"], rows, `No tables match '${pat}'`);
      return;
    }
    case "column": {
      const t0 = cmd.pos[0];
      const matches =
        t0 && t0.kind === "colref"
          ? matchColumns(o, t0.table ?? "*", t0.column ?? "*")
          : matchColumns(o, pat, "*");
      const rows = matches.map(({ table, column: c }) => [
        `${table.name}[${c.name}]`,
        c.dataType,
        columnKind(c),
        yesNo(c.isHidden),
        c.formatString ?? "",
      ]);
      printTable(io, ["column", "type", "kind", "hidden", "format"], rows, `No columns match '${pat}'`);
      return;
    }
    case "measure": {
      const rows = matchNamed(o.measures, (m) => m.name, pat).map((m) => [
        m.name,
        m.table,
        m.group ?? "",
        m.formatString ?? "",
        yesNo(m.isHidden),
      ]);
      printTable(io, ["measure", "table", "folder", "format", "hidden"], rows, `No measures match '${pat}'`);
      return;
    }
    case "relationship": {
      const { namePat, from, to } = relationshipTarget(cmd);
      const rows = matchRelationships(o, namePat, from, to).map((r) => [
        r.name,
        relEndpoints(r),
        r.cardinality,
        yesNo(r.active),
        r.filterPropagation,
      ]);
      printTable(io, ["relationship", "join", "cardinality", "active", "propagation"], rows, "No relationships match");
      return;
    }
    case "hierarchy": {
      const rows = matchNamed(o.hierarchies, (h) => h.name, pat).map((h) => [
        h.name,
        h.table,
        h.levels.map((l) => l.column).join(" > "),
      ]);
      printTable(io, ["hierarchy", "table", "levels"], rows, `No hierarchies match '${pat}'`);
      return;
    }
    case "kpi": {
      const rows = matchNamed(o.kpis, (k) => k.name, pat).map((k) => [
        k.name,
        k.baseMeasure,
        k.targetMeasure ?? (k.targetConstant !== null ? String(k.targetConstant) : ""),
        k.statusBands.map((b) => `${b.threshold}:${b.status}`).join(","),
      ]);
      printTable(io, ["kpi", "base", "target", "bands"], rows, `No KPIs match '${pat}'`);
      return;
    }
    case "role": {
      const rows = matchNamed(o.securityRoles, (r) => r.name, pat).map((r) => [
        r.name,
        plural(r.filters.length, "filter"),
        r.deniedTables.length + r.deniedColumns.length > 0
          ? `${r.deniedTables.length} tables, ${r.deniedColumns.length} columns denied`
          : "",
      ]);
      printTable(io, ["role", "filters", "object security"], rows, `No roles match '${pat}'`);
      return;
    }
    case "perspective": {
      const rows = matchNamed(o.perspectives, (p) => p.name, pat).map((p) => [
        p.name,
        String(p.tables.length),
        String(p.columns.length),
        String(p.measures.length),
      ]);
      printTable(io, ["perspective", "tables", "columns", "measures"], rows, `No perspectives match '${pat}'`);
      return;
    }
    case "culture": {
      const rows = matchNamed(o.cultures, (c) => c.locale, pat).map((c) => [
        c.locale,
        String(c.tables.length),
        String(c.columns.length),
        String(c.measures.length),
      ]);
      printTable(io, ["culture", "tables", "columns", "measures"], rows, `No cultures match '${pat}'`);
      return;
    }
    case "translation": {
      // `ls translations <locale>`
      const locale = patternOf(cmd);
      if (!locale) throw new CliError("Usage: ls translations <locale>", cmd.line);
      const culture = requireOne(o.cultures, (c) => c.locale, locale, "culture", cmd.line);
      const rows: string[][] = [
        ...culture.tables.map((t) => ["table", t.object, t.displayName ?? "", t.description ?? ""]),
        ...culture.columns.map((c) => ["column", c.object, c.displayName ?? "", c.description ?? ""]),
        ...culture.measures.map((m) => ["measure", m.object, m.displayName ?? "", m.description ?? ""]),
      ];
      printTable(io, ["kind", "object", "caption", "description"], rows, `No translations in '${culture.locale}'`);
      return;
    }
    case "calcgroup": {
      const rows = matchNamed(o.calculationGroups, (g) => g.name, pat).map((g) => [
        g.name,
        g.items.map((i) => i.name).join(", "),
      ]);
      printTable(io, ["calc group", "items"], rows, `No calculation groups match '${pat}'`);
      return;
    }
    case "calcitem": {
      // `ls calcitems <group>`
      const group = requireOne(o.calculationGroups, (g) => g.name, pat, "calculation group", cmd.line);
      const rows = group.items.map((i) => [i.name, i.formula]);
      printTable(io, ["item", "formula"], rows, `'${group.name}' has no items`);
      return;
    }
    case "calctable": {
      const rows = matchNamed(o.globalVariables, (g) => g.name, pat).map((g) => [
        g.name,
        g.dynamic ? "dynamic" : "materialized",
        g.expression,
      ]);
      printTable(io, ["calc table", "mode", "expression"], rows, `No calculated tables match '${pat}'`);
      return;
    }
    case "tablevar": {
      const rows = matchNamed(o.tableVariables, (v) => v.name, pat).map((v) => [
        v.name,
        v.source,
        plural(v.filters.length, "filter"),
      ]);
      printTable(io, ["table variable", "source", "filters"], rows, `No table variables match '${pat}'`);
      return;
    }
    case "scriptfunction": {
      const rows = matchNamed(o.scriptFunctions, (f) => f.name, pat).map((f) => [
        f.name,
        `(${f.params.map((p) => `${p.name}:${p.ty}`).join(", ")})`,
        f.returnType,
      ]);
      printTable(io, ["function", "params", "returns"], rows, `No script functions match '${pat}'`);
      return;
    }
    case "context": {
      const rows = matchNamed(o.contexts, (c) => c.name, pat).map((c) => [
        c.name,
        plural(c.operations.length, "operation"),
      ]);
      printTable(io, ["context", "operations"], rows, `No contexts match '${pat}'`);
      return;
    }
    case "contextcolumn": {
      const rows = matchNamed(o.contextColumns, (c) => c.name, pat).map((c) => [
        `${c.table}[${c.name}]`,
        c.dataType,
        c.expression,
      ]);
      printTable(io, ["context column", "type", "expression"], rows, `No context columns match '${pat}'`);
      return;
    }
    case "writeback": {
      const rows = matchNamed(o.writebackColumns, (w) => w.name, pat).map((w) => [
        `${w.table}[${w.name}]`,
        w.dataType,
        w.kind,
        w.projectionMode,
        w.keyColumns.join(","),
      ]);
      printTable(io, ["writeback", "type", "kind", "projection", "keys"], rows, `No writeback columns match '${pat}'`);
      return;
    }
    case "source": {
      const rows = matchNamed(o.sources, sourceLabel, pat).map((src) => [
        sourceLabel(src),
        src.kind,
        src.host ? `${src.host}${src.port !== null ? ":" + src.port : ""}` : "",
        src.database,
        String(src.tableCount),
        src.id,
      ]);
      printTable(io, ["source", "kind", "host", "database", "tables", "id"], rows, `No sources match '${pat}'`);
      return;
    }
    case "sourcetable": {
      const tables = await s.gateway.listSourceTables(s.connectionId);
      const re = globToRegex(pat);
      const rows = tables
        .filter((t) => re.test(t.name) || re.test(`${t.schema}.${t.name}`))
        .map((t) => [`${t.schema}.${t.name}`, yesNo(t.imported)]);
      printTable(io, ["source table", "imported"], rows, "No source tables (is the source connected?)");
      return;
    }
    case "extdata": {
      const keys = await s.gateway.extensionDataList(s.connectionId);
      const rows = filterNames(pat === "*" ? null : pat, keys).map((k) => [k]);
      printTable(io, ["key"], rows, "No extension-data entries");
      return;
    }
    default:
      throw new CliError(`'ls' does not support '${cmd.kind}' (try 'help ls')`, cmd.line);
  }
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

async function runShow(cmd: Command, s: CliSession, io: CliIo): Promise<void> {
  const o = s.overview;
  if (cmd.kind === "model") {
    io.print(
      detailBlock([
        ["name", o.modelName],
        ["version", o.modelVersion],
        ["author", o.modelAuthor],
        ["description", o.modelDescription],
        ["date table", o.dateTable],
        ["default lookup", o.defaultLookupResolution],
        ["editable", yesNo(o.editable)],
        ["read-only reason", o.readOnlyReason],
      ]),
    );
    return;
  }
  if (cmd.kind === "extdata") {
    const key = cmd.pos[0]?.text;
    if (!key) throw new CliError("Usage: show extdata <key>", cmd.line);
    const value = await s.gateway.extensionDataGet(s.connectionId, key);
    io.print(value === null ? `(no entry '${key}')` : JSON.stringify(value, null, 2));
    return;
  }

  const pat = patternOf(cmd);
  if (!pat && cmd.kind !== "relationship") {
    throw new CliError(`Usage: show ${cmd.kind ?? "<kind>"} <name>`, cmd.line);
  }

  switch (cmd.kind) {
    case "table": {
      const t = requireOne(o.tables, (x) => x.name, pat!, "table", cmd.line);
      io.print(
        detailBlock([
          ["table", t.name],
          ["display name", t.displayName],
          ["description", t.description],
          ["storage", t.storageMode],
          ["hidden", yesNo(t.isHidden)],
          ["bound", yesNo(t.bound)],
          ["source id", t.sourceId],
          ["refresh", t.refreshStrategies.map(describeRefresh).join("; ") || null],
          ["incremental", t.incrementalRefresh],
          ["columns", String(t.columns.length)],
        ]),
      );
      const rows = t.columns.map((c) => [c.name, c.dataType, columnKind(c), yesNo(c.isHidden), c.formatString ?? ""]);
      printTable(io, ["column", "type", "kind", "hidden", "format"], rows, "(no columns)");
      return;
    }
    case "column": {
      const t0 = cmd.pos[0];
      if (!t0 || t0.kind !== "colref") {
        throw new CliError("Usage: show column Table[Column]", cmd.line);
      }
      const matches = matchColumns(o, t0.table ?? "*", t0.column ?? "*");
      if (matches.length === 0) throw new CliError(`No column matches '${t0.text}'`, cmd.line);
      for (const { table, column: c } of matches) {
        io.print(
          detailBlock([
            ["column", `${table.name}[${c.name}]`],
            ["type", c.dataType],
            ["kind", columnKind(c)],
            ["display name", c.displayName],
            ["description", c.description],
            ["hidden", yesNo(c.isHidden)],
            ["format", c.formatString],
            ["sort by", c.sortByColumn],
            ["lookup", c.lookupResolution],
            ["formula", c.formula],
          ]),
        );
      }
      return;
    }
    case "measure": {
      const m = requireOne(o.measures, (x) => x.name, pat!, "measure", cmd.line);
      io.print(
        detailBlock([
          ["measure", m.name],
          ["table", m.table],
          ["folder", m.group],
          ["format", m.formatString],
          ["format expr", m.formatStringExpression],
          ["hidden", yesNo(m.isHidden)],
          ["description", m.description],
          ["detail rows", m.detailRows?.join(", ") ?? null],
          ["formula", m.formula],
        ]),
      );
      return;
    }
    case "relationship": {
      const { namePat, from, to } = relationshipTarget(cmd);
      const matches = matchRelationships(o, namePat, from, to);
      if (matches.length === 0) throw new CliError("No relationship matches", cmd.line);
      for (const r of matches) {
        io.print(
          detailBlock([
            ["relationship", r.name],
            ["join", relEndpoints(r)],
            ["cardinality", r.cardinality],
            ["active", yesNo(r.active)],
            ["propagation", r.filterPropagation],
          ]),
        );
      }
      return;
    }
    case "hierarchy": {
      const h = requireOne(o.hierarchies, (x) => x.name, pat!, "hierarchy", cmd.line);
      io.print(
        detailBlock([
          ["hierarchy", h.name],
          ["table", h.table],
          ["levels", h.levels.map((l) => l.column + (l.displayName ? ` (${l.displayName})` : "")).join(" > ")],
        ]),
      );
      return;
    }
    case "kpi": {
      const k = requireOne(o.kpis, (x) => x.name, pat!, "KPI", cmd.line);
      io.print(
        detailBlock([
          ["kpi", k.name],
          ["base", k.baseMeasure],
          ["target measure", k.targetMeasure],
          ["target constant", k.targetConstant !== null ? String(k.targetConstant) : null],
          ["bands", k.statusBands.map((b) => `${b.threshold}:${b.status}`).join(", ")],
          ["description", k.description],
        ]),
      );
      return;
    }
    case "role": {
      const r = requireOne(o.securityRoles, (x) => x.name, pat!, "role", cmd.line);
      io.print(
        detailBlock([
          ["role", r.name],
          [
            "filters",
            r.filters
              .map((f) => `${f.table}[${f.column}] ${f.operator} ${f.dynamic ? "@" + f.dynamic : f.value}`)
              .join("\n") || null,
          ],
          ["denied tables", r.deniedTables.join(", ") || null],
          ["denied columns", r.deniedColumns.join(", ") || null],
        ]),
      );
      return;
    }
    case "perspective": {
      const p = requireOne(o.perspectives, (x) => x.name, pat!, "perspective", cmd.line);
      io.print(
        detailBlock([
          ["perspective", p.name],
          ["description", p.description],
          ["tables", p.tables.join(", ") || null],
          ["columns", p.columns.join(", ") || null],
          ["measures", p.measures.join(", ") || null],
        ]),
      );
      return;
    }
    case "calcgroup": {
      const g = requireOne(o.calculationGroups, (x) => x.name, pat!, "calculation group", cmd.line);
      io.print(detailBlock([["calc group", g.name]]));
      const rows = g.items.map((i) => [i.name, i.formula]);
      printTable(io, ["item", "formula"], rows, "(no items)");
      return;
    }
    case "calctable": {
      const g = requireOne(o.globalVariables, (x) => x.name, pat!, "calculated table", cmd.line);
      io.print(
        detailBlock([
          ["calc table", g.name],
          ["home table", g.table],
          ["mode", g.dynamic ? "dynamic" : "materialized"],
          ["expression", g.expression],
        ]),
      );
      return;
    }
    case "tablevar": {
      const v = requireOne(o.tableVariables, (x) => x.name, pat!, "table variable", cmd.line);
      io.print(
        detailBlock([
          ["table variable", v.name],
          ["source", v.source],
          [
            "filters",
            v.filters
              .map((f) => `${f.table}[${f.column}] ${f.operator} ${f.dynamic ? "@" + f.dynamic : f.value}`)
              .join("\n") || null,
          ],
        ]),
      );
      return;
    }
    case "scriptfunction": {
      const f = requireOne(o.scriptFunctions, (x) => x.name, pat!, "script function", cmd.line);
      io.print(
        detailBlock([
          ["function", f.name],
          ["params", f.params.map((p) => `${p.name}:${p.ty}`).join(", ") || "(none)"],
          ["returns", f.returnType],
          ["body", f.body],
        ]),
      );
      return;
    }
    case "context": {
      const c = requireOne(o.contexts, (x) => x.name, pat!, "context", cmd.line);
      io.print(
        detailBlock([
          ["context", c.name],
          ["operations", JSON.stringify(c.operations, null, 2)],
        ]),
      );
      return;
    }
    case "contextcolumn": {
      const c = requireOne(o.contextColumns, (x) => x.name, pat!, "context column", cmd.line);
      io.print(
        detailBlock([
          ["context column", `${c.table}[${c.name}]`],
          ["type", c.dataType],
          ["description", c.description],
          ["expression", c.expression],
        ]),
      );
      return;
    }
    case "writeback": {
      const w = requireOne(o.writebackColumns, (x) => x.name, pat!, "writeback column", cmd.line);
      io.print(
        detailBlock([
          ["writeback", `${w.table}[${w.name}]`],
          ["id", w.id],
          ["type", w.dataType],
          ["kind", w.kind],
          ["keys", w.keyColumns.join(", ")],
          ["projection", w.projectionMode],
          ["projection expr", w.projectionExpression],
          ["required", yesNo(w.required)],
          ["min", w.min !== null ? String(w.min) : null],
          ["max", w.max !== null ? String(w.max) : null],
          ["enum", w.enumValues.join(", ") || null],
          ["max length", w.maxLength !== null ? String(w.maxLength) : null],
          ["pattern", w.pattern],
          ["editors", w.allowedEditors.join(", ") || null],
          ["expose history", yesNo(w.exposeHistory)],
          ["history table", w.historyTable],
        ]),
      );
      return;
    }
    case "source": {
      const src = requireOne(o.sources, sourceLabel, pat!, "source", cmd.line);
      io.print(
        detailBlock([
          ["source", sourceLabel(src)],
          ["id", src.id],
          ["kind", src.kind],
          ["host", src.host || null],
          ["port", src.port !== null ? String(src.port) : null],
          ["database", src.database || null],
          ["schema", src.defaultSchema],
          ["auth", src.preferredAuth],
          ["ssl", src.sslMode],
          ["bound tables", String(src.tableCount)],
        ]),
      );
      return;
    }
    default:
      throw new CliError(`'show' does not support '${cmd.kind}' (try 'help show')`, cmd.line);
  }
}

// ---------------------------------------------------------------------------
// Shared descriptors
// ---------------------------------------------------------------------------

export function columnKind(c: ModelColumnInfo): string {
  if (c.isDynamic) return "context";
  if (c.isCalculated) return "calculated";
  return "physical";
}

export function relEndpoints(r: ModelRelationshipInfo): string {
  return r.conditions
    .map(
      (c) =>
        `${r.fromTable}[${c.fromColumn}] ${c.operator && c.operator !== "=" ? c.operator + " " : ""}-> ${r.toTable}[${c.toColumn}]`,
    )
    .join(", ");
}

export function sourceLabel(src: ModelOverview["sources"][number]): string {
  return src.displayName ?? src.id;
}

/** Split a relationship command's target into name-pattern vs endpoints. */
export function relationshipTarget(cmd: Command): {
  namePat: string | null;
  from: ValueTok | null;
  to: ValueTok | null;
} {
  if (cmd.arrowPos.length > 0 || (cmd.pos[0] && cmd.pos[0].kind === "colref")) {
    return {
      namePat: null,
      from: cmd.pos[0] ?? null,
      to: cmd.arrowPos[0] ?? null,
    };
  }
  return { namePat: cmd.pos[0]?.text ?? null, from: null, to: null };
}

/** Refresh-strategy one-liner (mirrors the set syntax so users can copy). */
export function describeRefresh(r: ModelTableInfo["refreshStrategies"][number]): string {
  switch (r.type) {
    case "interval":
      return `interval:${r.secs ?? "?"}`;
    case "dailyAfter":
      return `daily:${String(r.hour ?? 0).padStart(2, "0")}:${String(r.minute ?? 0).padStart(2, "0")}`;
    case "containsCurrentDate":
      return `currentdate:${r.column ?? "?"}`;
    case "sourceQuery":
      return "sourcequery";
    default:
      return r.type;
  }
}
