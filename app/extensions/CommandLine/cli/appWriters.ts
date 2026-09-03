// FILENAME: app/extensions/CommandLine/cli/appWriters.ts
// PURPOSE: The app CLI's write commands (set cell / sheet + name CRUD /
//          delete range / sort) plus the run-like verbs whose previews are
//          null (goto / run / command / recalc). One analyzer builds a typed
//          action from a GenericCommand and is shared by previewAppWrite and
//          runAppWrite, so the confirm card and the execution can never
//          disagree about what a command does.
// CONTEXT: Sheet targets are RE-RESOLVED through the gateway at execution
//          time (never the session cache) and refuse wildcards outright.
//          Option schemas are strict: an unknown key= is a CliError naming
//          the valid keys, enforced in BOTH preview and run.

import { CliError } from "../../_shared/cli/lex";
import { optBool, optStr } from "../../_shared/cli/parse";
import type { GenericCommand } from "../../_shared/cli/parse";
import { isPattern } from "../../_shared/cli/glob";
import { validateOptions } from "../../_shared/cli/optionSchema";
import type { CliOptionSpec, CliOptionTable } from "../../_shared/cli/optionSchema";
import type { CliIo, WritePreview } from "../../_shared/cli/registry";
import type { ClearApplyTo } from "@api/backend";
import type { SheetInfo } from "@api/lib";
import {
  colLetterToIndex,
  formatQualified,
  formatRange,
  indexToColLetter,
  isSingleCell,
  tryParseQualified,
} from "./a1";
import type { RangeRef } from "./a1";
import type { AppCliSession } from "./appSession";
import { macroOriginPhrase, macroProvenanceNotice } from "./macroProvenance";

// ---------------------------------------------------------------------------
// Option schemas (one table per kind + one per kindless verb) — these drive
// strict validation here AND completion/help through the domain's kind specs.
// ---------------------------------------------------------------------------

export const APP_CELL_OPTIONS: CliOptionTable = {
  set: [], // the value/formula is the `= <tail>`, never an option
};

export const APP_SHEET_OPTIONS: CliOptionTable = {
  add: [],
  rename: [],
  delete: [],
  set: [
    {
      key: "visibility",
      type: "enum",
      values: ["visible", "hidden", "veryhidden"],
      help: "show or hide the sheet",
    },
    { key: "tabcolor", type: "string", help: "tab color, e.g. #ff0000" },
  ],
};

export const APP_NAME_OPTIONS: CliOptionTable = {
  add: [],
  rename: [],
  delete: [],
};

export const APP_RANGE_OPTIONS: CliOptionTable = {
  delete: [
    {
      key: "what",
      type: "enum",
      values: ["contents", "formats", "all"],
      help: "what to clear (default contents)",
    },
  ],
};

/** Options for the kindless verbs (validateOptions keys tables by VERB). */
export const APP_KINDLESS_OPTIONS: Record<string, CliOptionSpec[]> = {
  sort: [
    { key: "by", type: "string", help: "column letter (B) or 0-based offset (1)" },
    { key: "order", type: "enum", values: ["asc", "desc"], help: "sort order (default asc)" },
    { key: "headers", type: "boolean", help: "first row is a header row (default false)" },
  ],
  goto: [],
  run: [],
  command: [],
  recalc: [],
};

function optionTableFor(cmd: GenericCommand): CliOptionTable | undefined {
  switch (cmd.kind) {
    case "cell":
      return APP_CELL_OPTIONS;
    case "sheet":
      return APP_SHEET_OPTIONS;
    case "name":
      return APP_NAME_OPTIONS;
    case "range":
      return APP_RANGE_OPTIONS;
    case null:
      return { [cmd.verb]: APP_KINDLESS_OPTIONS[cmd.verb] ?? [] };
    default:
      // Read-only kinds (gridtable, pivot, macro, command): no write options.
      return undefined;
  }
}

