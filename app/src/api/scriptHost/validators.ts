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

export const vExpose: Validator = ([name, fn, options]) => {
  if (!isBoundedString(name, MAX_KEY) || (name as string).length === 0) {
    return "method name must be a non-empty string";
  }
  if (typeof fn !== "function") return "handler must be a function";
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    return "options must be an object";
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
export const vSetState: Validator = () => true;
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

export const vSql: Validator = ([sql]) => {
  if (!isBoundedString(sql, 100_000)) return "sql must be a string (max 100k chars)";
  const trimmed = (sql as string).trimStart().toLowerCase();
  if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
    return "only read-only queries are allowed (SELECT / WITH)";
  }
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
