//! FILENAME: app/src/api/scriptHost/macroStarter.ts
// PURPOSE: ONE source for the text a NEW macro starts from -- the worked
//          example "adds 1 to every selected cell that holds a number" that
//          Developer > New Macro, the Macros dialog's New Macro button and the
//          Object Script Editor's welcome panel all create -- plus the two
//          naming rules the Macro Recorder's codegen already applied and the
//          starter must apply identically: `toIdentifier` (a macro's JavaScript
//          name) and `macroNeedsCellAccessMessage` (what a module macro throws
//          when it is run without cell access).
// CONTEXT: 2026-10-22, the owner's complaint: "If I go to Developer, where
//          should I write a macro that adds 1 to a cell? The Object Script
//          Editor is just empty." The answer is a working example, and it is
//          built here rather than in either extension because BOTH windows
//          reach it (the editor window has no extension host) and the Facade
//          Rule forbids MacroRecorder and ScriptableObjects importing each
//          other. The recorder re-exports the two helpers from here, so a
//          recorded macro and a written one print byte-identical text from one
//          source.
//
//          ZERO IMPORTS, for the reason scriptTemplate.ts states: this leaf is
//          reached from the eager `api/index.ts` barrel, and a template must
//          not pull the ~94 KB generated script surface forward.
//
//          THE TEMPLATE'S SHAPE IS LOAD-BEARING. Exactly two top-level
//          functions, one of them `setup`, so Run (F5) in the editor has ONE
//          run target from any cursor line; `setup` returns the work's promise
//          in the direct branch (the mount resolves when the macro is done) and
//          registers a click handler on a button; no `@capability`, no
//          `import` / `export`, no bytes; `api.getSelection` is its only call
//          outside the explicit-run grant (explicitRunGrant.ts), and the
//          header the user reads says so. macroStarter.test.ts pins each of
//          these, macroStarterBehaviour.test.ts runs the generated code against
//          a recording API, and macroStarterTypings.test.ts proves it carries
//          zero diagnostics under the editor's `checkJs`.

/** The name the first New Macro gets when nothing is taken: Excel's `MacroN`. */
export const MACRO_STARTER_DEFAULT_NAME = "Macro1";

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A safe JavaScript identifier derived from a macro name.
 * "Monthly close 2026" -> "monthlyClose2026"; unusable input -> `fallback`.
 */
export function toIdentifier(name: string, fallback = "recordedMacro"): string {
  const words = name
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return fallback;
  const joined =
    words[0].toLowerCase() +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("");
  const candidate = /^[0-9]/.test(joined) ? "_" + joined : joined;
  return IDENT_RE.test(candidate) ? candidate : fallback;
}

/**
 * What a recorded object-script macro throws when it is run without cell
 * access (`context.api` is null): a run another script started, or a
 * restricted standing mount. Names the ways that DO give it cell access --
 * exactly the doors that mint a run pass (owner decision B) -- and says that
 * nothing changed, which is true because the guard runs before the first call.
 * Exported so tests pin the generated text against one source.
 */
export function macroNeedsCellAccessMessage(name: string): string {
  return (
    `"${name}" did not run: it needs cell access, and this run has none. Run it yourself ` +
    "-- from Developer > Macros > Run, a button that runs it, or the command line; a run " +
    "another script starts never gets cell access. Nothing was changed."
  );
}

/**
 * The name of the starter's work function for a macro called `name`: the one
 * identifier rule (`toIdentifier`), with the one name it must never produce
 * excluded -- a work function called `setup` would BE the entry point, and the
 * template would then declare `setup` twice.
 */
export function macroStarterFunctionName(name: string): string {
  const fn = toIdentifier(name, "macro");
  return fn === "setup" ? "setupMacro" : fn;
}

/**
 * The starter module for a macro called `name` (spec: docs/design/open-items.md
 * section 2.ap). Nothing in it runs at creation; it is text.
 *
 * Builder rules, each of which keeps a hostile or merely odd name from breaking
 * the file: the function name goes through `macroStarterFunctionName`; every
 * occurrence of the name inside a STRING LITERAL goes through `JSON.stringify`
 * (so a quote in the name is escaped, not a syntax error); the name inside a
 * `//` comment has every line break replaced by a space (so it cannot end the
 * comment and start a statement).
 */
