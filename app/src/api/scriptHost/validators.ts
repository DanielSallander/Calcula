//! FILENAME: app/src/api/scriptHost/validators.ts
// PURPOSE: Static argument validators for broker-mediated script calls.
// CONTEXT: Run BEFORE the tier check (design §5: error messages must not
//          probe policy). Each returns `true` or a human-readable reason.
//          Validators are shape/sanity checks only — they never consult
//          state, so they are safe to run for any caller.

export type Validator = (args: unknown[]) => true | string;

const MAX_STRING = 1_000_000; // 1 MB of text per string argument
const MAX_EVENT_NAME = 256;
const MAX_KEY = 512;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isCellCoord(v: unknown): boolean {
  return isFiniteNumber(v) && v >= 0 && v <= 10_000_000 && Number.isInteger(v);
}

function isBoundedString(v: unknown, max = MAX_STRING): v is string {
  return typeof v === "string" && v.length <= max;
}

export const vNone: Validator = (args) =>
  args.length === 0 || "expected no arguments";

export const vAny: Validator = () => true;

export const vNotify: Validator = ([message, type]) => {
  if (!isBoundedString(message, 2000)) return "message must be a string (max 2000 chars)";
  if (type !== undefined && !["info", "success", "warning", "error"].includes(type as string)) {
    return "type must be info|success|warning|error";
  }
  return true;
};

export const vExpose: Validator = ([name, isPublic]) => {
  // Worker-realm protocol: the handler stays in the worker realm (rt.exposed);
  // only [name, isPublic] cross the RPC boundary (host's base.expose executor
  // reads the same shape). A function can't be structured-cloned, so it is
  // never sent here.
  if (!isBoundedString(name, MAX_KEY) || (name as string).length === 0) {
    return "method name must be a non-empty string";
  }
  if (isPublic !== undefined && typeof isPublic !== "boolean") {
    return "public flag must be a boolean";
  }
  return true;
};

export const vCall: Validator = ([targetType, targetInstanceId, methodName]) => {
  if (!isBoundedString(targetType, MAX_KEY)) return "targetType must be a string";
  if (targetInstanceId !== null && !isBoundedString(targetInstanceId, MAX_KEY)) {
    return "targetInstanceId must be a string or null";
  }
  if (!isBoundedString(methodName, MAX_KEY) || (methodName as string).length === 0) {
    return "methodName must be a non-empty string";
  }
  return true;
};

export const vHook: Validator = ([name]) =>
  isBoundedString(name, MAX_EVENT_NAME) && (name as string).length > 0
    ? true
    : "event name must be a non-empty string";

export const vGetState: Validator = () => true;
/** Cheap broker-side pre-filter for object.setState. Most aspects are validated
 *  by their own store impl; chart spec writes additionally get a shape+size gate
 *  here (runs BEFORE the tier check, no state reads) so an oversized / non-object
 *  spec is rejected uniformly before reaching the extension's schema validator. */
export const vSetState: Validator = ([aspect, aspectArgs]) => {
  if (aspect === "chart.updateSpec" || aspect === "chart.replaceSpec") {
    if (!Array.isArray(aspectArgs) || aspectArgs.length < 1) return "expected a spec argument";
    const spec = aspectArgs[0];
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return "spec must be an object";
    let size = 0;
    try { size = JSON.stringify(spec).length; } catch { return "spec must be JSON-serializable"; }
    if (size > 2_000_000) return "spec too large (max 2 MB)";
  }
  return true;
};
export const vDecl: Validator = ([decls]) =>
  typeof decls === "object" && decls !== null ? true : "expected a declarations object";

export const vHtml: Validator = ([html]) =>
  isBoundedString(html, 5_000_000) ? true : "html must be a string (max 5 MB)";

export const vCellRef: Validator = ([row, col, sheetIndex]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  if (sheetIndex !== undefined && !isCellCoord(sheetIndex)) {
    return "sheetIndex must be a non-negative integer";
  }
  return true;
};

export const vCellSet: Validator = ([row, col, value, sheetIndex]) => {
  if (!isCellCoord(row)) return "row must be a non-negative integer";
  if (!isCellCoord(col)) return "col must be a non-negative integer";
  if (!isBoundedString(value)) return "value must be a string (max 1 MB)";
  if (sheetIndex !== undefined && !isCellCoord(sheetIndex)) {
    return "sheetIndex must be a non-negative integer";
  }
  return true;
};

export const vBatch: Validator = ([updates]) => {
  if (!Array.isArray(updates)) return "updates must be an array";
  for (const u of updates) {
    if (typeof u !== "object" || u === null) return "each update must be an object";
    const { row, col, value } = u as { row?: unknown; col?: unknown; value?: unknown };
    if (!isCellCoord(row)) return "each update.row must be a non-negative integer";
    if (!isCellCoord(col)) return "each update.col must be a non-negative integer";
    if (!isBoundedString(value)) return "each update.value must be a string (max 1 MB)";
  }
  return true;
};

export const vIndex: Validator = ([index]) =>
  isCellCoord(index) ? true : "index must be a non-negative integer";

export const vEvent: Validator = ([name]) =>
  isBoundedString(name, MAX_EVENT_NAME) && (name as string).length > 0
    ? true
    : "event name must be a non-empty string";

export const vCommand: Validator = ([commandId]) =>
  isBoundedString(commandId, MAX_KEY) && (commandId as string).length > 0
    ? true
    : "commandId must be a non-empty string";

export const vString: Validator = ([s]) =>
  isBoundedString(s) ? true : "expected a string (max 1 MB)";

