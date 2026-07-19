// FILENAME: app/extensions/ModelEditor/cli/writers.ts
// PURPOSE: The CLI's write commands: add / set / rename / delete plus the
//          misc verbs (refresh, materialize, import, connect). Every edit
//          calls the SAME typed @api gateway the visual editor uses, so undo,
//          events and persistence come along for free. `set`/`rename` are
//          read-modify-write: unspecified properties carry over unchanged.

import type {
  CalcGroupItemDto,
  HierarchyLevelDto,
  KpiBandDto,
  ModelCalcGroupInfo,
  ModelCultureInfo,
  ModelOverview,
  ModelRelationshipInfo,
  NameTranslationInfo,
  RefreshStrategyDto,
  RoleFilterDto,
  ScriptParamDto,
} from "@api";
import { CliError } from "./lex";
import type { ValueTok } from "./lex";
import { optAll, optBool, optList, optNum, optStr } from "./parse";
import type { Command } from "./parse";
import type { CliIo, CliSession } from "./execute";
import { mutMeasures, mutOverview, requireWritable } from "./execute";
import { isPattern, matchColumns, matchNamed, matchRelationships, matchTables, requireOne, requireTable } from "./resolve";
import type { ColumnMatch } from "./resolve";
import { relationshipTarget, sourceLabel } from "./readers";
import { plural } from "./format";

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function fail(msg: string, line: number): never {
  throw new CliError(msg, line);
}

/** First positional target, required. */
function primary(cmd: Command, usage: string): ValueTok {
  const t = cmd.pos[0];
  if (!t) fail(`Usage: ${usage}`, cmd.line);
  return t;
}

/** Second positional (rename's new name), required. */
function secondary(cmd: Command, usage: string): ValueTok {
  const t = cmd.pos[1];
  if (!t) fail(`Usage: ${usage}`, cmd.line);
  return t;
}

/** Option merge: undefined = keep existing, "" = clear, else the new value. */
function mergeStr(opt: string | undefined, existing: string | null): string | null {
  if (opt === undefined) return existing;
  return opt === "" ? null : opt;
}

/** A calc-group upsert REPLACES the whole group — every CLI edit that only
 *  touches items must carry the selection-state expressions (and their
 *  static + dynamic formats) over unchanged. */
function selectionCarry(grp: ModelCalcGroupInfo): {
  multipleOrEmptySelection: string | null;
  multipleOrEmptySelectionFormat: string | null;
  multipleOrEmptySelectionFormatExpression: string | null;
  noSelection: string | null;
  noSelectionFormat: string | null;
  noSelectionFormatExpression: string | null;
} {
  return {
    multipleOrEmptySelection: grp.multipleOrEmptySelection ?? null,
    multipleOrEmptySelectionFormat: grp.multipleOrEmptySelectionFormat ?? null,
    multipleOrEmptySelectionFormatExpression:
      grp.multipleOrEmptySelectionFormatExpression ?? null,
    noSelection: grp.noSelection ?? null,
    noSelectionFormat: grp.noSelectionFormat ?? null,
    noSelectionFormatExpression: grp.noSelectionFormatExpression ?? null,
  };
}

function noWildcard(name: string, what: string, line: number): string {
  if (isPattern(name)) fail(`A ${what} name cannot contain * or ?`, line);
  return name;
}

function requireExpr(cmd: Command, usage: string): string {
  if (cmd.expr === null || cmd.expr === "") fail(`Missing '= <expression>'. Usage: ${usage}`, cmd.line);
  return cmd.expr;
}

const DATA_TYPES: Record<string, string> = {
  string: "String",
  text: "String",
  int: "Int64",
  int32: "Int32",
  int64: "Int64",
  float: "Float64",
  float64: "Float64",
  double: "Float64",
  number: "Float64",
  boolean: "Boolean",
  bool: "Boolean",
  date: "Date",
  timestamp: "Timestamp",
  datetime: "Timestamp",
};

function dataType(s: string, line: number): string {
  const t = DATA_TYPES[s.toLowerCase()];
  if (!t) fail(`Unknown data type '${s}' (String, Int32, Int64, Float64, Boolean, Date, Timestamp)`, line);
  return t;
}

// The m:1 / 1:m shorthands are user-facing CLI spellings, not identifiers.
/* eslint-disable @typescript-eslint/naming-convention */
const CARDINALITIES: Record<string, string> = {
  manytoone: "manyToOne",
  "m:1": "manyToOne",
  onetomany: "oneToMany",
  "1:m": "oneToMany",
  onetoone: "oneToOne",
  "1:1": "oneToOne",
  manytomany: "manyToMany",
  "m:m": "manyToMany",
};
/* eslint-enable @typescript-eslint/naming-convention */

function cardinality(s: string, line: number): string {
  const c = CARDINALITIES[s.toLowerCase()];
  if (!c) fail(`Unknown cardinality '${s}' (manyToOne, oneToMany, oneToOne, manyToMany or m:1, 1:m, 1:1, m:m)`, line);
  return c;
}

const KPI_STATUSES: Record<string, string> = {
  offtrack: "offTrack",
  atrisk: "atRisk",
  ontrack: "onTrack",
};

/** Parse `Table[Column] <op> value` role/table-variable filters. A value of
 *  @username / @customdata makes the filter dynamic RLS. */
export function parseFilter(text: string, line: number): RoleFilterDto {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|([^[\]]+?))\s*\[\s*(.+?)\s*\]\s*(!=|>=|<=|=|>|<)\s*([\s\S]+?)\s*$/.exec(text);
  if (!m) fail(`Cannot parse filter '${text}' — expected Table[Column] = value`, line);
  const table = (m[1] ?? m[2] ?? m[3]).trim();
  const column = m[4].trim();
  const operator = m[5];
  let value = m[6].trim();
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1);
  }
  const dyn = value.toLowerCase();
  if (dyn === "@username") return { table, column, operator, value: "", dynamic: "username" };
  if (dyn === "@customdata") return { table, column, operator, value: "", dynamic: "customData" };
  return { table, column, operator, value, dynamic: null };
}

function parseFilters(cmd: Command, key: string): RoleFilterDto[] | undefined {
  if (!cmd.opts.has(key)) return undefined;
  return optAll(cmd, key)
    .filter((v) => v.text !== "")
    .map((v) => parseFilter(v.text, cmd.line));
}

function parseBands(cmd: Command): KpiBandDto[] | undefined {
  const vals = optList(cmd, "bands");
  if (vals === undefined) return undefined;
  return vals.map((v) => {
    const idx = v.text.indexOf(":");
    if (idx < 0) fail(`Band '${v.text}' must be threshold:status (e.g. 0:offTrack)`, cmd.line);
    const threshold = Number(v.text.slice(0, idx));
    if (!Number.isFinite(threshold)) fail(`Band threshold '${v.text}' is not a number`, cmd.line);
    const status = KPI_STATUSES[v.text.slice(idx + 1).toLowerCase()];
    if (!status) fail(`Band status in '${v.text}' must be offTrack, atRisk or onTrack`, cmd.line);
    return { threshold, status };
  });
}

function parseParams(cmd: Command): ScriptParamDto[] | undefined {
  const vals = optList(cmd, "params");
  if (vals === undefined) return undefined;
  const TYPES: Record<string, string> = { int: "Int", float: "Float", bool: "Bool", string: "String" };
  return vals
    .filter((v) => v.text !== "")
    .map((v) => {
      const idx = v.text.indexOf(":");
      if (idx < 0) fail(`Param '${v.text}' must be name:Type (Int, Float, Bool, String)`, cmd.line);
      const name = v.text.slice(0, idx);
      const ty = TYPES[v.text.slice(idx + 1).toLowerCase()];
      if (!ty) fail(`Param type in '${v.text}' must be Int, Float, Bool or String`, cmd.line);
      return { name, ty };
    });
}

