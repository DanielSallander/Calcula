//! FILENAME: app/extensions/CubeFormulas/lib/buildFormula.ts
// PURPOSE: Pure builder for CUBE formula strings from a structured spec.
// CONTEXT: Produces Calcula-native CUBE syntax (see app/src-tauri/src/bi/cube.rs):
//   [Measure] for a measure, Table[Column]=Value for a member, Table[Column] for a
//   level. The argument separator is the LOCALE list separator (the dialog passes
//   it from getLocaleSettings) because the result is inserted via update_cell,
//   which delocalizes input. Pure + separator-injected so it is unit-testable.

export type CubeFunc =
  | "CUBEVALUE"
  | "CUBEMEMBER"
  | "CUBESET"
  | "CUBESETCOUNT"
  | "CUBERANKEDMEMBER"
  | "CUBEMEMBERPROPERTY"
  | "CUBEKPIMEMBER";

export interface MemberFilter {
  table: string;
  column: string;
  value: string;
}

export interface CubeFormulaSpec {
  func: CubeFunc;
  connection: string;
  /** Measure name (no brackets) — CUBEVALUE / CUBEMEMBER. */
  measure?: string;
  /** Dimension member filters — CUBEVALUE (tuple) / CUBEMEMBER (single). */
  members?: MemberFilter[];
  /** A level for CUBESET: all members of this column. */
  setTable?: string;
  setColumn?: string;
  /** Optional display caption (CUBEMEMBER/CUBESET/CUBERANKEDMEMBER/CUBEKPIMEMBER). */
  caption?: string;
  /** CUBESET sort: 0 none, 1 asc, 2 desc, 3 alpha-asc, 4 alpha-desc. */
  sortOrder?: number;
  /** CUBESET sort-by measure name (no brackets). */
  sortBy?: string;
  /** A cell reference to a CUBESET cell (CUBERANKEDMEMBER / CUBESETCOUNT). */
  setRef?: string;
  /** Rank (CUBERANKEDMEMBER), 1-based. */
  rank?: number;
  /** Property name (CUBEMEMBERPROPERTY). */
  property?: string;
  /** KPI name (CUBEKPIMEMBER). */
  kpiName?: string;
  /** KPI property: 1=Value, 2=Goal, 3=Status (CUBEKPIMEMBER). */
  kpiProperty?: number;
}

type Arg =
  | { kind: "str"; value: string } // quoted string argument
  | { kind: "num"; value: number } // bare number
  | { kind: "ref"; value: string }; // bare cell reference

/** Wrap a member VALUE in single quotes if it could break member parsing. */
function quoteValue(value: string): string {
  if (/["',;=(){}\[\]\s]/.test(value)) {
    // Single quotes survive inside the outer double-quoted formula argument and
    // are stripped by the backend's unquote().
    return `'${value.replace(/'/g, "")}'`;
  }
  return value;
}

function measureExpr(name: string): string {
  return `[${name}]`;
}

function memberExpr(m: MemberFilter): string {
  return `${m.table}[${m.column}]=${quoteValue(m.value)}`;
}

/** Render a quoted string argument, escaping embedded double-quotes by doubling. */
function quoteArg(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function renderArgs(args: Arg[], sep: string): string {
  return args
    .map((a) => {
      switch (a.kind) {
        case "str":
          return quoteArg(a.value);
        case "num":
          return String(a.value);
        case "ref":
          return a.value;
      }
    })
    .join(sep);
}

/**
 * Build a CUBE formula string (with leading `=`) from a spec, using `sep` as the
 * argument separator. Returns "" when the spec is too incomplete to form a
 * meaningful formula (the caller disables Insert).
 */
export function buildCubeFormula(spec: CubeFormulaSpec, sep: string): string {
  const conn = spec.connection?.trim();
  if (!conn) return "";

  const args: Arg[] = [{ kind: "str", value: conn }];

  switch (spec.func) {
    case "CUBEVALUE": {
      if (spec.measure) args.push({ kind: "str", value: measureExpr(spec.measure) });
      for (const m of spec.members ?? []) {
        if (m.table && m.column && m.value) args.push({ kind: "str", value: memberExpr(m) });
      }
      if (args.length < 2) return "";
      break;
    }
    case "CUBEMEMBER": {
      const m = spec.members?.[0];
      const member =
        m && m.table && m.column && m.value
          ? memberExpr(m)
          : spec.measure
            ? measureExpr(spec.measure)
            : "";
      if (!member) return "";
      args.push({ kind: "str", value: member });
      if (spec.caption) args.push({ kind: "str", value: spec.caption });
      break;
    }
    case "CUBESET": {
      if (!spec.setTable || !spec.setColumn) return "";
      args.push({ kind: "str", value: `${spec.setTable}[${spec.setColumn}]` });
      const hasSort = spec.sortOrder && spec.sortOrder !== 0;
      if (spec.caption || hasSort) {
        args.push({ kind: "str", value: spec.caption ?? "" });
      }
      if (hasSort) {
        args.push({ kind: "num", value: spec.sortOrder as number });
        if ((spec.sortOrder === 1 || spec.sortOrder === 2) && spec.sortBy) {
          args.push({ kind: "str", value: measureExpr(spec.sortBy) });
        }
      }
      break;
    }
    case "CUBESETCOUNT": {
      // No connection argument — only the set reference.
      if (!spec.setRef) return "";
      return `=CUBESETCOUNT(${renderArgs([{ kind: "ref", value: spec.setRef }], sep)})`;
    }
    case "CUBERANKEDMEMBER": {
      if (!spec.setRef || !spec.rank) return "";
      args.push({ kind: "ref", value: spec.setRef });
      args.push({ kind: "num", value: spec.rank });
      if (spec.caption) args.push({ kind: "str", value: spec.caption });
      break;
    }
    case "CUBEMEMBERPROPERTY": {
      const m = spec.members?.[0];
      if (!m || !m.table || !m.column || !m.value || !spec.property) return "";
      args.push({ kind: "str", value: memberExpr(m) });
      args.push({ kind: "str", value: spec.property });
      break;
    }
    case "CUBEKPIMEMBER": {
      if (!spec.kpiName || !spec.kpiProperty) return "";
      args.push({ kind: "str", value: spec.kpiName });
      args.push({ kind: "num", value: spec.kpiProperty });
      if (spec.caption) args.push({ kind: "str", value: spec.caption });
      break;
    }
  }

  return `=${spec.func}(${renderArgs(args, sep)})`;
}
