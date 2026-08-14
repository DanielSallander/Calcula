// FILENAME: app/extensions/CommandLine/cli/appHelp.ts
// PURPOSE: `help` output for the app (spreadsheet) CLI domain: a general
//          index plus per-topic detail for each kind and extra verb. Returns
//          null for unknown topics so the engine can offer them to the other
//          registered domains (the model editor's kinds, for instance).

const GENERAL = `Spreadsheet command line — one command per line.

Verbs:
  ls sheets|names|gridtables|pivots|macros|commands [pattern]
  show sheet|name|gridtable|pivot|macro|command <name>
  show range A1:B9              read cell values (first 50 rows)
  set cell A1 = <value|formula> the tail after = is the cell input, verbatim
  add sheet [Name]              rename sheet <old> -> <new>
  delete sheet <name>           set sheet <name> visibility=... tabcolor=...
  add name <N> = Sheet1!A1:B9   rename name <old> -> <new>   delete name <n>
  delete range A1:B9 [what=contents|formats|all]
  sort <range> by=<col> [order=asc|desc] [headers=true|false]
  goto A1 | A1:B9 | Sheet2!A1 | <named range>
  run <macro>                   run a workbook macro by name or id
  command <id> [= <json args>]  execute a registry command
  recalc                        recalculate the whole workbook (F9)
  undo / redo                   grid edit history
  help [topic]   clear          this text / clear the output

Notes:
  "quoted names" for names with spaces; 'My Sheet'!A1 for sheet references.
  A free-standing = starts the value/formula and takes THE REST OF THE LINE.
  Sheet operations never accept * or ? wildcards.
  Multi-write runs are ONE undo step; if a step fails, completed edits are
  KEPT (undo reverts them).
  Full-line comments start with # or //.

'help <kind>' or 'help <verb>' shows details, e.g. 'help cell'.`;

const TOPICS: Record<string, string> = {
  sheet: `Sheets:
  ls sheets [pattern]
  show sheet <name>               (index, visibility, used range)
  add sheet [Name]                (auto-named when no name is given)
  rename sheet <old> -> <new>     (also: rename sheet old new / old to new)
  delete sheet <name>
  set sheet <name> visibility=visible|hidden|veryhidden tabcolor=#rrggbb
  Sheet names are matched case-insensitively and resolved live at run time.
  Wildcards are NOT allowed for sheet operations.`,
  cell: `Cells:
  set cell A1 = 42                writes the literal 42
  set cell A1 = =SUM(B:B)         writes a formula (the tail is verbatim)
  set cell Sheet2!B3 = hello      switches to Sheet2 first, then writes
  show range B3                   reads one cell's value
  The text after the free-standing = is passed to the cell EXACTLY as typed.`,
  range: `Ranges:
  show range A1:B9                read values (first 50 rows, then truncated)
  delete range A1:B9              clear contents (default)
  delete range A1:B9 what=formats clear formatting only
  delete range A1:B9 what=all     clear everything
  sort A2:C9 by=B order=desc headers=true
  A Sheet2!A1:B9 reference switches the active sheet first.`,
  name: `Named ranges:
  ls names [pattern]              show name <name>
  add name Total = Sheet1!A1:B9   (the = reference is required)
  rename name <old> -> <new>
  delete name <n>                 (exact name — no wildcards)`,
  gridtable: `Grid tables (worksheet tables; 'table' is the model's kind):
  ls gridtables [pattern]         (alias: gtable)
  show gridtable <name>           (sheet, range, columns)
  Grid tables are created from the Insert menu, not from the command line.`,
  pivot: `Pivot tables:
  ls pivots [pattern]
  show pivot <name>               (source, destination)
  Pivot tables are created from Insert > PivotTable, not from the command line.`,
  macro: `Macros (workbook module scripts):
  ls macros [pattern]
  show macro <name>
  run <macro name or id>          (resolved by exact id, then by name)`,
  command: `Registry commands:
  ls commands [pattern]
  show command <id>
  command <id>                    execute with no arguments
  command <id> = {"key": "value"} execute with JSON arguments`,
  goto: `goto:
  goto A1            goto A1:B9         select and scroll to a range
  goto Sheet2!A1     goto 'My Sheet'!A1 switch sheet, then select
  goto TotalSales                       jump to a named range
  Navigation only — never a write, never an undo step.`,
  sort: `sort:
  sort A2:C9 by=B                    ascending by column B
  sort A2:C9 by=1 order=desc         by the range's second column (0-based offset)
  sort A2:C10 by=B headers=true      first row stays put
  by= takes a column LETTER (absolute) or a 0-based OFFSET from the range's
  first column; the column must lie inside the range.`,
  run: `run:
  run <macro name or id>   runs a workbook macro through the Macro Recorder.
  Unknown names list close matches. The macro's own edits are undoable the
  same way they would be from a button.`,
  recalc: `recalc:
  recalc                   recalculate the WHOLE workbook (Excel's F9).`,
  ls: `ls:
  ls                       workbook summary
  ls <kind> [pattern]      list sheets/names/gridtables/pivots/macros/commands
  Patterns use * (any run) and ? (one character), case-insensitively.`,
  show: `show:
  show <kind> <name>       full details of one object
  show range A1:B9         read cell values (first 50 rows)`,
  set: `set:
  set cell A1 = <value or formula>
  set sheet <name> visibility=visible|hidden|veryhidden tabcolor=#rrggbb`,
  add: `add:
  add sheet [Name]
  add name <N> = Sheet1!A1:B9`,
  delete: `delete:
  delete sheet <name>      delete name <n>      delete range A1:B9 [what=…]`,
  rename: `rename:
  rename sheet <old> -> <new>      rename name <old> -> <new>
  (also accepted: rename sheet old new / rename sheet old to new)`,
  undo: `undo / redo:
  One grid history step at a time. A multi-write CLI run is ONE step; if a
  step failed mid-run, the completed edits were KEPT — undo reverts them.`,
};
TOPICS.gtable = TOPICS.gridtable;
TOPICS.redo = TOPICS.undo;

/** Help for a topic ([] = the general index). Null = not an app topic. */
export function appHelpText(topic: string[]): string | null {
  if (topic.length === 0) return GENERAL;
  const word = topic[0].toLowerCase();
  if (TOPICS[word]) return TOPICS[word];
  // Regular plurals: "sheets" -> "sheet".
  if (word.endsWith("s") && TOPICS[word.slice(0, -1)]) return TOPICS[word.slice(0, -1)];
  return null;
}