function parseRefresh(cmd: Command): RefreshStrategyDto[] | undefined {
  const vals = optList(cmd, "refresh");
  if (vals === undefined) return undefined;
  if (vals.length === 1 && vals[0].text.toLowerCase() === "none") return [];
  return vals.map((v) => {
    const [head, ...rest] = v.text.split(":");
    switch (head.toLowerCase()) {
      case "interval": {
        const secs = Number(rest[0]);
        if (!Number.isFinite(secs) || secs <= 0) fail(`interval:<seconds> — got '${v.text}'`, cmd.line);
        return { type: "interval", secs };
      }
      case "daily": {
        const hour = Number(rest[0]);
        const minute = Number(rest[1] ?? "0");
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) fail(`daily:<HH>:<MM> — got '${v.text}'`, cmd.line);
        return { type: "dailyAfter", hour, minute };
      }
      case "currentdate": {
        if (!rest[0]) fail(`currentdate:<column> — got '${v.text}'`, cmd.line);
        return { type: "containsCurrentDate", column: rest.join(":") };
      }
      default:
        fail(`Unknown refresh strategy '${head}' (none, interval:secs, daily:HH:MM, currentdate:column)`, cmd.line);
    }
  });
}

/** Qualified `Table[Column]` strings from a colref/word token list. */
function qualifiedRefs(vals: ValueTok[], line: number): string[] {
  return vals
    .filter((v) => v.text !== "")
    .map((v) => {
      if (v.kind === "colref") return `${v.table}[${v.column}]`;
      fail(`'${v.text}' must be a qualified Table[Column] reference`, line);
    });
}

function stringsOf(vals: ValueTok[]): string[] {
  return vals.map((v) => v.text).filter((t) => t !== "");
}

// ---------------------------------------------------------------------------
// Target expansion (shared by preview + execution)
// ---------------------------------------------------------------------------

interface NamedTarget {
  label: string;
  name: string;
}

/** Expand a set/rename/delete/refresh/materialize target to concrete names.
 *  Returns null when the verb+kind carries no name-pattern target. */
function expandNamed(cmd: Command, s: CliSession): NamedTarget[] | null {
  const o = s.overview;
  const t0 = cmd.pos[0];
  const pat = t0?.text ?? null;
  const named = <T>(items: T[], nameOf: (x: T) => string, kindLabel: string): NamedTarget[] => {
    if (pat === null) fail(`Usage: ${cmd.verb} ${cmd.kind} <name>`, cmd.line);
    const m = matchNamed(items, nameOf, pat);
    if (m.length === 0) fail(`No ${kindLabel} matches '${pat}'`, cmd.line);
    return m.map((x) => ({ label: `${kindLabel} ${nameOf(x)}`, name: nameOf(x) }));
  };

  switch (cmd.kind) {
    case "table":
      return named(matchTables(o, pat ?? "*"), (t) => t.name, "table");
    case "measure":
      return named(o.measures, (m) => m.name, "measure");
    case "column": {
      if (!t0 || t0.kind !== "colref") fail(`Usage: ${cmd.verb} column Table[Column]`, cmd.line);
      const m = matchColumns(o, t0.table ?? "*", t0.column ?? "*");
      if (m.length === 0) fail(`No column matches '${t0.text}'`, cmd.line);
      return m.map((x) => ({
        label: `column ${x.table.name}[${x.column.name}]`,
        name: `${x.table.name}[${x.column.name}]`,
      }));
    }
    case "relationship": {
      const { namePat, from, to } = relationshipTarget(cmd);
      if (namePat === null && from === null && to === null) {
        fail("Give a relationship name or a From -> To endpoint pattern", cmd.line);
      }
      const m = matchRelationships(o, namePat, from, to);
      if (m.length === 0) fail("No relationship matches", cmd.line);
      return m.map((r) => ({ label: `relationship ${r.name} (${r.fromTable} -> ${r.toTable})`, name: r.name }));
    }
    case "hierarchy":
      return named(o.hierarchies, (h) => h.name, "hierarchy");
    case "kpi":
      return named(o.kpis, (k) => k.name, "KPI");
    case "role":
      return named(o.securityRoles, (r) => r.name, "role");
    case "perspective":
      return named(o.perspectives, (p) => p.name, "perspective");
    case "culture":
      return named(o.cultures, (c) => c.locale, "culture");
    case "calcgroup":
      return named(o.calculationGroups, (g) => g.name, "calculation group");
    case "calcitem": {
      if (!t0 || t0.kind !== "colref") fail(`Usage: ${cmd.verb} calcitem Group[Item]`, cmd.line);
      const group = requireOne(o.calculationGroups, (g) => g.name, t0.table ?? "", "calculation group", cmd.line);
      const items = matchNamed(group.items, (i) => i.name, t0.column ?? "*");
      if (items.length === 0) fail(`No item matches '${t0.text}'`, cmd.line);
      return items.map((i) => ({ label: `calc item ${group.name}[${i.name}]`, name: i.name }));
    }
    case "calctable":
      return named(o.globalVariables, (g) => g.name, "calculated table");
    case "tablevar":
      return named(o.tableVariables, (v) => v.name, "table variable");
    case "scriptfunction":
      return named(o.scriptFunctions, (f) => f.name, "script function");
    case "context":
      return named(o.contexts, (c) => c.name, "context");
    case "contextcolumn":
      return named(o.contextColumns, (c) => c.name, "context column");
    case "writeback":
      return named(o.writebackColumns, (w) => w.name, "writeback column");
    case "source":
      return named(o.sources, sourceLabel, "source");
    case "extdata": {
      if (pat === null) fail(`Usage: ${cmd.verb} extdata <key>`, cmd.line);
      return [{ label: `extension data ${pat}`, name: pat }];
    }
    case "translation":
    case "model":
      return null; // handled per-verb
    default:
      fail(`'${cmd.verb}' does not support '${cmd.kind ?? "?"}' (try 'help ${cmd.verb}')`, cmd.line);
  }
}

export interface WritePreview {
  labels: string[];
  wildcard: boolean;
}

/** Static preview of a command's writes (null = read-only command). Used for
 *  the confirmation step; wildcards re-expand at execution time. */
