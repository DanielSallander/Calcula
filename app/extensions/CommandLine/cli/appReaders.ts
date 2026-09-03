// FILENAME: app/extensions/CommandLine/cli/appReaders.ts
// PURPOSE: The app CLI's inspection commands: `ls <kind> [pattern]` over the
//          session caches (refreshed first, best-effort) and `show` for one
//          sheet / name / gridtable / pivot / macro / command, plus
//          `show range A1:B9`, which reads cell VALUES through the typed
//          read API (capped at 50 rows with an explicit truncation note).

import { CliError } from "../../_shared/cli/lex";
import type { GenericCommand } from "../../_shared/cli/parse";
import { filterNames, matchNamed } from "../../_shared/cli/glob";
import { detailBlock, textTable, yesNo } from "../../_shared/cli/format";
import type { CliIo } from "../../_shared/cli/registry";
import type { TypedCellData } from "@api/lib";
import { formatRange, indexToColLetter, tryParseQualified } from "./a1";
import { macroOriginLabel } from "./macroProvenance";
import type { AppCliSession } from "./appSession";
import { sheetNameOf } from "./appSession";

/** Longest `show range` output before truncation. */
const MAX_SHOW_ROWS = 50;

function fail(msg: string, line: number): never {
  throw new CliError(msg, line);
}