export const vFetch: Validator = ([url, init]) => {
  if (!isBoundedString(url, 8192)) return "url must be a string (max 8192 chars)";
  try {
    const parsed = new URL(url as string);
    if (parsed.protocol !== "https:") return "only https URLs are allowed";
  } catch {
    return "url must be an absolute https URL";
  }
  if (init !== undefined && (typeof init !== "object" || init === null)) {
    return "init must be an object";
  }
  return true;
};

// Structured, model-scoped BI query (Wave 3 / bi.query). Args: [connectionId,
// { measures, groupBy, filters }]. The script supplies measures/columns/filter
// VALUES, never SQL text — so there is no injection surface; the engine plans
// the (read-only) query against the workbook's BI model. Shapes mirror
// backend.ts BiQueryRequest / BiColumnRef / BiFilter.
const MAX_BI_LIST = 256;

function isBiColumnRef(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as { table?: unknown; column?: unknown };
  return isBoundedString(r.table, MAX_KEY) && isBoundedString(r.column, MAX_KEY);
}

// Raw read-only SQL (Wave 3 / bi.sql, higher-trust). Args: [connectionId, sql].
// Frontend gate: a single SELECT/WITH statement. Rust re-validates read-only
// authoritatively (the connector executes it).
export const vBiSql: Validator = ([connectionId, sql]) => {
  if (!isBoundedString(connectionId, MAX_KEY) || (connectionId as string).length === 0) {
    return "connectionId must be a non-empty string";
  }
  if (!isBoundedString(sql, 100_000)) return "sql must be a string (max 100k chars)";
  const trimmed = (sql as string).trimStart().toLowerCase();
  if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
    return "only read-only queries are allowed (SELECT / WITH)";
  }
  return true;
};

export const vBiQuery: Validator = ([connectionId, request]) => {
  if (!isBoundedString(connectionId, MAX_KEY) || (connectionId as string).length === 0) {
    return "connectionId must be a non-empty string";
  }
  if (typeof request !== "object" || request === null) return "request must be an object";
  const r = request as { measures?: unknown; groupBy?: unknown; filters?: unknown };
  if (!Array.isArray(r.measures) || r.measures.length > MAX_BI_LIST) {
    return `measures must be an array (max ${MAX_BI_LIST})`;
  }
  for (const m of r.measures) {
    if (!isBoundedString(m, MAX_KEY)) return "each measure must be a string";
  }
  if (!Array.isArray(r.groupBy) || r.groupBy.length > MAX_BI_LIST) {
    return `groupBy must be an array (max ${MAX_BI_LIST})`;
  }
  for (const g of r.groupBy) {
    if (!isBiColumnRef(g)) return "each groupBy entry must be { table, column }";
  }
  if (!Array.isArray(r.filters) || r.filters.length > MAX_BI_LIST) {
    return `filters must be an array (max ${MAX_BI_LIST})`;
  }
  for (const f of r.filters) {
    if (typeof f !== "object" || f === null) return "each filter must be an object";
    const ff = f as { column?: unknown; table?: unknown; operator?: unknown; value?: unknown };
    if (
      !isBoundedString(ff.column, MAX_KEY) ||
      !isBoundedString(ff.table, MAX_KEY) ||
      !isBoundedString(ff.operator, MAX_KEY) ||
      !isBoundedString(ff.value, MAX_KEY)
    ) {
      return "each filter must be { column, table, operator, value } of strings";
    }
  }
  return true;
};

export const vCubeValue: Validator = ([connection, members]) => {
  if (!isBoundedString(connection, MAX_KEY) || (connection as string).length === 0) {
    return "connection must be a non-empty string";
  }
  if (!Array.isArray(members) || members.length > MAX_BI_LIST) {
    return `members must be an array (max ${MAX_BI_LIST})`;
  }
  for (const m of members) {
    if (!isBoundedString(m, MAX_KEY)) return "each member must be a string";
  }
  return true;
};

export const vCubeKpi: Validator = ([connection, kpi, property]) => {
  if (!isBoundedString(connection, MAX_KEY) || (connection as string).length === 0) {
    return "connection must be a non-empty string";
  }
  if (!isBoundedString(kpi, MAX_KEY) || (kpi as string).length === 0) {
    return "kpi must be a non-empty string";
  }
  if (typeof property !== "number" || !Number.isInteger(property)) {
    return "property must be an integer (1=Value, 2=Goal, 3=Status)";
  }
  return true;
};

export const vCubeMembers: Validator = ([connection, level]) => {
  if (!isBoundedString(connection, MAX_KEY) || (connection as string).length === 0) {
    return "connection must be a non-empty string";
  }
  if (!isBoundedString(level, MAX_KEY) || (level as string).length === 0) {
    return "level must be a non-empty string (e.g. \"Geo[Country]\")";
  }
  return true;
};

export const vUdf: Validator = ([name, args]) => {
  if (!isBoundedString(name, MAX_KEY) || (name as string).length === 0) {
    return "udf name must be a non-empty string";
  }
  if (!Array.isArray(args)) return "udf args must be an array";
  if (args.length > 255) return "too many udf arguments (max 255)";
  return true;
};

export const vKey: Validator = ([key]) =>
  isBoundedString(key, MAX_KEY) && (key as string).length > 0
    ? true
    : "key must be a non-empty string (max 512 chars)";

export const vKV: Validator = ([key, value]) => {
  if (!isBoundedString(key, MAX_KEY) || (key as string).length === 0) {
    return "key must be a non-empty string (max 512 chars)";
  }
  if (!isBoundedString(value, 262_144)) return "value must be a string (max 256 KB)";
  return true;
};