/** Strict option validation — called at the top of preview AND run. */
export function validateAppOptions(cmd: GenericCommand): void {
  validateOptions(cmd, optionTableFor(cmd), true);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(msg: string, line: number): never {
  throw new CliError(msg, line);
}

/**
 * The A1-style target text starting at positional `index`, re-joining the
 * lexer's split of `'My Sheet'!A1` into [string "My Sheet", word "!A1"].
 * Returns the merged text and how many tokens it consumed.
 */
function refText(cmd: GenericCommand, index: number): { text: string; consumed: number } | null {
  const t = cmd.pos[index];
  if (!t) return null;
  const next = cmd.pos[index + 1];
  if (t.kind === "string" && next && next.kind === "word" && next.text.startsWith("!")) {
    return { text: `'${t.text.replace(/'/g, "''")}'${next.text}`, consumed: 2 };
  }
  return { text: t.text, consumed: 1 };
}

function noSheetWildcard(name: string, line: number): string {
  if (isPattern(name)) fail("wildcards are not allowed for sheet operations", line);
  return name;
}

function noNameWildcard(name: string, line: number): string {
  if (isPattern(name)) fail("wildcards are not allowed for name operations", line);
  return name;
}

/** rename's two spellings: `old -> new` and `old [to] new`. */
function renamePair(cmd: GenericCommand, usage: string): { oldName: string; newName: string } {
  const oldName = cmd.pos[0]?.text;
  const newName = cmd.arrowPos[0]?.text ?? cmd.pos[1]?.text;
  if (!oldName || !newName) fail(`Usage: ${usage}`, cmd.line);
  return { oldName, newName };
}

// ---------------------------------------------------------------------------
// The analyzed write actions (shared by preview + run)
// ---------------------------------------------------------------------------

type SheetVisibilityChange = "visible" | "hidden" | "veryHidden";

type AppWriteAction =
  | { t: "setCell"; sheet: string | null; row: number; col: number; input: string; refLabel: string }
  | { t: "addSheet"; name: string | null }
  | { t: "renameSheet"; oldName: string; newName: string }
  | { t: "deleteSheet"; name: string }
  | { t: "setSheet"; name: string; visibility: SheetVisibilityChange | null; tabColor: string | null }
  | { t: "addName"; name: string; refersTo: string }
  | { t: "renameName"; oldName: string; newName: string }
  | { t: "deleteName"; name: string }
  | { t: "deleteRange"; sheet: string | null; range: RangeRef; what: ClearApplyTo }
  | { t: "sort"; sheet: string | null; range: RangeRef; sortColumn: number; ascending: boolean; hasHeaders: boolean };

/** Parse + statically validate one command. Returns null for the verbs that
 *  are not WRITES (goto / run / command / recalc) after validating their
 *  shape, so mistakes still surface at PLAN time. Throws CliError. */
function analyzeAppWrite(cmd: GenericCommand): AppWriteAction | null {
  switch (cmd.verb) {
    case "set":
      if (cmd.kind === "cell") return analyzeSetCell(cmd);
      if (cmd.kind === "sheet") return analyzeSetSheet(cmd);
      fail("set what? Try 'set cell A1 = <value>' or 'set sheet <name> visibility=hidden'", cmd.line);
      break;
    case "add":
      if (cmd.kind === "sheet") return analyzeAddSheet(cmd);
      if (cmd.kind === "name") return analyzeAddName(cmd);
      fail("add what? The command line can 'add sheet [Name]' or 'add name <N> = <ref>'", cmd.line);
      break;
    case "rename":
      if (cmd.kind === "sheet") {
        const p = renamePair(cmd, "rename sheet <old> -> <new>");
        return {
          t: "renameSheet",
          oldName: noSheetWildcard(p.oldName, cmd.line),
          newName: noSheetWildcard(p.newName, cmd.line),
        };
      }
      if (cmd.kind === "name") {
        const p = renamePair(cmd, "rename name <old> -> <new>");
        return {
          t: "renameName",
          oldName: noNameWildcard(p.oldName, cmd.line),
          newName: noNameWildcard(p.newName, cmd.line),
        };
      }
      fail("rename what? Try 'rename sheet <old> -> <new>' or 'rename name <old> -> <new>'", cmd.line);
      break;
    case "delete":
      if (cmd.kind === "sheet") {
        const name = cmd.pos[0]?.text;
        if (!name) fail("Usage: delete sheet <name>", cmd.line);
        return { t: "deleteSheet", name: noSheetWildcard(name, cmd.line) };
      }
      if (cmd.kind === "name") {
        const name = cmd.pos[0]?.text;
        if (!name) fail("Usage: delete name <n>", cmd.line);
        return { t: "deleteName", name: noNameWildcard(name, cmd.line) };
      }
      if (cmd.kind === "range") return analyzeDeleteRange(cmd);
      fail("delete what? Try 'delete sheet <name>', 'delete name <n>' or 'delete range A1:B9'", cmd.line);
      break;
    case "sort":
      return analyzeSort(cmd);
    case "goto":
      validateGoto(cmd);
      return null;
    case "run":
      validateRun(cmd);
      return null;
    case "command":
      validateCommand(cmd);
      return null;
    case "recalc":
      return null;
    default:
      fail(`'${cmd.verb}' is not a spreadsheet command (try 'help')`, cmd.line);
  }
}

function analyzeSetCell(cmd: GenericCommand): AppWriteAction {
  const target = refText(cmd, 0);
  if (!target) fail("Usage: set cell A1 = <value or formula>", cmd.line);
  const q = tryParseQualified(target.text);
  if (!q) fail(`'${target.text}' is not a cell reference (expected e.g. B3 or Sheet2!B3)`, cmd.line);
  if (!isSingleCell(q.range)) {
    fail(`set cell takes ONE cell (got the range ${formatRange(q.range)})`, cmd.line);
  }
  if (cmd.expr === null || cmd.expr === "") {
    fail("set cell needs '= <value or formula>'", cmd.line);
  }
  return {
    t: "setCell",
    sheet: q.sheet ?? null,
    row: q.range.startRow,
    col: q.range.startCol,
    input: cmd.expr,
    refLabel: formatQualified(q),
  };
}

function analyzeSetSheet(cmd: GenericCommand): AppWriteAction {
  const name = cmd.pos[0]?.text;
  if (!name) fail("Usage: set sheet <name> visibility=visible|hidden|veryhidden tabcolor=#rrggbb", cmd.line);
  const visRaw = optStr(cmd, "visibility");
  let visibility: SheetVisibilityChange | null = null;
  if (visRaw !== undefined) {
    const v = visRaw.toLowerCase();
    if (v === "visible") visibility = "visible";
    else if (v === "hidden") visibility = "hidden";
    else if (v === "veryhidden") visibility = "veryHidden";
    else fail(`visibility= expects visible, hidden or veryhidden (got '${visRaw}')`, cmd.line);
  }
  const tabColor = optStr(cmd, "tabcolor") ?? null;
  if (visibility === null && tabColor === null) {
    fail("set sheet needs at least one of visibility= or tabcolor=", cmd.line);
  }
  return { t: "setSheet", name: noSheetWildcard(name, cmd.line), visibility, tabColor };
}

function analyzeAddSheet(cmd: GenericCommand): AppWriteAction {
  const name = cmd.pos[0]?.text ?? null;
  if (name !== null) noSheetWildcard(name, cmd.line);
  return { t: "addSheet", name };
}

function analyzeAddName(cmd: GenericCommand): AppWriteAction {
  const name = cmd.pos[0]?.text;
  if (!name) fail("Usage: add name <N> = Sheet1!A1:B9", cmd.line);
  noNameWildcard(name, cmd.line);
  if (cmd.expr === null || cmd.expr === "") {
    fail("add name needs '= <reference>' (e.g. add name Total = Sheet1!A1:B9)", cmd.line);
  }
  const refersTo = cmd.expr.startsWith("=") ? cmd.expr : `=${cmd.expr}`;
  return { t: "addName", name, refersTo };
}

function analyzeDeleteRange(cmd: GenericCommand): AppWriteAction {
  const target = refText(cmd, 0);
  if (!target) fail("Usage: delete range A1:B9 [what=contents|formats|all]", cmd.line);
  const q = tryParseQualified(target.text);
  if (!q) fail(`'${target.text}' is not a range (expected e.g. A1:B9)`, cmd.line);
  const whatRaw = (optStr(cmd, "what") ?? "contents").toLowerCase();
  if (whatRaw !== "contents" && whatRaw !== "formats" && whatRaw !== "all") {
    fail(`what= expects contents, formats or all (got '${whatRaw}')`, cmd.line);
  }
  return { t: "deleteRange", sheet: q.sheet ?? null, range: q.range, what: whatRaw };
}

function analyzeSort(cmd: GenericCommand): AppWriteAction {
  const target = refText(cmd, 0);
  if (!target) fail("Usage: sort <range> by=<col> [order=asc|desc] [headers=true|false]", cmd.line);
  const q = tryParseQualified(target.text);
  if (!q) fail(`'${target.text}' is not a range (expected e.g. A2:C9)`, cmd.line);
  const by = optStr(cmd, "by");
  if (by === undefined || by === "") {
    fail("sort needs by=<column letter or 0-based offset> (e.g. by=B or by=1)", cmd.line);
  }
  // The backing @api sortRangeByColumn takes the ABSOLUTE 0-based column index
  // and converts it to the range-relative sort key itself (key = column -
  // startCol; see app/src/api/backend.ts). So: a column LETTER maps straight
  // to its absolute index; a NUMBER is read as a 0-based offset from the
  // range's first column and re-anchored to absolute here.
  let sortColumn: number;
  if (/^\d+$/.test(by)) {
    sortColumn = q.range.startCol + parseInt(by, 10);
  } else {
    const abs = colLetterToIndex(by);
    if (abs === null) fail(`by= expects a column letter or 0-based offset (got '${by}')`, cmd.line);
    sortColumn = abs;
  }
  if (sortColumn < q.range.startCol || sortColumn > q.range.endCol) {
    fail(`Sort column '${by}' is outside ${formatRange(q.range)}`, cmd.line);
  }
  const order = (optStr(cmd, "order") ?? "asc").toLowerCase();
  if (order !== "asc" && order !== "desc") {
    fail(`order= expects asc or desc (got '${order}')`, cmd.line);
  }
  return {
    t: "sort",
    sheet: q.sheet ?? null,
    range: q.range,
    sortColumn,
    ascending: order === "asc",
    hasHeaders: optBool(cmd, "headers") ?? false,
  };
}

function validateGoto(cmd: GenericCommand): void {
  const target = refText(cmd, 0);
  if (!target) fail("Usage: goto A1 | A1:B9 | Sheet2!A1 | <named range>", cmd.line);
  if (cmd.pos.length > target.consumed) {
    fail("goto takes ONE target (quote a spaced sheet name: 'My Sheet'!A1)", cmd.line);
  }
}

function validateRun(cmd: GenericCommand): void {
  if (cmd.pos.length === 0) fail("Usage: run <macro name or id>", cmd.line);
}

function validateCommand(cmd: GenericCommand): void {
  const id = cmd.pos[0]?.text;
  if (!id) fail("Usage: command <registry-id> [= <json args>]", cmd.line);
  parseCommandArgs(cmd); // JSON mistakes surface at plan time
}

function parseCommandArgs(cmd: GenericCommand): unknown {
  if (cmd.expr === null || cmd.expr === "") return undefined;
  try {
    return JSON.parse(cmd.expr);
  } catch (e) {
    fail(`The command args are not valid JSON: ${e instanceof Error ? e.message : String(e)}`, cmd.line);
  }
}

// ---------------------------------------------------------------------------
// Preview (confirm-card labels)
// ---------------------------------------------------------------------------

function labelOf(action: AppWriteAction): string {
  switch (action.t) {
    case "setCell":
      return `set cell ${action.refLabel}`;
    case "addSheet":
      return action.name ? `add sheet ${action.name}` : "add sheet";
    case "renameSheet":
      return `rename sheet ${action.oldName} -> ${action.newName}`;
    case "deleteSheet":
      return `delete sheet ${action.name}`;
    case "setSheet":
      return `set sheet ${action.name}`;
    case "addName":
      return `add name ${action.name}`;
    case "renameName":
      return `rename name ${action.oldName} -> ${action.newName}`;
    case "deleteName":
      return `delete name ${action.name}`;
    case "deleteRange":
      return `clear ${action.what} in ${formatRange(action.range)}`;
    case "sort":
      return `sort ${formatRange(action.range)} by ${indexToColLetter(action.sortColumn)}`;
  }
}

export function previewAppWrite(cmd: GenericCommand, _session: AppCliSession): WritePreview | null {
  validateAppOptions(cmd);
  const action = analyzeAppWrite(cmd);
  if (action === null) return null; // goto / run / command / recalc: not writes
  return { labels: [labelOf(action)], wildcard: false };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Live re-read of the sheet list, then resolve one sheet by name (ci).
 *  Destructive operations NEVER trust the session cache for this. */
async function requireSheet(s: AppCliSession, name: string, line: number): Promise<SheetInfo> {
  const res = await s.gateway.getSheets();
  s.sheets = res.sheets;
  s.activeSheetIndex = res.activeIndex;
  const match = res.sheets.find((sh) => sh.name.toLowerCase() === name.toLowerCase());
  if (!match) fail(`No sheet named '${name}'`, line);
  return match;
}

/** Cell/range commands target the ACTIVE sheet; a qualified reference
 *  switches to its sheet first (resolved live, by name). */
async function ensureSheetActive(s: AppCliSession, sheetName: string | null, line: number): Promise<void> {
  if (sheetName === null) return;
  const sheet = await requireSheet(s, sheetName, line);
  if (sheet.index !== s.activeSheetIndex) {
    const res = await s.gateway.setActiveSheet(sheet.index);
    s.sheets = res.sheets;
    s.activeSheetIndex = res.activeIndex;
  }
}

function requireOk(res: { success: boolean; error: string | null }, line: number): void {
  if (!res.success) fail(res.error ?? "The operation failed", line);
}

async function refreshNames(s: AppCliSession): Promise<void> {
  try {
    s.names = await s.gateway.getAllNamedRanges();
  } catch {
    // best-effort cache
  }
}

export async function runAppWrite(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {
  validateAppOptions(cmd);
  const action = analyzeAppWrite(cmd);
  if (action === null) {
    await runMisc(cmd, s, io);
    return;
  }

  switch (action.t) {
    case "setCell": {
      await ensureSheetActive(s, action.sheet, cmd.line);
      await s.gateway.updateCell(action.row, action.col, action.input);
      io.print(`${action.refLabel} = ${action.input}`);
      return;
    }
    case "addSheet": {
      const res = await s.gateway.addSheet(action.name ?? undefined);
      s.sheets = res.sheets;
      s.activeSheetIndex = res.activeIndex;
      const created = action.name ?? res.sheets[res.activeIndex]?.name ?? "sheet";
      io.print(`Added sheet '${created}'.`);
      return;
    }
    case "renameSheet": {
      const sheet = await requireSheet(s, action.oldName, cmd.line);
      const res = await s.gateway.renameSheet(sheet.index, action.newName);
      s.sheets = res.sheets;
      s.activeSheetIndex = res.activeIndex;
      io.print(`Renamed sheet '${sheet.name}' to '${action.newName}'.`);
      return;
    }
    case "deleteSheet": {
      const sheet = await requireSheet(s, action.name, cmd.line);
      const res = await s.gateway.deleteSheet(sheet.index);
      s.sheets = res.sheets;
      s.activeSheetIndex = res.activeIndex;
      io.print(`Deleted sheet '${sheet.name}'.`);
      return;
    }
    case "setSheet": {
      const sheet = await requireSheet(s, action.name, cmd.line);
      const changes: string[] = [];
      if (action.visibility === "visible") {
        await s.gateway.unhideSheet(sheet.index);
        changes.push("visibility=visible");
      } else if (action.visibility === "hidden") {
        await s.gateway.hideSheet(sheet.index);
        changes.push("visibility=hidden");
      } else if (action.visibility === "veryHidden") {
        await s.gateway.hideSheet(sheet.index, "veryHidden");
        changes.push("visibility=veryHidden");
      }
      if (action.tabColor !== null) {
        await s.gateway.setTabColor(sheet.index, action.tabColor);
        changes.push(`tabcolor=${action.tabColor}`);
      }
      io.print(`Updated sheet '${sheet.name}' (${changes.join(", ")}).`);
      return;
    }
    case "addName": {
      const res = await s.gateway.createNamedRange(action.name, null, action.refersTo);
      requireOk(res, cmd.line);
      await refreshNames(s);
      io.print(`Added name ${action.name} = ${action.refersTo.replace(/^=/, "")}.`);
      return;
    }
    case "renameName": {
      const res = await s.gateway.renameNamedRange(action.oldName, action.newName);
      requireOk(res, cmd.line);
      await refreshNames(s);
      io.print(`Renamed name '${action.oldName}' to '${action.newName}'.`);
      return;
    }
    case "deleteName": {
      const res = await s.gateway.deleteNamedRange(action.name);
      requireOk(res, cmd.line);
      await refreshNames(s);
      io.print(`Deleted name '${action.name}'.`);
      return;
    }
    case "deleteRange": {
      await ensureSheetActive(s, action.sheet, cmd.line);
      const r = action.range;
      await s.gateway.clearRange(r.startRow, r.startCol, r.endRow, r.endCol, action.what);
      io.print(`Cleared ${action.what} in ${formatRange(r)}.`);
      return;
    }
    case "sort": {
      await ensureSheetActive(s, action.sheet, cmd.line);
      const r = action.range;
      await s.gateway.sortRangeByColumn(
        r.startRow,
        r.startCol,
        r.endRow,
        r.endCol,
        action.sortColumn,
        action.ascending,
        action.hasHeaders,
      );
      io.print(
        `Sorted ${formatRange(r)} by column ${indexToColLetter(action.sortColumn)} ` +
          `(${action.ascending ? "ascending" : "descending"}).`,
      );
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// The run-like verbs (preview null): goto / run / command / recalc
// ---------------------------------------------------------------------------

async function runMisc(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {
  switch (cmd.verb) {
    case "goto":
      await runGoto(cmd, s, io);
      return;
    case "run":
      await runMacro(cmd, s, io);
      return;
    case "command":
      await runCommand(cmd, s, io);
      return;
    case "recalc": {
      const cells = await s.gateway.calculateNow();
      io.print(`Recalculated the workbook — ${cells.length} cell(s) updated.`, "info");
      return;
    }
    default:
      fail(`'${cmd.verb}' is not a spreadsheet command (try 'help')`, cmd.line);
  }
}

async function runGoto(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {
  const target = refText(cmd, 0);
  if (!target) fail("Usage: goto A1 | A1:B9 | Sheet2!A1 | <named range>", cmd.line);

  const q = tryParseQualified(target.text);
  if (q) {
    await ensureSheetActive(s, q.sheet ?? null, cmd.line);
    s.gateway.navigateToRange(q.range.startRow, q.range.startCol, q.range.endRow, q.range.endCol);
    io.print(`Moved to ${formatQualified(q)}.`, "info");
    return;
  }

  // Not A1-parsable: resolve as a NAMED RANGE, live.
  const name = target.text;
  let coords;
  try {
    coords = await s.gateway.resolveNamedRangeCoords(name);
  } catch {
    fail(`'${name}' is not a cell reference or a known named range`, cmd.line);
  }
  if (coords.sheetIndex !== s.activeSheetIndex) {
    const res = await s.gateway.setActiveSheet(coords.sheetIndex);
    s.sheets = res.sheets;
    s.activeSheetIndex = res.activeIndex;
  }
  s.gateway.navigateToRange(coords.startRow, coords.startCol, coords.endRow, coords.endCol);
  io.print(`Moved to ${name} (${formatRange(coords)}).`, "info");
}

async function runMacro(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {
  const query = cmd.pos.map((t) => t.text).join(" ").trim();
  if (query === "") fail("Usage: run <macro name or id>", cmd.line);

  const macros = await s.gateway.listMacros();
  s.macros = macros;
  const lower = query.toLowerCase();
  const match =
    macros.find((m) => m.id === query) ??
    macros.find((m) => m.name.toLowerCase() === lower);
  if (!match) {
    const near = macros
      .filter((m) => m.name.toLowerCase().includes(lower) || m.id.toLowerCase().includes(lower))
      .slice(0, 5)
      .map((m) => m.name);
    fail(
      `No macro named '${query}'${near.length > 0 ? ` — close matches: ${near.join(", ")}` : ""}`,
      cmd.line,
    );
  }
  if (!s.gateway.hasMacroRunProvider()) {
    fail("The Macro Recorder extension is not loaded, so macros cannot run", cmd.line);
  }

  // SAY WHOSE CODE THIS IS, BEFORE IT RUNS. Printed after the resolution gates
  // (so a typo does not warn about a macro the user was not asking for) and
  // before the seam call, because a notice that only appears in the outcome
  // tells the user about the publisher's code once it has already executed.
  // Disclosure only — the consent gate is Rust-side, under the run itself.
  const notice = macroProvenanceNotice(match);
  if (notice) io.print(notice, "info");

  const origin = macroOriginPhrase(match);
  const outcome = await s.gateway.runMacroByRef(match.id);
  switch (outcome.status) {
    case "ran":
      io.print(`Macro '${outcome.name}' ran (${origin}).`, "info");
      return;
    case "notFound":
      fail(`Macro '${query}' no longer exists (id ${outcome.macroId})`, cmd.line);
      break;
    case "failed":
      // The origin travels on the FAILURE too: "somebody else's code just threw
      // in my workbook" is a different fact from "my macro has a bug".
      fail(`Macro '${outcome.name}' (${origin}) failed: ${outcome.message}`, cmd.line);
      break;
  }
}

async function runCommand(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {
  const id = cmd.pos[0]?.text;
  if (!id) fail("Usage: command <registry-id> [= <json args>]", cmd.line);
  const args = parseCommandArgs(cmd);
  if (!s.gateway.hasCommand(id)) {
    fail(`No command registered with id '${id}' (try 'ls commands')`, cmd.line);
  }
  const result = await s.gateway.executeCommand(id, args);
  if (result === undefined) {
    io.print("Done.", "info");
    return;
  }
  let text: string;
  try {
    text = JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    text = String(result);
  }
  io.print(text);
}