export async function runAppRead(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {
  await s.refresh(); // best-effort: a failed read keeps the previous cache
  if (cmd.verb === "ls") {
    await runLs(cmd, s, io);
    return;
  }
  await runShow(cmd, s, io);
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

function printTable(io: CliIo, headers: string[], rows: string[][], emptyMsg: string): void {
  if (rows.length === 0) io.print(emptyMsg, "info");
  else io.print(textTable(headers, rows));
}

async function runLs(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {
  const pat = cmd.pos[0]?.text ?? "*";

  switch (cmd.kind) {
    case null: {
      // Bare `ls`: workbook summary.
      io.print(
        detailBlock([
          ["sheets", String(s.sheets.length)],
          ["active sheet", sheetNameOf(s, s.activeSheetIndex)],
          ["named ranges", String(s.names.length)],
          ["grid tables", String(s.tables.length)],
          ["pivot tables", String(s.pivots.length)],
          ["macros", String(s.macros.length)],
          ["commands", String(listCommandsSafe(s).length)],
        ]),
      );
      return;
    }
    case "sheet": {
      const rows = matchNamed(s.sheets, (sh) => sh.name, pat).map((sh) => [
        String(sh.index),
        sh.name,
        sh.visibility,
        sh.tabColor ?? "",
        sh.index === s.activeSheetIndex ? "yes" : "",
      ]);
      printTable(io, ["#", "sheet", "visibility", "tab", "active"], rows, `No sheets match '${pat}'`);
      return;
    }
    case "name": {
      const rows = matchNamed(s.names, (n) => n.name, pat).map((n) => [
        n.name,
        n.sheetIndex === null ? "workbook" : sheetNameOf(s, n.sheetIndex),
        n.refersTo,
      ]);
      printTable(io, ["name", "scope", "refers to"], rows, `No names match '${pat}'`);
      return;
    }
    case "gridtable": {
      const rows = matchNamed(s.tables, (t) => t.name, pat).map((t) => [
        t.name,
        sheetNameOf(s, t.sheetIndex),
        formatRange(t),
        String(t.columns.length),
      ]);
      printTable(io, ["table", "sheet", "range", "cols"], rows, `No grid tables match '${pat}'`);
      return;
    }
    case "pivot": {
      const rows = matchNamed(s.pivots, (p) => p.name, pat).map((p) => [
        p.name,
        p.sourceRange,
        p.destination,
      ]);
      printTable(io, ["pivot", "source", "destination"], rows, `No pivot tables match '${pat}'`);
      return;
    }
    case "macro": {
      // The `from` column is not decoration. A module that arrived inside a
      // distributed application was listed here identically to the user's own
      // code; `macroOriginLabel` derives the answer from the record's own
      // `sourcePackage` and says "(unreadable)" rather than "local" when the
      // record could not be read at all.
      const rows = matchNamed(s.macros, (m) => m.name, pat).map((m) => [
        m.name,
        m.id,
        macroOriginLabel(m),
      ]);
      printTable(io, ["macro", "id", "from"], rows, `No macros match '${pat}'`);
      return;
    }
    case "command": {
      const ids = filterNames(pat === "*" ? null : pat, listCommandsSafe(s));
      printTable(io, ["command"], ids.map((id) => [id]), `No commands match '${pat}'`);
      return;
    }
    default:
      fail("'ls' lists sheets, names, gridtables, pivots, macros or commands", cmd.line);
  }
}

function listCommandsSafe(s: AppCliSession): string[] {
  try {
    return s.gateway.listCommands();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function primaryName(cmd: GenericCommand, usage: string): string {
  const t = cmd.pos[0];
  if (!t) fail(`Usage: ${usage}`, cmd.line);
  return t.text;
}

function findByName<T>(items: T[], nameOf: (item: T) => string, name: string): T | undefined {
  const lower = name.toLowerCase();
  return items.find((it) => nameOf(it).toLowerCase() === lower);
}

async function runShow(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {
  switch (cmd.kind) {
    case "sheet": {
      const name = primaryName(cmd, "show sheet <name>");
      const sheet = findByName(s.sheets, (sh) => sh.name, name);
      if (!sheet) fail(`No sheet named '${name}'`, cmd.line);
      let used = "(unknown)";
      try {
        const ur = await s.gateway.getUsedRange(sheet.index);
        used = ur.empty ? "(empty)" : formatRange(ur);
      } catch {
        // keep "(unknown)"
      }
      io.print(
        detailBlock([
          ["sheet", sheet.name],
          ["index", String(sheet.index)],
          ["visibility", sheet.visibility],
          ["tab color", sheet.tabColor ?? ""],
          ["active", yesNo(sheet.index === s.activeSheetIndex)],
          ["used range", used],
        ]),
      );
      return;
    }
    case "name": {
      const name = primaryName(cmd, "show name <name>");
      const named = findByName(s.names, (n) => n.name, name);
      if (!named) fail(`No named range '${name}'`, cmd.line);
      let resolved = "";
      try {
        const c = await s.gateway.resolveNamedRangeCoords(named.name);
        resolved = `${sheetNameOf(s, c.sheetIndex)}!${formatRange(c)}`;
      } catch {
        resolved = "(not a range)";
      }
      io.print(
        detailBlock([
          ["name", named.name],
          ["scope", named.sheetIndex === null ? "workbook" : sheetNameOf(s, named.sheetIndex)],
          ["refers to", named.refersTo],
          ["resolves to", resolved],
          ["comment", named.comment ?? ""],
        ]),
      );
      return;
    }
    case "cell":
    case "range": {
      await showRange(cmd, s, io);
      return;
    }
    case "gridtable": {
      const name = primaryName(cmd, "show gridtable <name>");
      const table = findByName(s.tables, (t) => t.name, name);
      if (!table) fail(`No grid table named '${name}'`, cmd.line);
      io.print(
        detailBlock([
          ["table", table.name],
          ["sheet", sheetNameOf(s, table.sheetIndex)],
          ["range", formatRange(table)],
          ["columns", table.columns.map((c) => c.name).join(", ")],
          ["style", table.styleName],
        ]),
      );
      return;
    }
    case "pivot": {
      const name = primaryName(cmd, "show pivot <name>");
      const pivot = findByName(s.pivots, (p) => p.name, name);
      if (!pivot) fail(`No pivot table named '${name}'`, cmd.line);
      io.print(
        detailBlock([
          ["pivot", pivot.name],
          ["source", pivot.sourceRange],
          ["destination", pivot.destination],
          ["refresh on open", yesNo(pivot.refreshOnOpen)],
        ]),
      );
      return;
    }
    case "macro": {
      const name = primaryName(cmd, "show macro <name>");
      const macro =
        findByName(s.macros, (m) => m.name, name) ?? findByName(s.macros, (m) => m.id, name);
      if (!macro) fail(`No macro named '${name}'`, cmd.line);
      const scope =
        macro.scope === undefined
          ? ""
          : macro.scope.type === "sheet"
            ? `sheet ${macro.scope.name}`
            : "workbook";
      io.print(
        detailBlock([
          ["macro", macro.name],
          ["id", macro.id],
          ["scope", scope],
          ["from", macroOriginLabel(macro)],
          // Only present when the record could not be read — detailBlock drops
          // empty values, so a healthy macro shows no such row.
          ["read error", macro.loadError ?? ""],
        ]),
      );
      return;
    }
    case "command": {
      const id = primaryName(cmd, "show command <id>");
      io.print(
        detailBlock([
          ["command", id],
          ["registered", yesNo(s.gateway.hasCommand(id))],
        ]),
      );
      return;
    }
    default:
      fail("show what? e.g. 'show sheet Sheet1', 'show name Total' or 'show range A1:B9'", cmd.line);
  }
}

/** Read and print cell values for a range (active sheet unless qualified). */
async function showRange(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {
  const targetText = mergedRefText(cmd);
  if (!targetText) fail("Usage: show range A1:B9  (or show range Sheet2!A1:B9)", cmd.line);
  const q = tryParseQualified(targetText);
  if (!q) fail(`'${targetText}' is not a range (expected e.g. A1:B9)`, cmd.line);

  let sheetIndex: number | undefined;
  if (q.sheet !== undefined) {
    const target = q.sheet;
    const sheet = findByName(s.sheets, (sh) => sh.name, target);
    if (!sheet) fail(`No sheet named '${target}'`, cmd.line);
    sheetIndex = sheet.index;
  }

  const r = q.range;
  const totalRows = r.endRow - r.startRow + 1;
  const lastRow = Math.min(r.endRow, r.startRow + MAX_SHOW_ROWS - 1);
  const cells = await s.gateway.getRangeCellsTyped(r.startRow, r.startCol, lastRow, r.endCol, sheetIndex);

  if (cells.length === 0) {
    io.print("(no values in range)", "info");
    return;
  }

  const byPos = new Map<string, TypedCellData>();
  for (const c of cells) byPos.set(`${c.row}:${c.col}`, c);

  const headers = [""];
  for (let col = r.startCol; col <= r.endCol; col++) headers.push(indexToColLetter(col));
  const rows: string[][] = [];
  for (let row = r.startRow; row <= lastRow; row++) {
    const line = [String(row + 1)];
    for (let col = r.startCol; col <= r.endCol; col++) {
      line.push(byPos.get(`${row}:${col}`)?.display ?? "");
    }
    rows.push(line);
  }
  io.print(textTable(headers, rows));
  if (r.endRow > lastRow) {
    io.print(`…truncated at ${MAX_SHOW_ROWS} rows (${totalRows} in range)`, "info");
  }
}

/** The A1-style target text, re-joining the lexer's split of
 *  `'My Sheet'!A1` into [string "My Sheet", word "!A1"]. */
function mergedRefText(cmd: GenericCommand): string | null {
  const t = cmd.pos[0];
  if (!t) return null;
  const next = cmd.pos[1];
  if (t.kind === "string" && next && next.kind === "word" && next.text.startsWith("!")) {
    return `'${t.text.replace(/'/g, "''")}'${next.text}`;
  }
  return t.text;
}