export function buildMacroStarterSource(name: string): string {
  const fn = macroStarterFunctionName(name);
  // EVERY JavaScript line terminator, not only CR/LF: U+2028 and U+2029 end a
  // `//` comment too, so a name carrying one would start a statement of its
  // own on the next "line" -- in a file that later runs unlocked.
  const commentName = name.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");
  const retryMessage = JSON.stringify("Select the cells to change, then run " + name + " again.");
  const batchName = JSON.stringify(name);
  const changedPrefix = JSON.stringify(name + ": changed ");
  const noAccessMessage = JSON.stringify(macroNeedsCellAccessMessage(name));

  const lines: string[] = [
    "// " + commentName + " -- adds 1 to every selected cell that holds a number.",
    "//",
    "// RUN IT",
    "//   * Run (F5) in this window: runs once on the cells selected in the workbook.",
    '//   * Developer > Macros... > "' + commentName + '" > Run (object script).',
    "//   * Developer > Macros... > Add Button: a button on the sheet runs it on every click.",
    "//   * Type  run " + commentName + "  in the command line (View > Command Line, Ctrl+Shift+P).",
    "//",
    "// CHANGE IT",
    "//   * The work is in " + fn + "() below. The line marked CHANGE ME is what happens to each number.",
    "//   * `api` is the open workbook. Type `api.` to see everything it can do:",
    "//     api.getSelection(), api.getRangeValues(...), api.updateCellsBatch(...),",
    "//     api.setCellValue(...), api.setRangeFormat(...),",
    '//     (await api.workbook.sheet("Sheet1")).range("A1:B5"), ...',
    "//   * Everything between beginBatch and commitBatch is ONE step in Undo (Ctrl+Z in the workbook).",
    '//   * This file is saved as you type (the "Live" chip above). There is no Save button.',
    "//   * Rename it in Developer > Macros... (Name, then Save).",
    "//",
    "// PUBLISHING IT",
    "//   * api.getSelection is yours to use here, but it is outside the cell access an",
    "//     application's macro gets when someone runs it, so a copy of this macro shipped",
    "//     in an application is refused before it runs. A macro you mean to publish should",
    "//     work on a named range instead of the selection.",
    "",
    "/** @param {UnlockedAPI} api */",
    "async function " + fn + "(api) {",
    "  const AMOUNT = 1; // CHANGE ME: what is added to each number (use -1 to subtract)",
    "",
    "  // Which cells are selected? Coordinates only; null when nothing is selected.",
    "  const selection = await api.getSelection();",
    "  if (!selection) {",
    "    throw new Error(" + retryMessage + ");",
    "  }",
    "",
    "  await api.beginBatch(" + batchName + "); // from here on, one undo step",
    "  const updates = [];",
    "  try {",
    "    // A selection can have several areas (Ctrl+click). Visit each one.",
    "    for (const area of selection.areas) {",
    "      // One read per area (up to 100 000 cells; select the cells you mean, not a",
    '      // whole column), WITH each cell\'s type -- so the number 5 and the text "5"',
    "      // are told apart, and a formula is never overwritten by its result.",
    "      const rows = await api.getRangeValues(",
    "        area.startRow, area.startCol, area.endRow, area.endCol, selection.sheetIndex,",
    "      );",
    "      for (let r = 0; r < rows.length; r++) {",
    "        for (let c = 0; c < rows[r].length; c++) {",
    "          const cell = rows[r][c];",
    "          // Only a plain number. Text, empty cells, errors and formulas are left alone",
    "          // (a formula HIDDEN by sheet protection reads as its value here, so unhide it first).",
    '          if (cell.type !== "number" || cell.formula) continue;',
    "          updates.push({",
    "            row: area.startRow + r,",
    "            col: area.startCol + c,",
    '            // Written as a NUMBER (not "2" in quotes), so it stays a number',
    "            // whatever the decimal separator of your language setting is.",
    "            value: Number(cell.value) + AMOUNT,",
    "          });",
    "        }",
    "      }",
    "    }",
    "    // ONE write for all the cells. The selection is always on the sheet you are",
    "    // looking at, which is where updateCellsBatch writes.",
    "    if (updates.length > 0) await api.updateCellsBatch(updates);",
    "  } finally {",
    "    // commitBatch in `finally`, not cancelBatch in `catch`: whatever was written is",
    "    // one undo step even if something failed half-way, so one Ctrl+Z takes it back.",
    "    // (cancelBatch keeps the writes and DROPS the undo record.)",
    "    await api.commitBatch();",
    "  }",
    "  return updates.length;",
    "}",
    "",
    "// Entry point. Calcula calls setup() when this macro is started:",
    "//   * on a BUTTON  -> the macro runs on every click",
    "//   * run directly (Developer > Macros... > Run, the command line) -> it runs once, now",
    "// Run (F5) in this window starts " + fn + "() above directly, so nothing here runs twice.",
    "// You normally do not change anything below this line.",
    "/** @param {BaseObjectContext & { onClick?: (handler: () => void) => void }} context */",
    "function setup(context) {",
    "  if (!context.api) {",
    "    throw new Error(" + noAccessMessage + ");",
    "  }",
    "  const report = (n) => context.notify(" + changedPrefix + ' + n + " cell(s).", "success");',
    '  if (typeof context.onClick === "function") {',
    "    context.onClick(async () => {",
    "      try {",
    "        report(await " + fn + "(context.api));",
    "      } catch (e) {",
    '        context.notify(String(e && e.message ? e.message : e), "error");',
    "      }",
    "    });",
    "    return;",
    "  }",
    "  // Returned, not fired-and-forgotten: the mount resolves only after this",
    '  // promise settles, so "the macro finished" is something the caller knows.',
    "  return " + fn + "(context.api).then((n) => {",
    "    report(n);",
    "    return n;",
    "  });",
    "}",
  ];
  return lines.join("\n") + "\n";
}