export function previewWriteCommand(cmd: Command, s: CliSession): WritePreview | null {
  const wildcardIn = (toks: ValueTok[]): boolean => toks.some((t) => isPattern(t.text));
  switch (cmd.verb) {
    case "ls":
    case "show":
    case "validate":
    case "help":
    case "clear":
    case "undo":
    case "redo":
      return null;
    case "add":
      return { labels: [`add ${cmd.kind ?? "?"} ${cmd.pos[0]?.text ?? ""}`.trim()], wildcard: false };
    case "import":
      return { labels: [cmd.raw.trim().split("\n")[0]], wildcard: false };
    case "connect":
      return { labels: [`connect source ${cmd.pos[0]?.text ?? ""}`], wildcard: false };
    case "set":
    case "rename":
    case "delete":
    case "refresh":
    case "materialize": {
      if (cmd.kind === "model" || cmd.kind === "translation") {
        return { labels: [`${cmd.verb} ${cmd.kind}`], wildcard: false };
      }
      const targets = expandNamed(cmd, s);
      if (cmd.verb === "set" && cmd.expr !== null && targets !== null && targets.length > 1) {
        fail(
          `A formula can only be set on ONE object ('${cmd.pos[0]?.text}' matches ${targets.length})`,
          cmd.line,
        );
      }
      const labels = (targets ?? []).map((t) => `${cmd.verb} ${t.label}`);
      return { labels, wildcard: wildcardIn([...cmd.pos, ...cmd.arrowPos]) };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Write dispatch
// ---------------------------------------------------------------------------

export async function runWrite(cmd: Command, s: CliSession, io: CliIo): Promise<void> {
  requireWritable(s, cmd.line);
  switch (cmd.verb) {
    case "add":
      await runAdd(cmd, s, io);
      return;
    case "set":
      await runSet(cmd, s, io);
      return;
    case "rename":
      await runRename(cmd, s, io);
      return;
    case "delete":
      await runDelete(cmd, s, io);
      return;
    case "refresh": {
      if (cmd.kind !== "table") fail("Usage: refresh table <name>", cmd.line);
      const targets = expandNamed(cmd, s) ?? [];
      for (const t of targets) {
        await s.gateway.refreshTable(s.connectionId, t.name);
        io.print(`Refreshed ${t.name}.`, "info");
      }
      return;
    }
    case "materialize": {
      if (cmd.kind !== "calctable") fail("Usage: materialize calctable <name>", cmd.line);
      const targets = expandNamed(cmd, s) ?? [];
      for (const t of targets) {
        await s.gateway.materializeCalculatedTable(s.connectionId, t.name);
        s.hadEdits = true;
        s.overviewDirty = true;
        io.print(`Materialized ${t.name}.`, "info");
      }
      return;
    }
    case "import":
      await runImport(cmd, s, io);
      return;
    case "connect": {
      if (cmd.kind !== "source") fail("Usage: connect source <name> connstr=\"…\"", cmd.line);
      const src = requireOne(s.overview.sources, sourceLabel, primary(cmd, "connect source <name> connstr=\"…\"").text, "source", cmd.line);
      const connstr = optStr(cmd, "connstr");
      if (!connstr) fail("connect source needs connstr=\"<connection string>\"", cmd.line);
      await mutOverview(s, () => s.gateway.connectSource(s.connectionId, src.id, connstr));
      io.print(`Connected source ${sourceLabel(src)}.`, "info");
      return;
    }
    default:
      fail(`Unhandled command '${cmd.verb}'`, cmd.line);
  }
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

async function runAdd(cmd: Command, s: CliSession, io: CliIo): Promise<void> {
  const g = s.gateway;
  const o = s.overview;
  const cid = s.connectionId;
  const done = (what: string): void => io.print(`Added ${what}.`, "info");

  switch (cmd.kind) {
    case "measure": {
      const name = noWildcard(primary(cmd, "add measure [Name] = <formula>").text, "measure", cmd.line);
      const formula = requireExpr(cmd, "add measure [Name] = <formula>");
      await mutMeasures(s, () =>
        g.upsertMeasure({
          connectionId: cid,
          name,
          formula,
          description: mergeStr(optStr(cmd, "description"), null),
          formatString: mergeStr(optStr(cmd, "format"), null),
          formatStringExpression: mergeStr(optStr(cmd, "formatexpr"), null),
          detailRows: cmd.opts.has("detailrows") ? qualifiedRefs(optList(cmd, "detailrows") ?? [], cmd.line) : null,
          group: mergeStr(optStr(cmd, "folder"), null),
          hidden: optBool(cmd, "hidden") ?? null,
        }),
      );
      done(`measure [${name}]`);
      return;
    }
    case "column": {
      const t0 = primary(cmd, "add column Table[Name] = <formula>");
      if (t0.kind !== "colref") fail("Usage: add column Table[Name] = <formula>", cmd.line);
      const table = requireTable(o, t0.table ?? "", cmd.line);
      const name = noWildcard(t0.column ?? "", "column", cmd.line);
      const formula = requireExpr(cmd, "add column Table[Name] = <formula>");
      await mutOverview(s, () =>
        g.upsertModelColumn({
          connectionId: cid,
          name,
          table: table.name,
          formula,
          dataType: dataType(optStr(cmd, "type") ?? "Float64", cmd.line),
          description: optStr(cmd, "description") ?? "",
        }),
      );
      done(`column ${table.name}[${name}]`);
      return;
    }
    case "relationship": {
      if (cmd.pos.length === 0 || cmd.arrowPos.length === 0) {
        fail("Usage: add relationship From[col] -> To[col] [cardinality=m:1] [active=true] [propagation=auto]", cmd.line);
      }
      const froms = cmd.pos.filter((t) => t.kind === "colref");
      const tos = cmd.arrowPos.filter((t) => t.kind === "colref");
      if (froms.length === 0 || froms.length !== tos.length) {
        fail("Both endpoints need column refs, pairwise: From[a],From[b] -> To[x],To[y]", cmd.line);
      }
      const fromTable = requireTable(o, froms[0].table ?? "", cmd.line).name;
      const toTable = requireTable(o, tos[0].table ?? "", cmd.line).name;
      const OPS: Record<string, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
      const opVals = optList(cmd, "ops")?.map((v) => {
        const op = OPS[v.text.toLowerCase()];
        if (!op) fail(`Unknown join operator '${v.text}' (eq, gt, gte, lt, lte)`, cmd.line);
        return op;
      });
      if (opVals && opVals.length !== 1 && opVals.length !== froms.length) {
        fail("ops= must give one operator, or one per condition", cmd.line);
      }
      const conditions = froms.map((f, i) => ({
        fromColumn: f.column ?? "",
        toColumn: tos[i].column ?? "",
        operator: opVals ? (opVals[i] ?? opVals[0]) : "=",
      }));
      let name = optStr(cmd, "name") ?? "";
      if (name === "") {
        const base = `${fromTable}_${toTable}`;
        name = base;
        for (let i = 2; o.relationships.some((r) => r.name === name); i++) name = `${base}_${i}`;
      }
      await mutOverview(s, () =>
        g.upsertRelationship({
          connectionId: cid,
          name,
          fromTable,
          toTable,
          conditions,
          cardinality: cardinality(optStr(cmd, "cardinality") ?? "manyToOne", cmd.line),
          active: optBool(cmd, "active") ?? true,
          filterPropagation: optStr(cmd, "propagation") ?? null,
        }),
      );
      done(`relationship ${name} (${fromTable} -> ${toTable})`);
      return;
    }
    case "hierarchy": {
      const name = noWildcard(primary(cmd, "add hierarchy Name table=T levels=Col1,Col2").text, "hierarchy", cmd.line);
      const tableOpt = optStr(cmd, "table");
      if (!tableOpt) fail("add hierarchy needs table=<table>", cmd.line);
      const levels = optList(cmd, "levels");
      if (!levels || levels.length === 0) fail("add hierarchy needs levels=<col1,col2,…>", cmd.line);
      await mutOverview(s, () =>
        g.upsertHierarchy({
          connectionId: cid,
          name,
          table: requireTable(o, tableOpt, cmd.line).name,
          levels: stringsOf(levels).map((column): HierarchyLevelDto => ({ column })),
        }),
      );
      done(`hierarchy ${name}`);
      return;
    }
    case "kpi": {
      const name = noWildcard(primary(cmd, "add kpi Name base=[Measure] target=[Measure]|targetvalue=N bands=0:offTrack,…").text, "KPI", cmd.line);
      const base = optStr(cmd, "base");
      if (!base) fail("add kpi needs base=[Measure]", cmd.line);
      await mutOverview(s, () =>
        g.upsertKpi({
          connectionId: cid,
          name,
          baseMeasure: base,
          targetMeasure: mergeStr(optStr(cmd, "target"), null),
          targetConstant: optNum(cmd, "targetvalue") ?? null,
          statusBands: parseBands(cmd) ?? [],
          description: mergeStr(optStr(cmd, "description"), null),
        }),
      );
      done(`KPI ${name}`);
      return;
    }
    case "role": {
      const name = noWildcard(primary(cmd, "add role Name filter=\"T[col] = value\" …").text, "role", cmd.line);
      const denies = optAll(cmd, "deny");
      await mutOverview(s, () =>
        g.upsertRole({
          connectionId: cid,
          name,
          filters: parseFilters(cmd, "filter") ?? [],
          deniedTables: denies.filter((d) => d.kind !== "colref").map((d) => d.text),
          deniedColumns: denies.filter((d) => d.kind === "colref").map((d) => `${d.table}[${d.column}]`),
        }),
      );
      done(`role ${name}`);
      return;
    }
    case "perspective": {
      const name = noWildcard(primary(cmd, "add perspective Name tables=A,B measures=[M],…").text, "perspective", cmd.line);
      await mutOverview(s, () =>
        g.upsertPerspective({
          connectionId: cid,
          name,
          tables: stringsOf(optList(cmd, "tables") ?? []),
          columns: cmd.opts.has("columns") ? qualifiedRefs(optList(cmd, "columns") ?? [], cmd.line) : [],
          measures: stringsOf(optList(cmd, "measures") ?? []),
          description: mergeStr(optStr(cmd, "description"), null),
        }),
      );
      done(`perspective ${name}`);
      return;
    }
    case "culture": {
      const locale = noWildcard(primary(cmd, "add culture <locale>").text, "culture", cmd.line);
      await mutOverview(s, () =>
        g.upsertCulture({ connectionId: cid, locale, tables: [], columns: [], measures: [] }),
      );
      done(`culture ${locale}`);
      return;
    }
    case "calcgroup": {
      const name = noWildcard(primary(cmd, "add calcgroup Name").text, "calculation group", cmd.line);
      await mutOverview(s, () => g.upsertCalcGroup({ connectionId: cid, name, items: [] }));
      done(`calculation group ${name}`);
      return;
    }
    case "calcitem": {
      const t0 = primary(cmd, "add calcitem Group[Item] = <formula>");
      if (t0.kind !== "colref") fail("Usage: add calcitem Group[Item] = <formula>", cmd.line);
      const group = requireOne(o.calculationGroups, (x) => x.name, t0.table ?? "", "calculation group", cmd.line);
      const itemName = noWildcard(t0.column ?? "", "calc item", cmd.line);
      const formula = requireExpr(cmd, "add calcitem Group[Item] = <formula>");
      if (group.items.some((i) => i.name === itemName)) fail(`'${group.name}' already has an item '${itemName}'`, cmd.line);
      const items: CalcGroupItemDto[] = [...group.items, { name: itemName, formula }];
      await mutOverview(s, () =>
        g.upsertCalcGroup({
          connectionId: cid,
          originalName: group.name,
          name: group.name,
          items,
          ...selectionCarry(group),
        }),
      );
      done(`calc item ${group.name}[${itemName}]`);
      return;
    }
    case "calctable": {
      const name = noWildcard(primary(cmd, "add calctable Name = <expression>").text, "calculated table", cmd.line);
      const expression = requireExpr(cmd, "add calctable Name = <expression>");
      await mutOverview(s, () =>
        g.upsertGlobalVariable({
          connectionId: cid,
          name,
          table: optStr(cmd, "table"),
          expression,
          dynamic: optBool(cmd, "dynamic") ?? true,
          cascade: optBool(cmd, "cascade") ?? false,
        }),
      );
      done(`calculated table ${name}`);
      return;
    }
    case "tablevar": {
      const name = noWildcard(primary(cmd, "add tablevar Name source=<table> [filter=\"…\"]").text, "table variable", cmd.line);
      const source = optStr(cmd, "source");
      if (!source) fail("add tablevar needs source=<table or table variable>", cmd.line);
      await mutOverview(s, () =>
        g.upsertTableVariable({ connectionId: cid, name, source, filters: parseFilters(cmd, "filter") ?? [] }),
      );
      done(`table variable ${name}`);
      return;
    }
    case "scriptfunction": {
      const name = noWildcard(primary(cmd, "add func Name params=a:Int,b:Float returns=Float = <body>").text, "script function", cmd.line);
      const body = requireExpr(cmd, "add func Name params=a:Int returns=Float = <body>");
      await mutOverview(s, () =>
        g.upsertScriptFunction({
          connectionId: cid,
          name,
          params: parseParams(cmd) ?? [],
          returnType: optStr(cmd, "returns") ?? "Float",
          body,
        }),
      );
      done(`script function ${name}`);
      return;
    }
    case "context": {
      const name = noWildcard(primary(cmd, "add context Name [ops='<json>']").text, "context", cmd.line);
      await mutOverview(s, () =>
        g.upsertContext({ connectionId: cid, name, operations: parseContextOps(cmd) ?? [] }),
      );
      done(`context ${name}`);
      return;
    }
    case "writeback": {
      const t0 = primary(cmd, "add writeback Table[Name] type=Float64 keys=colA,colB");
      if (t0.kind !== "colref") fail("Usage: add writeback Table[Name] type=… keys=…", cmd.line);
      const table = requireTable(o, t0.table ?? "", cmd.line);
      const name = noWildcard(t0.column ?? "", "writeback column", cmd.line);
      const keys = optList(cmd, "keys");
      if (!keys || keys.length === 0) fail("add writeback needs keys=<key columns on the table>", cmd.line);
      await mutOverview(s, () =>
        g.upsertWritebackColumn({
          connectionId: cid,
          name,
          table: table.name,
          dataType: dataType(optStr(cmd, "type") ?? "Float64", cmd.line),
          keyColumns: stringsOf(keys),
          kind: optStr(cmd, "kind") ?? "history",
          projectionMode: optStr(cmd, "projection") ?? "blank",
          projectionExpression: mergeStr(optStr(cmd, "projexpr"), null),
          required: optBool(cmd, "required") ?? false,
          min: optNum(cmd, "min") ?? null,
          max: optNum(cmd, "max") ?? null,
          enumValues: stringsOf(optList(cmd, "enum") ?? []),
          maxLength: optNum(cmd, "maxlength") ?? null,
          pattern: mergeStr(optStr(cmd, "pattern"), null),
          allowedEditors: stringsOf(optList(cmd, "editors") ?? []),
          exposeHistory: optBool(cmd, "history") ?? false,
        }),
      );
      done(`writeback column ${table.name}[${name}]`);
      return;
    }
    case "source": {
      const kind = optStr(cmd, "kind");
      if (!kind) fail("add source needs kind=postgres|sqlServer|inMemory|csv|parquet", cmd.line);
      const name = cmd.pos[0]?.text ?? null;
      await mutOverview(s, () =>
        g.upsertSource({
          connectionId: cid,
          id: crypto.randomUUID(),
          kind,
          host: mergeStr(optStr(cmd, "host"), null),
          port: optNum(cmd, "port") ?? null,
          database: mergeStr(optStr(cmd, "database"), null),
          defaultSchema: mergeStr(optStr(cmd, "schema"), null),
          trustServerCertificate: optBool(cmd, "trustcert") ?? false,
          sslMode: mergeStr(optStr(cmd, "ssl"), null),
          preferredAuth: optStr(cmd, "auth") ?? "integrated",
          displayName: name,
        }),
      );
      done(`source${name ? " " + name : ""} (${kind})`);
      return;
    }
    default:
      fail(`'add' does not support '${cmd.kind ?? "?"}' (try 'help add')`, cmd.line);
  }
}

function parseContextOps(cmd: Command): ModelOverview["contexts"][number]["operations"] | undefined {
  const raw = optStr(cmd, "ops");
  if (raw === undefined) return undefined;
  if (raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed as ModelOverview["contexts"][number]["operations"];
  } catch (e) {
    fail(`ops= must be a JSON array of context operations (${e instanceof Error ? e.message : String(e)})`, cmd.line);
  }
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

async function runSet(cmd: Command, s: CliSession, io: CliIo): Promise<void> {
  const g = s.gateway;
  const cid = s.connectionId;

  if (cmd.kind === "model") {
    await setModel(cmd, s, io);
    return;
  }
  if (cmd.kind === "translation") {
    await setTranslation(cmd, s, io, false);
    return;
  }
  if (cmd.kind === "extdata") {
    const key = primary(cmd, "set extdata <key> = <json>").text;
    const raw = requireExpr(cmd, "set extdata <key> = <json>");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      fail("extension-data values must be valid JSON (quote strings: \"like this\")", cmd.line);
    }
    await g.extensionDataSet(cid, key, value);
    s.hadEdits = true;
    s.overviewDirty = true;
    io.print(`Set extension data ${key}.`, "info");
    return;
  }

  const targets = expandNamed(cmd, s) ?? fail(`'set' does not support '${cmd.kind ?? "?"}'`, cmd.line);
  if (cmd.expr !== null && targets.length > 1) {
    fail(`A formula can only be set on ONE object ('${cmd.pos[0]?.text}' matches ${targets.length})`, cmd.line);
  }
  for (const t of targets) {
    await setOne(cmd, s, t.name);
    io.print(`Updated ${t.label}.`, "info");
  }
}

/** Apply one `set` to one concrete object (read-modify-write). */
async function setOne(cmd: Command, s: CliSession, name: string): Promise<void> {
  const g = s.gateway;
  const o = s.overview;
  const cid = s.connectionId;
  const line = cmd.line;

  switch (cmd.kind) {
    case "measure": {
      const m = o.measures.find((x) => x.name === name)!;
      await mutMeasures(s, () =>
        g.upsertMeasure({
          connectionId: cid,
          originalName: m.name,
          name: m.name,
          formula: cmd.expr !== null && cmd.expr !== "" ? cmd.expr : m.formula,
          description: mergeStr(optStr(cmd, "description"), m.description),
          formatString: mergeStr(optStr(cmd, "format"), m.formatString),
          formatStringExpression: mergeStr(optStr(cmd, "formatexpr"), m.formatStringExpression),
          detailRows: cmd.opts.has("detailrows")
            ? nullIfEmpty(qualifiedRefs(optList(cmd, "detailrows") ?? [], line))
            : m.detailRows,
          group: mergeStr(optStr(cmd, "folder"), m.group),
          hidden: optBool(cmd, "hidden") ?? null,
        }),
      );
      return;
    }
    case "table": {
      const t = o.tables.find((x) => x.name === name)!;
      const storage = optStr(cmd, "storage");
      const sourceOpt = optStr(cmd, "source");
      const refresh = parseRefresh(cmd);
      const incremental = optStr(cmd, "incremental");
      if (cmd.opts.has("displayname") || cmd.opts.has("description") || cmd.opts.has("hidden")) {
        await mutOverview(s, () =>
          g.updateTable({
            connectionId: cid,
            table: t.name,
            displayName: mergeStr(optStr(cmd, "displayname"), t.displayName),
            description: mergeStr(optStr(cmd, "description"), t.description),
            isHidden: optBool(cmd, "hidden") ?? t.isHidden,
          }),
        );
      }
      if (storage !== undefined && storage !== "") {
        await mutOverview(s, () => g.setTableStorageMode(cid, t.name, storage));
      }
      if (refresh !== undefined || incremental !== undefined) {
        await mutOverview(s, () =>
          g.setTableRefresh({
            connectionId: cid,
            tableName: t.name,
            strategies: refresh ?? t.refreshStrategies,
            incrementalRefresh: mergeStr(incremental, t.incrementalRefresh),
          }),
        );
      }
      if (sourceOpt !== undefined) {
        if (sourceOpt === "" || sourceOpt.toLowerCase() === "none") {
          await mutOverview(s, () => g.setTableSourceBinding(cid, t.name, null, "", ""));
        } else {
          const src = requireOne(o.sources, sourceLabel, sourceOpt, "source", line);
          const schema = optStr(cmd, "schema") ?? "";
          const sourceTable = optStr(cmd, "sourcetable") ?? t.name;
          await mutOverview(s, () => g.setTableSourceBinding(cid, t.name, src.id, schema, sourceTable));
        }
      }
      return;
    }
    case "column": {
      const [tName, cName] = splitQualified(name);
      const t = o.tables.find((x) => x.name === tName)!;
      const c = t.columns.find((x) => x.name === cName)!;
      const isExprCol = c.isCalculated || c.isDynamic;
      const type = optStr(cmd, "type");
      if (cmd.expr !== null || type !== undefined) {
        if (!isExprCol) fail(`${name} is a physical column — its formula/type cannot be set`, line);
        await mutOverview(s, () =>
          g.upsertModelColumn({
            connectionId: cid,
            originalName: c.name,
            name: c.name,
            table: t.name,
            formula: cmd.expr !== null && cmd.expr !== "" ? cmd.expr : (c.formula ?? ""),
            dataType: type !== undefined && type !== "" ? dataType(type, line) : c.dataType,
            description: optStr(cmd, "description") ?? null,
          }),
        );
      }
      const metaKeys = ["displayname", "hidden", "format", "sortby", "lookup"] as const;
      const hasMeta = metaKeys.some((k) => cmd.opts.has(k)) || (!isExprCol && cmd.opts.has("description"));
      if (hasMeta) {
        await mutOverview(s, () =>
          g.updateColumn({
            connectionId: cid,
            table: t.name,
            column: c.name,
            displayName: mergeStr(optStr(cmd, "displayname"), c.displayName),
            description: mergeStr(optStr(cmd, "description"), c.description),
            isHidden: optBool(cmd, "hidden") ?? c.isHidden,
            lookupResolution: mergeStr(optStr(cmd, "lookup"), c.lookupResolution),
            sortByColumn: mergeStr(optStr(cmd, "sortby"), c.sortByColumn),
            formatString: mergeStr(optStr(cmd, "format"), c.formatString),
          }),
        );
      }
      return;
    }
    case "relationship": {
      const r = o.relationships.find((x) => x.name === name)!;
      await upsertRelationshipCarry(s, r, {
        cardinality: optStr(cmd, "cardinality") !== undefined ? cardinality(optStr(cmd, "cardinality")!, line) : undefined,
        active: optBool(cmd, "active"),
        filterPropagation: optStr(cmd, "propagation"),
      });
      return;
    }
    case "hierarchy": {
      const h = o.hierarchies.find((x) => x.name === name)!;
      const levels = optList(cmd, "levels");
      const tableOpt = optStr(cmd, "table");
      await mutOverview(s, () =>
        g.upsertHierarchy({
          connectionId: cid,
          originalName: h.name,
          name: h.name,
          table: tableOpt !== undefined && tableOpt !== "" ? requireTable(o, tableOpt, line).name : h.table,
          levels: levels !== undefined ? stringsOf(levels).map((column): HierarchyLevelDto => ({ column })) : h.levels,
        }),
      );
      return;
    }
    case "kpi": {
      const k = o.kpis.find((x) => x.name === name)!;
      const targetValue = optNum(cmd, "targetvalue");
      await mutOverview(s, () =>
        g.upsertKpi({
          connectionId: cid,
          originalName: k.name,
          name: k.name,
          baseMeasure: optStr(cmd, "base") ?? k.baseMeasure,
          targetMeasure: mergeStr(optStr(cmd, "target"), targetValue !== undefined ? null : k.targetMeasure),
          targetConstant: targetValue ?? (optStr(cmd, "target") !== undefined ? null : k.targetConstant),
          statusBands: parseBands(cmd) ?? k.statusBands,
          description: mergeStr(optStr(cmd, "description"), k.description),
        }),
      );
      return;
    }
    case "role": {
      const r = o.securityRoles.find((x) => x.name === name)!;
      const denies = cmd.opts.has("deny") ? optAll(cmd, "deny") : null;
      await mutOverview(s, () =>
        g.upsertRole({
          connectionId: cid,
          originalName: r.name,
          name: r.name,
          filters: parseFilters(cmd, "filter") ?? r.filters,
          deniedTables: denies !== null ? denies.filter((d) => d.kind !== "colref").map((d) => d.text) : r.deniedTables,
          deniedColumns:
            denies !== null ? denies.filter((d) => d.kind === "colref").map((d) => `${d.table}[${d.column}]`) : r.deniedColumns,
        }),
      );
      return;
    }
    case "perspective": {
      const p = o.perspectives.find((x) => x.name === name)!;
      await mutOverview(s, () =>
        g.upsertPerspective({
          connectionId: cid,
          originalName: p.name,
          name: p.name,
          tables: cmd.opts.has("tables") ? stringsOf(optList(cmd, "tables") ?? []) : p.tables,
          columns: cmd.opts.has("columns") ? qualifiedRefs(optList(cmd, "columns") ?? [], line) : p.columns,
          measures: cmd.opts.has("measures") ? stringsOf(optList(cmd, "measures") ?? []) : p.measures,
          description: mergeStr(optStr(cmd, "description"), p.description),
        }),
      );
      return;
    }
    case "calcitem": {
      const t0 = cmd.pos[0] as ValueTok & { kind: "colref" };
      const group = requireOne(o.calculationGroups, (x) => x.name, t0.table ?? "", "calculation group", line);
      const formula = requireExpr(cmd, "set calcitem Group[Item] = <formula>");
      const items = group.items.map((i) => (i.name === name ? { ...i, formula } : i));
      await mutOverview(s, () =>
        g.upsertCalcGroup({
          connectionId: cid,
          originalName: group.name,
          name: group.name,
          items,
          ...selectionCarry(group),
        }),
      );
      return;
    }
    case "calctable": {
      const gv = o.globalVariables.find((x) => x.name === name)!;
      await mutOverview(s, () =>
        g.upsertGlobalVariable({
          connectionId: cid,
          originalName: gv.name,
          name: gv.name,
          table: optStr(cmd, "table") ?? gv.table,
          expression: cmd.expr !== null && cmd.expr !== "" ? cmd.expr : gv.expression,
          dynamic: optBool(cmd, "dynamic") ?? gv.dynamic,
          cascade: optBool(cmd, "cascade") ?? false,
        }),
      );
      return;
    }
    case "tablevar": {
      const v = o.tableVariables.find((x) => x.name === name)!;
      await mutOverview(s, () =>
        g.upsertTableVariable({
          connectionId: cid,
          originalName: v.name,
          name: v.name,
          source: optStr(cmd, "source") ?? v.source,
          filters: parseFilters(cmd, "filter") ?? v.filters,
        }),
      );
      return;
    }
    case "scriptfunction": {
      const f = o.scriptFunctions.find((x) => x.name === name)!;
      await mutOverview(s, () =>
        g.upsertScriptFunction({
          connectionId: cid,
          originalName: f.name,
          name: f.name,
          params: parseParams(cmd) ?? f.params,
          returnType: optStr(cmd, "returns") ?? f.returnType,
          body: cmd.expr !== null && cmd.expr !== "" ? cmd.expr : f.body,
        }),
      );
      return;
    }
    case "context": {
      const c = o.contexts.find((x) => x.name === name)!;
      await mutOverview(s, () =>
        g.upsertContext({
          connectionId: cid,
          originalName: c.name,
          name: c.name,
          operations: parseContextOps(cmd) ?? c.operations,
        }),
      );
      return;
    }
    case "writeback": {
      const w = o.writebackColumns.find((x) => x.name === name)!;
      const keys = optList(cmd, "keys");
      const type = optStr(cmd, "type");
      await mutOverview(s, () =>
        g.upsertWritebackColumn({
          connectionId: cid,
          originalId: w.id,
          name: optStr(cmd, "name") ?? w.name,
          table: w.table,
          dataType: type !== undefined && type !== "" ? dataType(type, line) : w.dataType,
          keyColumns: keys !== undefined ? stringsOf(keys) : w.keyColumns,
          kind: optStr(cmd, "kind") ?? w.kind,
          projectionMode: optStr(cmd, "projection") ?? w.projectionMode,
          projectionExpression: mergeStr(optStr(cmd, "projexpr"), w.projectionExpression),
          required: optBool(cmd, "required") ?? w.required,
          min: cmd.opts.has("min") ? (optNum(cmd, "min") ?? null) : w.min,
          max: cmd.opts.has("max") ? (optNum(cmd, "max") ?? null) : w.max,
          enumValues: cmd.opts.has("enum") ? stringsOf(optList(cmd, "enum") ?? []) : w.enumValues,
          maxLength: cmd.opts.has("maxlength") ? (optNum(cmd, "maxlength") ?? null) : w.maxLength,
          pattern: mergeStr(optStr(cmd, "pattern"), w.pattern),
          allowedEditors: cmd.opts.has("editors") ? stringsOf(optList(cmd, "editors") ?? []) : w.allowedEditors,
          exposeHistory: optBool(cmd, "history") ?? w.exposeHistory,
        }),
      );
      return;
    }
    case "source": {
      const src = o.sources.find((x) => sourceLabel(x) === name)!;
      await mutOverview(s, () =>
        g.upsertSource({
          connectionId: cid,
          id: src.id,
          kind: optStr(cmd, "kind") ?? src.kind,
          host: mergeStr(optStr(cmd, "host"), src.host || null),
          port: cmd.opts.has("port") ? (optNum(cmd, "port") ?? null) : src.port,
          database: mergeStr(optStr(cmd, "database"), src.database || null),
          defaultSchema: mergeStr(optStr(cmd, "schema"), src.defaultSchema),
          sslMode: mergeStr(optStr(cmd, "ssl"), src.sslMode),
          trustServerCertificate: optBool(cmd, "trustcert") ?? false,
          preferredAuth: optStr(cmd, "auth") ?? src.preferredAuth,
          displayName: mergeStr(optStr(cmd, "name"), src.displayName),
        }),
      );
      return;
    }
    default:
      fail(`'set' does not support '${cmd.kind ?? "?"}' (try 'help set')`, cmd.line);
  }
}

function nullIfEmpty(list: string[]): string[] | null {
  return list.length === 0 ? null : list;
}

function splitQualified(name: string): [string, string] {
  const m = /^(.*)\[(.*)\]$/.exec(name);
  return m ? [m[1], m[2]] : [name, ""];
}

async function setModel(cmd: Command, s: CliSession, io: CliIo): Promise<void> {
  const g = s.gateway;
  const o = s.overview;
  const cid = s.connectionId;
  const meta = ["name", "version", "author", "description"].some((k) => cmd.opts.has(k));
  if (meta) {
    await mutOverview(s, () =>
      g.setMetadata({
        connectionId: cid,
        name: mergeStr(optStr(cmd, "name"), o.modelName),
        version: mergeStr(optStr(cmd, "version"), o.modelVersion),
        author: mergeStr(optStr(cmd, "author"), o.modelAuthor),
        description: mergeStr(optStr(cmd, "description"), o.modelDescription),
      }),
    );
  }
  const dateTable = optStr(cmd, "datetable");
  if (dateTable !== undefined) {
    const table = dateTable === "" || dateTable.toLowerCase() === "none" ? null : requireTable(o, dateTable, cmd.line).name;
    await mutOverview(s, () => g.setDateTable(cid, table));
  }
  const lookup = optStr(cmd, "lookup");
  if (lookup !== undefined) {
    await mutOverview(s, () => g.setDefaultLookupResolution(cid, lookup === "" ? null : lookup));
  }
  if (!meta && dateTable === undefined && lookup === undefined) {
    fail("set model: give name=, version=, author=, description=, datetable= or lookup=", cmd.line);
  }
  io.print("Updated model settings.", "info");
}

/** `set|delete translation <locale> <table|column|measure> <ref> caption=…`. */
async function setTranslation(cmd: Command, s: CliSession, io: CliIo, remove: boolean): Promise<void> {
  const usage = remove
    ? "delete translation <locale> <table|column|measure> <object>"
    : "set translation <locale> <table|column|measure> <object> caption=\"…\" [description=\"…\"]";
  const [localeTok, kindTok, refTok] = cmd.pos;
  if (!localeTok || !kindTok || !refTok) fail(`Usage: ${usage}`, cmd.line);
  const culture = requireOne(s.overview.cultures, (c) => c.locale, localeTok.text, "culture", cmd.line);
  const targetKind = kindTok.text.toLowerCase();
  if (!["table", "column", "measure"].includes(targetKind)) fail(`Usage: ${usage}`, cmd.line);
  const object = refTok.kind === "colref" ? `${refTok.table}[${refTok.column}]` : refTok.text;

  const listKey = (targetKind + "s") as "tables" | "columns" | "measures";
  const nextList = (existing: NameTranslationInfo[]): NameTranslationInfo[] => {
    const rest = existing.filter((e) => e.object !== object);
    if (remove) return rest;
    const prev = existing.find((e) => e.object === object);
    return [
      ...rest,
      {
        object,
        displayName: mergeStr(optStr(cmd, "caption"), prev?.displayName ?? null),
        description: mergeStr(optStr(cmd, "description"), prev?.description ?? null),
      },
    ];
  };

  const next: ModelCultureInfo = {
    locale: culture.locale,
    tables: listKey === "tables" ? nextList(culture.tables) : culture.tables,
    columns: listKey === "columns" ? nextList(culture.columns) : culture.columns,
    measures: listKey === "measures" ? nextList(culture.measures) : culture.measures,
  };
  await mutOverview(s, () =>
    s.gateway.upsertCulture({
      connectionId: s.connectionId,
      originalLocale: culture.locale,
      locale: culture.locale,
      tables: next.tables,
      columns: next.columns,
      measures: next.measures,
    }),
  );
  io.print(`${remove ? "Removed" : "Set"} ${culture.locale} translation for ${object}.`, "info");
}

async function upsertRelationshipCarry(
  s: CliSession,
  r: ModelRelationshipInfo,
  over: Partial<{ name: string; cardinality: string; active: boolean; filterPropagation: string }>,
): Promise<void> {
  await mutOverview(s, () =>
    s.gateway.upsertRelationship({
      connectionId: s.connectionId,
      originalName: r.name,
      name: over.name ?? r.name,
      fromTable: r.fromTable,
      toTable: r.toTable,
      conditions: r.conditions,
      cardinality: over.cardinality ?? r.cardinality,
      active: over.active ?? r.active,
      filterPropagation:
        over.filterPropagation !== undefined && over.filterPropagation !== ""
          ? over.filterPropagation
          : r.filterPropagation,
    }),
  );
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

async function runRename(cmd: Command, s: CliSession, io: CliIo): Promise<void> {
  const g = s.gateway;
  const o = s.overview;
  const cid = s.connectionId;
  const usage = `rename ${cmd.kind ?? "<kind>"} <old> <new>`;
  const oldTok = primary(cmd, usage);
  const newName = noWildcard(secondary(cmd, usage).text, cmd.kind ?? "object", cmd.line);
  const done = (from: string): void => io.print(`Renamed ${from} to ${newName}.`, "info");

  switch (cmd.kind) {
    case "measure": {
      const m = requireOne(o.measures, (x) => x.name, oldTok.text, "measure", cmd.line);
      await mutMeasures(s, () =>
        g.upsertMeasure({
          connectionId: cid,
          originalName: m.name,
          name: newName,
          formula: m.formula,
          description: m.description,
          formatString: m.formatString,
          formatStringExpression: m.formatStringExpression,
          detailRows: m.detailRows,
          group: m.group,
          hidden: null,
        }),
      );
      done(`[${m.name}]`);
      return;
    }
    case "table": {
      // Tables keep their engine name (bindings depend on it) — rename sets
      // the DISPLAY name, exactly like the visual editor.
      const t = requireTable(o, oldTok.text, cmd.line);
      await mutOverview(s, () =>
        g.updateTable({
          connectionId: cid,
          table: t.name,
          displayName: newName,
          description: t.description,
          isHidden: t.isHidden,
        }),
      );
      io.print(`Set display name of ${t.name} to ${newName} (engine names are stable).`, "info");
      return;
    }
    case "column": {
      if (oldTok.kind !== "colref") fail("Usage: rename column Table[Old] [New]", cmd.line);
      const matches = matchColumns(o, oldTok.table ?? "*", oldTok.column ?? "*");
      if (matches.length !== 1) fail(`'${oldTok.text}' must match exactly one column`, cmd.line);
      const { table, column: c } = matches[0] as ColumnMatch;
      if (c.isCalculated || c.isDynamic) {
        await mutOverview(s, () =>
          g.upsertModelColumn({
            connectionId: cid,
            originalName: c.name,
            name: newName,
            table: table.name,
            formula: c.formula ?? "",
            dataType: c.dataType,
            description: null,
          }),
        );
      } else {
        await mutOverview(s, () =>
          g.updateColumn({
            connectionId: cid,
            table: table.name,
            column: c.name,
            displayName: newName,
            description: c.description,
            isHidden: c.isHidden,
            lookupResolution: c.lookupResolution,
            sortByColumn: c.sortByColumn,
            formatString: c.formatString,
          }),
        );
        io.print(`Set display name of ${table.name}[${c.name}] to ${newName} (physical names are stable).`, "info");
        return;
      }
      done(`${table.name}[${c.name}]`);
      return;
    }
    case "relationship": {
      const r = requireOne(o.relationships, (x) => x.name, oldTok.text, "relationship", cmd.line);
      await upsertRelationshipCarry(s, r, { name: newName });
      done(r.name);
      return;
    }
    case "hierarchy": {
      const h = requireOne(o.hierarchies, (x) => x.name, oldTok.text, "hierarchy", cmd.line);
      await mutOverview(s, () =>
        g.upsertHierarchy({ connectionId: cid, originalName: h.name, name: newName, table: h.table, levels: h.levels }),
      );
      done(h.name);
      return;
    }
    case "kpi": {
      const k = requireOne(o.kpis, (x) => x.name, oldTok.text, "KPI", cmd.line);
      await mutOverview(s, () =>
        g.upsertKpi({
          connectionId: cid,
          originalName: k.name,
          name: newName,
          baseMeasure: k.baseMeasure,
          targetMeasure: k.targetMeasure,
          targetConstant: k.targetConstant,
          statusBands: k.statusBands,
          description: k.description,
        }),
      );
      done(k.name);
      return;
    }
    case "role": {
      const r = requireOne(o.securityRoles, (x) => x.name, oldTok.text, "role", cmd.line);
      await mutOverview(s, () =>
        g.upsertRole({
          connectionId: cid,
          originalName: r.name,
          name: newName,
          filters: r.filters,
          deniedTables: r.deniedTables,
          deniedColumns: r.deniedColumns,
        }),
      );
      done(r.name);
      return;
    }
    case "perspective": {
      const p = requireOne(o.perspectives, (x) => x.name, oldTok.text, "perspective", cmd.line);
      await mutOverview(s, () =>
        g.upsertPerspective({
          connectionId: cid,
          originalName: p.name,
          name: newName,
          tables: p.tables,
          columns: p.columns,
          measures: p.measures,
          description: p.description,
        }),
      );
      done(p.name);
      return;
    }
    case "culture": {
      const c = requireOne(o.cultures, (x) => x.locale, oldTok.text, "culture", cmd.line);
      await mutOverview(s, () =>
        g.upsertCulture({
          connectionId: cid,
          originalLocale: c.locale,
          locale: newName,
          tables: c.tables,
          columns: c.columns,
          measures: c.measures,
        }),
      );
      done(c.locale);
      return;
    }
    case "calcgroup": {
      const grp = requireOne(o.calculationGroups, (x) => x.name, oldTok.text, "calculation group", cmd.line);
      await mutOverview(s, () =>
        g.upsertCalcGroup({
          connectionId: cid,
          originalName: grp.name,
          name: newName,
          items: grp.items,
          ...selectionCarry(grp),
        }),
      );
      done(grp.name);
      return;
    }
    case "calcitem": {
      if (oldTok.kind !== "colref") fail("Usage: rename calcitem Group[Old] [New]", cmd.line);
      const grp = requireOne(o.calculationGroups, (x) => x.name, oldTok.table ?? "", "calculation group", cmd.line);
      const item = requireOne(grp.items, (i) => i.name, oldTok.column ?? "", "calc item", cmd.line);
      const items = grp.items.map((i) => (i.name === item.name ? { ...i, name: newName } : i));
      await mutOverview(s, () =>
        g.upsertCalcGroup({
          connectionId: cid,
          originalName: grp.name,
          name: grp.name,
          items,
          ...selectionCarry(grp),
        }),
      );
      done(`${grp.name}[${item.name}]`);
      return;
    }
    case "calctable": {
      const gv = requireOne(o.globalVariables, (x) => x.name, oldTok.text, "calculated table", cmd.line);
      await mutOverview(s, () =>
        g.upsertGlobalVariable({
          connectionId: cid,
          originalName: gv.name,
          name: newName,
          table: gv.table,
          expression: gv.expression,
          dynamic: gv.dynamic,
          cascade: optBool(cmd, "cascade") ?? false,
        }),
      );
      done(gv.name);
      return;
    }
    case "tablevar": {
      const v = requireOne(o.tableVariables, (x) => x.name, oldTok.text, "table variable", cmd.line);
      await mutOverview(s, () =>
        g.upsertTableVariable({ connectionId: cid, originalName: v.name, name: newName, source: v.source, filters: v.filters }),
      );
      done(v.name);
      return;
    }
    case "scriptfunction": {
      const f = requireOne(o.scriptFunctions, (x) => x.name, oldTok.text, "script function", cmd.line);
      await mutOverview(s, () =>
        g.upsertScriptFunction({
          connectionId: cid,
          originalName: f.name,
          name: newName,
          params: f.params,
          returnType: f.returnType,
          body: f.body,
        }),
      );
      done(f.name);
      return;
    }
    case "context": {
      const c = requireOne(o.contexts, (x) => x.name, oldTok.text, "context", cmd.line);
      await mutOverview(s, () =>
        g.upsertContext({ connectionId: cid, originalName: c.name, name: newName, operations: c.operations }),
      );
      done(c.name);
      return;
    }
    case "writeback": {
      const w = requireOne(o.writebackColumns, (x) => x.name, oldTok.text, "writeback column", cmd.line);
      await mutOverview(s, () =>
        g.upsertWritebackColumn({
          connectionId: cid,
          originalId: w.id,
          name: newName,
          table: w.table,
          dataType: w.dataType,
          keyColumns: w.keyColumns,
          kind: w.kind,
          projectionMode: w.projectionMode,
          projectionExpression: w.projectionExpression,
          required: w.required,
          min: w.min,
          max: w.max,
          enumValues: w.enumValues,
          maxLength: w.maxLength,
          pattern: w.pattern,
          allowedEditors: w.allowedEditors,
          exposeHistory: w.exposeHistory,
        }),
      );
      done(w.name);
      return;
    }
    case "source": {
      const src = requireOne(o.sources, sourceLabel, oldTok.text, "source", cmd.line);
      await mutOverview(s, () =>
        g.upsertSource({
          connectionId: cid,
          id: src.id,
          kind: src.kind,
          host: src.host || null,
          port: src.port,
          database: src.database || null,
          defaultSchema: src.defaultSchema,
          sslMode: src.sslMode,
          preferredAuth: src.preferredAuth,
          displayName: newName,
        }),
      );
      done(sourceLabel(src));
      return;
    }
    default:
      fail(`'rename' does not support '${cmd.kind ?? "?"}' (try 'help rename')`, cmd.line);
  }
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function runDelete(cmd: Command, s: CliSession, io: CliIo): Promise<void> {
  const g = s.gateway;
  const cid = s.connectionId;

  if (cmd.kind === "translation") {
    await setTranslation(cmd, s, io, true);
    return;
  }

  const targets = expandNamed(cmd, s) ?? fail(`'delete' does not support '${cmd.kind ?? "?"}'`, cmd.line);

  for (const t of targets) {
    switch (cmd.kind) {
      case "measure":
        await mutMeasures(s, () => g.deleteMeasure(cid, t.name));
        break;
      case "table":
        await mutOverview(s, () => g.deleteTable(cid, t.name));
        break;
      case "column": {
        const [tName, cName] = splitQualified(t.name);
        const table = s.overview.tables.find((x) => x.name === tName);
        const c = table?.columns.find((x) => x.name === cName);
        if (!c) break; // an earlier delete may have removed it (cascades)
        if (c.isDynamic) await mutOverview(s, () => g.deleteContextColumn(cid, c.name));
        else if (c.isCalculated) await mutOverview(s, () => g.deleteCalcColumn(cid, c.name));
        else fail(`${t.name} is a physical column — remove it at the source/import instead`, cmd.line);
        break;
      }
      case "relationship":
        await mutOverview(s, () => g.deleteRelationship(cid, t.name));
        break;
      case "hierarchy":
        await mutOverview(s, () => g.deleteHierarchy(cid, t.name));
        break;
      case "kpi":
        await mutOverview(s, () => g.deleteKpi(cid, t.name));
        break;
      case "role":
        await mutOverview(s, () => g.deleteRole(cid, t.name));
        break;
      case "perspective":
        await mutOverview(s, () => g.deletePerspective(cid, t.name));
        break;
      case "culture":
        await mutOverview(s, () => g.deleteCulture(cid, t.name));
        break;
      case "calcgroup":
        await mutOverview(s, () => g.deleteCalcGroup(cid, t.name));
        break;
      case "calcitem": {
        const t0 = cmd.pos[0] as ValueTok & { kind: "colref" };
        const grp = requireOne(s.overview.calculationGroups, (x) => x.name, t0.table ?? "", "calculation group", cmd.line);
        const items = grp.items.filter((i) => i.name !== t.name);
        // selectionCarry also fixes a former drop here: this site used to
        // omit the selection formats, so deleting an item cleared them.
        await mutOverview(s, () =>
          g.upsertCalcGroup({
            connectionId: cid,
            originalName: grp.name,
            name: grp.name,
            items,
            ...selectionCarry(grp),
          }),
        );
        break;
      }
      case "calctable":
        await mutOverview(s, () => g.deleteGlobalVariable(cid, t.name, optBool(cmd, "cascade") ?? false));
        break;
      case "tablevar":
        await mutOverview(s, () => g.deleteTableVariable(cid, t.name));
        break;
      case "scriptfunction":
        await mutOverview(s, () => g.deleteScriptFunction(cid, t.name));
        break;
      case "context":
        await mutOverview(s, () => g.deleteContext(cid, t.name));
        break;
      case "contextcolumn":
        await mutOverview(s, () => g.deleteContextColumn(cid, t.name));
        break;
      case "writeback": {
        const w = s.overview.writebackColumns.find((x) => x.name === t.name);
        if (w) await mutOverview(s, () => g.deleteWritebackColumn(cid, w.id));
        break;
      }
      case "source": {
        const src = s.overview.sources.find((x) => sourceLabel(x) === t.name);
        if (src) await mutOverview(s, () => g.deleteSource(cid, src.id));
        break;
      }
      case "extdata": {
        await g.extensionDataDelete(cid, t.name);
        s.hadEdits = true;
        s.overviewDirty = true;
        break;
      }
      default:
        fail(`'delete' does not support '${cmd.kind ?? "?"}' (try 'help delete')`, cmd.line);
    }
    io.print(`Deleted ${t.label}.`, "info");
  }
  if (targets.length > 1) io.print(`${plural(targets.length, "object")} deleted.`, "info");
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

async function runImport(cmd: Command, s: CliSession, io: CliIo): Promise<void> {
  const g = s.gateway;
  const cid = s.connectionId;

  if (cmd.kind === "sql") {
    const tableName = primary(cmd, "import sql <TableName> = <SELECT …>").text;
    const sql = requireExpr(cmd, "import sql <TableName> = <SELECT …>");
    await mutOverview(s, () => g.importSqlSource(cid, tableName, sql));
    io.print(`Imported SQL table ${tableName}.`, "info");
    return;
  }
  if (cmd.kind === "table") {
    if (cmd.pos.length === 0) fail("Usage: import tables <schema.table>[, …] [schema=<default>]", cmd.line);
    const defaultSchema = optStr(cmd, "schema") ?? "";
    const tables = cmd.pos.map((t) => {
      const idx = t.text.indexOf(".");
      return idx >= 0
        ? { schema: t.text.slice(0, idx), name: t.text.slice(idx + 1) }
        : { schema: defaultSchema, name: t.text };
    });
    await mutOverview(s, () => g.importTables(cid, tables));
    io.print(`Imported ${plural(tables.length, "table")}.`, "info");
    return;
  }
  fail("Usage: import tables <schema.table,…> | import sql <Name> = <SELECT …>", cmd.line);
}
