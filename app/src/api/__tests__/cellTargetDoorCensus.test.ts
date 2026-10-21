//! FILENAME: app/src/api/__tests__/cellTargetDoorCensus.test.ts
// PURPOSE: The census of cell DOORS against the cell-target seam (P3, owner
//          finding G3: floating grids take every Home command).
// CONTEXT: A door that acts on cells either REFUSES while an object owns the
//          selection (`refuseIfSelectionOwned`, the BUG-0185 guard) or ACTS on
//          the owner's cells (`resolveCellTarget` + a wrapper's `{ target }`).
//          Four checks keep the two kinds honest as the package migrates the
//          Home doors wave by wave:
//
//   1. Every non-test file that still asks the REFUSE-only question is listed
//      in NO_TARGET with the reason it keeps refusing ("not a Home command",
//      or the step that migrates it). A new refusing door must say why; a
//      migrated one must leave the list (stale entries fail too).
//   2. Every file in TARGET asks `resolveCellTarget(`, and every call it makes
//      to a target-taking wrapper passes an argument containing `target` --
//      a door that resolved an object and then wrote without it would write
//      the ACTIVE sheet at the object's coordinates (BUG-0185 again). A file
//      in TARGET_PASSERS is handed a target its caller resolved (or routes
//      through a door that resolves one): it never asks the refuse-only
//      question, and every wrapper call it makes passes `target` too.
//   3. Rust -> TS, both directions: every command in TARGET_COMMANDS takes a
//      `CellTargetRef` (as `target`, or a params struct's `target` field), and
//      every `#[tauri::command]` that takes one is listed. The wrappers fail
//      closed on that list, so a list that claims more than Rust accepts is
//      the one way a target could still be silently ignored.
//   4. No extension reads `backingSheetIndex` except the floating grid's own
//      extent / store / cache-staleness code: cells are addressed by target,
//      never by a backing sheet index.
//
// Each check runs over the real tree AND over an inline fixture that must fail
// (the positive controls), so a scanner that matches nothing cannot pass.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { TARGET_COMMANDS } from "../cellTargetCommands";

const APP = path.resolve(__dirname, "../../..");
const RUST_ROOT = path.join(APP, "src-tauri", "src");

// ============================================================================
// The lists
// ============================================================================

const NOT_HOME = "not a Home command (keeps refusing on a floating grid's cells; non-goal 1.4)";
const S9 = "Home formatting door: migrates in S9";

/** Files that still ask the refuse-only question, and why. Keys are app-relative. */
const NO_TARGET: Record<string, string> = {
  // ---- Migrated in S9, keeping one refusing door ----
  "src/core/hooks/useGridKeyboard.ts":
    "the format keys, Ctrl+Alt+V and Delete resolve a target (TARGET); Ctrl+; / Ctrl+Shift+:, F11 and Space keep refusing (Core's own cell paths, Insert tab, cell types)",
  // ---- Migrated in S11, keeping one refusing door ----
  "extensions/BuiltIn/StandardMenus/selectionDoors.ts":
    "Go To Special resolves a target (TARGET); Insert > Table keeps refusing (an Insert-tab door, and a floating grid holds no table)",
  // ---- Not Home commands: they keep refusing ----
  "extensions/AdvancedFilter/index.ts": NOT_HOME,
  "extensions/BuiltIn/CellBookmarks/lib/bookmarkAtSelection.ts": NOT_HOME,
  "extensions/BuiltIn/StandardMenus/ViewMenu.ts": `${NOT_HOME}: View > Split Window`,
  "extensions/BusinessIntelligence/components/BiPane.tsx": `${NOT_HOME}: BI insert`,
  "extensions/BusinessIntelligence/lib/modelPivot.ts": `${NOT_HOME}: BI insert`,
  "extensions/CellTypes/index.ts": NOT_HOME,
  "extensions/Collaboration/lib/designateWritebackRegion.ts": `${NOT_HOME}: Writeback region`,
  "extensions/Consolidate/handlers/dataMenuBuilder.ts": NOT_HOME,
  "extensions/Controls/lib/insertAnchor.ts": `${NOT_HOME}: an objectInsert door (Insert tab)`,
  "extensions/DataForm/handlers/dataMenuBuilder.ts": NOT_HOME,
  "extensions/DataTables/handlers/dataMenuBuilder.ts": `${NOT_HOME}: What-If`,
  "extensions/DataValidation/handlers/dataMenuBuilder.ts": NOT_HOME,
  "extensions/DataValidation/handlers/keyboardHandler.ts": NOT_HOME,
  "extensions/DefinedNames/handlers/formulasMenuItemBuilder.ts": `${NOT_HOME}: Define Name`,
  "extensions/FormulaAssist/index.ts": NOT_HOME,
  "extensions/GoalSeek/handlers/dataMenuBuilder.ts": NOT_HOME,
  "extensions/Grouping/lib/groupSelection.ts": `${NOT_HOME}: Data > Group`,
  "extensions/Hyperlinks/index.ts": NOT_HOME,
  "extensions/Print/index.ts": NOT_HOME,
  "extensions/Protection/handlers/reviewMenuBuilder.ts": `${NOT_HOME}: Review tab`,
  "extensions/RemoveDuplicates/handlers/dataMenuBuilder.ts": NOT_HOME,
  "extensions/Reports/index.ts": NOT_HOME,
  "extensions/Review/handlers/keyboardHandler.ts": `${NOT_HOME}: Comments / Notes`,
  "extensions/Review/handlers/reviewMenuBuilder.ts": `${NOT_HOME}: Comments / Notes`,
  "extensions/ScriptNotebook/components/CellOutput.tsx": `${NOT_HOME}: Send to Grid`,
  "extensions/ScriptableObjects/lib/cellBehaviorUx.ts": `${NOT_HOME}: Cell Behaviors`,
  "extensions/SelectVisibleCells/index.ts": `${NOT_HOME}: a Quick Access command`,
  "extensions/Solver/handlers/dataMenuBuilder.ts": NOT_HOME,
  "extensions/Sparklines/components/SparklineDesignSections.tsx": NOT_HOME,
  "extensions/Sparklines/index.ts": NOT_HOME,
  "extensions/Subtotals/handlers/dataMenuBuilder.ts": NOT_HOME,
  "extensions/Table/components/TableDesignTab.tsx": `${NOT_HOME}: Table Design > Resize Table`,
  "extensions/TextToColumns/handlers/dataMenuBuilder.ts": NOT_HOME,
  "extensions/Tracing/handlers/formulasMenuBuilder.ts": NOT_HOME,
  "src/core/components/Spreadsheet/useSpreadsheetEditing.ts":
    `${NOT_HOME}: Core's type-to-edit; a floating grid's cell takes typing in its OWN editor (receivesTyping)`,
  "src/shell/FormulaBar/FormulaInput.tsx": `${NOT_HOME}: the formula bar edits through the external-edit session`,
  "src/shell/FormulaBar/NameBox.tsx": `${NOT_HOME}: Define Name from the Name Box`,
};

/** Files whose doors act on a target (`resolveCellTarget`). Grows in S9/S10/S11. */
const TARGET: readonly string[] = [
  "src/core/lib/gridCommands.ts",
  // ---- S9: Home formatting doors ----
  "extensions/BuiltIn/HomeTab/components/useHomeTabState.ts",
  "extensions/BuiltIn/HomeTab/components/alignment/numberGroupCommands.ts",
  "extensions/BuiltIn/HomeTab/components/alignment/orientationMenu.ts",
  "extensions/BuiltIn/HomeTab/components/font/borders.ts",
  "src/shell/Overlays/MiniFormatToolbar/MiniFormatToolbar.tsx",
  "extensions/BuiltIn/FormatCellsDialog/index.ts",
  "extensions/BuiltIn/FormatCellsDialog/FormatCellsDialog.tsx",
  "extensions/BuiltIn/StandardMenus/FormatMenu.ts",
  "extensions/Protection/handlers/protectionCommands.ts",
  "src/core/hooks/useGridKeyboard.ts",
  // ---- S10: grid-command, clipboard and painter doors ----
  "extensions/BuiltIn/InsertDeleteCells/lib/cellShift.ts",
  "extensions/BuiltIn/PasteSpecial/index.ts",
  "extensions/BuiltIn/PasteSpecial/pasteSpecialExecute.ts",
  "extensions/BuiltIn/FormatPainter/formatPainterLogic.ts",
  "src/shell/registries/gridFormatCommands.ts",
  // ---- S11: editing, find, CF and the permanent refusals ----
  "extensions/AutoSum/lib/autoSumCommand.ts",
  "src/shell/FormulaBar/insertFunctionHost.tsx",
  "extensions/FillSeries/index.ts",
  "extensions/FlashFill/index.ts",
  "extensions/Sorting/lib/quickSort.ts",
  "extensions/BuiltIn/FindReplaceDialog/FindReplaceDialog.tsx",
  "extensions/GoToSpecial/lib/selectSpecialCells.ts",
  "extensions/BuiltIn/StandardMenus/selectionDoors.ts",
  "extensions/ConditionalFormatting/handlers/homeMenuBuilder.ts",
  // Format as Table and Filter ask capabilities no owner admits ("table",
  // "filter"): on a floating grid's cells they refuse with the owner's
  // sentence naming why (spec 1.3).
  "extensions/Table/handlers/formatAsTable.ts",
  "extensions/AutoFilter/lib/filterStore.ts",
  // ---- S8: the floating grid's own Delete door ----
  // Delete / Backspace on its cells is Clear Contents: ONE clear through the
  // grid's cell target (one undo step), asked like every Clear door.
  "extensions/FloatingRange/index.ts",
];

/**
 * Files handed a target their caller resolved, or routing through a door that
 * resolves one. They must never ask the refuse-only question, and every
 * wrapper call they make must pass `target` (a write that dropped it would
 * land on the active sheet).
 */
const TARGET_PASSERS: Record<string, string> = {
  "extensions/BuiltIn/FormatCellsDialog/lib/formatCellsWrites.ts":
    "executes Format Cells' plan over the rectangle and target the dialog resolved",
  "extensions/BuiltIn/FormatCellsDialog/tabs/BorderTab.tsx":
    "previews the range shape the dialog seeded from its target; any direct write must carry it",
  "extensions/BuiltIn/HomeTab/components/styles/CellStylesButton.tsx":
    "applies through the Home tab's applyFormat door, which resolves the target",
  "extensions/BuiltIn/HomeTab/components/styles/RegisteredStylesHero.tsx":
    "opens the menus the CF / Table extensions register; their doors resolve (S11)",
  "extensions/BuiltIn/InsertDeleteCells/index.ts":
    "Insert / Delete Cells: asks lib/cellShift's door (resolveShiftPlace / runChoice), which resolves the target",
  "extensions/BuiltIn/PasteSpecial/PasteSpecialDialog.tsx":
    "is opened by the PASTE_SPECIAL door with the target it resolved, and hands it to the executor",
  // ---- S11 ----
  "extensions/FillSeries/lib/runSeries.ts":
    "the Series dialog's OK: re-asks the target SILENTLY (cellTargetFor) because the selection can move while the dialog is open; the fill.series door resolved it out loud",
  "extensions/AutoSum/lib/liveReader.ts":
    "the planner's readers: the object's cells through @api/cellTarget for the target AutoSum resolved",
  "extensions/Sorting/components/SortDialog.tsx":
    "is opened by Custom Sort with the object's target (decideSortTarget resolved it) and sorts with it",
  "extensions/Sorting/lib/sortHelpers.ts": "reads header names and colours through the dialog's target",
  "extensions/ConditionalFormatting/lib/ruleWrites.ts":
    "adds and clears rules with the target the CF menu door resolved",
  "extensions/ConditionalFormatting/components/QuickCFDialog.tsx":
    "is opened by the CF menu door with the target it resolved, and writes through ruleWrites with it",
  "extensions/ConditionalFormatting/components/NewRuleDialog.tsx":
    "is opened by the CF menu door with the target it resolved, and writes through ruleWrites with it",
  "extensions/ConditionalFormatting/components/RulesManagerDialog.tsx":
    "Manage Rules: lists and edits the rules of the scope the door named (a floating grid's target, or the sheet)",
};

/** The seam's own files: they DEFINE the questions. */
const SEAM_FILES = new Set(["src/core/lib/selectionOwner.ts", "src/api/selectionOwner.ts", "src/api/cellTarget.ts"]);

/** The wrappers that take `opts.target` (spec 2.9). */
const TARGET_WRAPPERS = [
  "applyFormatting",
  "adjustNumberFormatDecimals",
  "applyBorderPreset",
  "setCellRichText",
  "applyNamedStyleRange",
  "clearRangeWithOptions",
  "sortRange",
  "fillRange",
  "updateCellsBatch",
  "mergeCells",
  "unmergeCells",
  "insertRows",
  "insertColumns",
  "deleteRows",
  "deleteColumns",
  "setRowHeights",
  "setColumnWidths",
  "setRowsHidden",
  "setColsHidden",
  "goToSpecial",
  "findAll",
  "countMatches",
  "replaceAll",
  "replaceSingle",
  "addConditionalFormat",
  "updateConditionalFormat",
  "deleteConditionalFormat",
  "reorderConditionalFormats",
  "getAllConditionalFormats",
  "clearConditionalFormatsInRange",
];

/** The only extension files that may read `backingSheetIndex`, and why. */
const BACKING_INDEX_READERS: Record<string, string> = {
  "extensions/FloatingRange/lib/frExtent.ts": "the used-range read that sizes the scrollable content extent",
  "extensions/FloatingRange/lib/floatingRangeStore.ts": "the entry store mirrors the backend row",
  "extensions/FloatingRange/index.ts":
    "the CELL_VALUES_CHANGED cache-staleness listener compares a change's sheet to the entry's backing sheet; it never addresses a write",
};

// ============================================================================
// Scanners (pure, so the positive controls run them on fixtures)
// ============================================================================

/** Strip // line comments and block comments (strings are left alone; good enough for a census). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** Whether `src` (comments stripped) asks the refuse-only question. */
function asksRefusal(src: string): boolean {
  return /\b(?:refuseIfSelectionOwned|selectionRefusalFor)\s*\(/.test(stripComments(src));
}

/** Whether `src` asks the cell-target question. */
function asksTarget(src: string): boolean {
  return /\bresolveCellTarget\s*\(/.test(stripComments(src));
}

/** The text between the parentheses of the call whose "(" is at `open`. */
function balancedArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/** Every call to a target wrapper in `src` whose arguments never mention `target`. */
function untargetedWrapperCalls(src: string): string[] {
  const code = stripComments(src);
  const bad: string[] = [];
  for (const name of TARGET_WRAPPERS) {
    const re = new RegExp(`(^|[^\\w$])(function\\s+)?${name}\\s*(<[^>()]*>)?\\s*\\(`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      if (m[2]) continue; // a definition, not a call
      const open = code.indexOf("(", m.index + m[1].length + name.length);
      const args = balancedArgs(code, open);
      if (!/\btarget\b/.test(args)) bad.push(`${name}(${args.slice(0, 60)})`);
    }
  }
  return bad;
}

/** Every `#[tauri::command]` fn in `sources` (path -> text): name and signature text. */
function tauriCommands(sources: Map<string, string>): { name: string; signature: string }[] {
  const out: { name: string; signature: string }[] = [];
  for (const text of sources.values()) {
    const re = /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*pub\s+(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const open = m.index + m[0].length - 1;
      out.push({ name: m[1], signature: balancedArgs(text, open) });
    }
  }
  return out;
}

/** Every struct body in `sources`, by name. */
function structBodies(sources: Map<string, string>): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const text of sources.values()) {
    const re = /pub(?:\([^)]*\))?\s+struct\s+(\w+)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let end = text.length;
      for (let i = open; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      bodies.set(m[1], (bodies.get(m[1]) ?? "") + text.slice(open + 1, end));
    }
  }
  return bodies;
}

const TARGET_FIELD = /\btarget\s*:\s*(?:Option<\s*)?(?:[\w:]*::)?CellTargetRef\b/;

/**
 * The Rust side of check 3: which commands ACCEPT a target (`target:` typed
 * `CellTargetRef` / `Option<CellTargetRef>`, directly or as a field of a params
 * struct the command takes), and which merely MENTION the type (any parameter
 * or params-struct field of it, by any name). Both are compared with the list.
 */
function rustTargetCommands(sources: Map<string, string>): { accepts: Set<string>; mentions: Set<string> } {
  const bodies = structBodies(sources);
  const accepts = new Set<string>();
  const mentions = new Set<string>();
  for (const { name, signature } of tauriCommands(sources)) {
    const sig = stripComments(signature);
    let accepted = TARGET_FIELD.test(sig);
    let mentioned = /\bCellTargetRef\b/.test(sig);
    for (const tm of sig.matchAll(/:\s*(?:[\w]+::)*([A-Z]\w*)\b/g)) {
      const body = bodies.get(tm[1]);
      if (!body) continue;
      const clean = stripComments(body);
      if (TARGET_FIELD.test(clean)) accepted = true;
      if (/\bCellTargetRef\b/.test(clean)) mentioned = true;
    }
    if (accepted) accepts.add(name);
    if (mentioned) mentions.add(name);
  }
  return { accepts, mentions };
}

/** The drift between a Rust scan and a TS list (empty when they agree both ways). */
function targetListDrift(scan: { accepts: Set<string>; mentions: Set<string> }, list: readonly string[]): string[] {
  const drift: string[] = [];
  for (const name of list) {
    if (!scan.accepts.has(name)) drift.push(`TARGET_COMMANDS lists ${name}, whose Rust signature takes no target: CellTargetRef`);
  }
  for (const name of scan.mentions) {
    if (!list.includes(name)) drift.push(`${name} takes a CellTargetRef but is not in TARGET_COMMANDS`);
  }
  return drift;
}

// ============================================================================
// Tree reading
// ============================================================================

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}

const isSourceFile = (f: string): boolean =>
  /\.(ts|tsx)$/.test(f) &&
  !/\.d\.ts$/.test(f) &&
  !/[\\/]__tests__[\\/]/.test(f) &&
  !/\.(test|spec)\.(ts|tsx)$/.test(f);

const rel = (abs: string): string => path.relative(APP, abs).split(path.sep).join("/");

function tsSources(): Map<string, string> {
  const files = [...walk(path.join(APP, "src"), isSourceFile), ...walk(path.join(APP, "extensions"), isSourceFile)];
  return new Map(files.map((f) => [rel(f), fs.readFileSync(f, "utf8")]));
}

function rustSources(): Map<string, string> {
  return new Map(walk(RUST_ROOT, (f) => f.endsWith(".rs")).map((f) => [f, fs.readFileSync(f, "utf8")]));
}

const TS = tsSources();

// ============================================================================
// The checks
// ============================================================================

describe("check 1: every refuse-only door is in NO_TARGET, with its reason", () => {
  it("the set of files asking refuseIfSelectionOwned / selectionRefusalFor equals NO_TARGET", () => {
    const callers = [...TS.entries()]
      .filter(([file, src]) => !SEAM_FILES.has(file) && asksRefusal(src))
      .map(([file]) => file)
      .sort();
    expect(callers.length, "the scanner found no refusing door at all: it is broken").toBeGreaterThan(10);
    const unlisted = callers.filter((f) => !(f in NO_TARGET));
    const stale = Object.keys(NO_TARGET).filter((f) => !callers.includes(f));
    expect(unlisted, "a door refuses on an object's cells without saying why (add it to NO_TARGET, or resolve a target)").toEqual([]);
    expect(stale, "NO_TARGET lists files that no longer refuse (move them to TARGET or drop them)").toEqual([]);
    for (const [file, reason] of Object.entries(NO_TARGET)) expect(reason.length, `${file} has no reason`).toBeGreaterThan(10);
  });

  it("positive control: a refusing door the list does not know is caught, and a comment is not a call", () => {
    expect(asksRefusal(`if (refuseIfSelectionOwned("Bold")) return;`)).toBe(true);
    expect(asksRefusal(`const s = selectionRefusalFor ("Define Name");`)).toBe(true);
    expect(asksRefusal(`// refuseIfSelectionOwned("Bold") used to be here`)).toBe(false);
    expect(asksRefusal(`/* refuseIfSelectionOwned("Bold") */ doIt();`)).toBe(false);
  });
});

describe("check 2: every TARGET door asks resolveCellTarget and passes its target to every wrapper", () => {
  for (const file of TARGET) {
    it(`${file}`, () => {
      const src = TS.get(file);
      expect(src, `${file} does not exist`).toBeDefined();
      expect(asksTarget(src!), `${file} is in TARGET but never asks resolveCellTarget(`).toBe(true);
      expect(untargetedWrapperCalls(src!), `${file} calls a target wrapper without a target`).toEqual([]);
    });
  }

  it("TARGET and the seam files do not overlap, and every TARGET entry is unique", () => {
    expect(new Set(TARGET).size).toBe(TARGET.length);
    for (const f of TARGET) expect(SEAM_FILES.has(f)).toBe(false);
    for (const f of TARGET) expect(f in TARGET_PASSERS, `${f} is in TARGET and TARGET_PASSERS`).toBe(false);
  });

  for (const [file, reason] of Object.entries(TARGET_PASSERS)) {
    it(`passer ${file}`, () => {
      const src = TS.get(file);
      expect(src, `${file} does not exist`).toBeDefined();
      expect(reason.length, `${file} has no reason`).toBeGreaterThan(10);
      expect(asksRefusal(src!), `${file} is handed a target but asks the refuse-only question`).toBe(false);
      expect(untargetedWrapperCalls(src!), `${file} calls a target wrapper without a target`).toEqual([]);
    });
  }

  it("positive control: a resolved door that writes WITHOUT its target is caught; one that passes it is not", () => {
    const bad = `
      const t = resolveCellTarget("Bold", "format");
      if (!t) return;
      await applyFormatting(rows, cols, { bold: true });
    `;
    const good = `
      const t = resolveCellTarget("Bold", "format");
      if (!t) return;
      await applyFormatting(rows, cols, { bold: true }, { target: targetRefOf(t) });
      await backend.sortRange<R>(0, 0, 3, 1, fields, undefined, { target: ref });
    `;
    const definition = `export async function applyFormatting(rows: number[], cols: number[]) { return 1; }`;
    expect(asksTarget(bad)).toBe(true);
    expect(untargetedWrapperCalls(bad)).toHaveLength(1);
    expect(untargetedWrapperCalls(good)).toEqual([]);
    expect(untargetedWrapperCalls(definition), "a definition was read as a call").toEqual([]);
    expect(asksTarget(`// resolveCellTarget("Bold", "format")`)).toBe(false);
  });
});

describe("check 3: TARGET_COMMANDS agrees with the Rust signatures, both ways", () => {
  it("the real list against the real app crate", () => {
    const sources = rustSources();
    expect(sources.size, "no Rust sources were read: the check proves nothing").toBeGreaterThan(50);
    const scan = rustTargetCommands(sources);
    expect(targetListDrift(scan, TARGET_COMMANDS)).toEqual([]);
  });

  it("the scanner sees real tauri commands and their params structs (it is not blind)", () => {
    const sources = rustSources();
    const names = new Set(tauriCommands(sources).map((c) => c.name));
    for (const cmd of ["apply_formatting", "clear_range_with_options", "insert_rows", "set_rows_hidden"]) {
      expect(names.has(cmd), `the scanner missed #[tauri::command] ${cmd}`).toBe(true);
    }
    expect(structBodies(sources).get("ClearRangeParams"), "the scanner missed ClearRangeParams").toMatch(/start_row/);
  });

  it("positive control: a targeted command missing from the list fails; listed, it passes; a list entry Rust lacks fails", () => {
    const fixture = new Map([
      [
        "fixture.rs",
        `
        #[tauri::command]
        pub fn get_cell_target_cells(state: State<AppState>, target: CellTargetRef, start_row: u32) -> Result<(), String> { Ok(()) }

        #[tauri::command]
        pub fn clear_range_with_options(state: State<AppState>, params: ClearRangeParams) -> Result<(), String> { Ok(()) }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct ClearRangeParams {
            pub start_row: u32,
            #[serde(default)]
            pub target: Option<crate::api_types::CellTargetRef>,
        }

        #[tauri::command]
        pub fn apply_formatting(state: State<AppState>, params: FormattingParams, sheet_indices: Option<Vec<usize>>) -> Result<(), String> { Ok(()) }
        `,
      ],
    ]);
    const scan = rustTargetCommands(fixture);
    expect([...scan.accepts].sort()).toEqual(["clear_range_with_options", "get_cell_target_cells"]);
    expect(targetListDrift(scan, []).length, "an empty list must fail against targeted commands").toBe(2);
    expect(targetListDrift(scan, ["get_cell_target_cells", "clear_range_with_options"])).toEqual([]);
    expect(
      targetListDrift(scan, ["get_cell_target_cells", "clear_range_with_options", "apply_formatting"]),
      "a list entry whose Rust takes no target must fail (the wrapper would send a target Tauri drops)",
    ).toHaveLength(1);
  });
});

describe("check 4: no extension addresses cells by backingSheetIndex", () => {
  it("only the floating grid's own extent / store / staleness code reads it", () => {
    const readers = [...TS.entries()]
      .filter(([file, src]) => file.startsWith("extensions/") && /\bbackingSheetIndex\b/.test(stripComments(src)))
      .map(([file]) => file)
      .sort();
    const unexpected = readers.filter((f) => !(f in BACKING_INDEX_READERS));
    expect(unexpected, "an extension reads backingSheetIndex: address cells by target instead").toEqual([]);
    expect(readers.length, "the scanner found no reader at all: it is broken").toBeGreaterThan(0);
  });

  it("positive control: a fixture door reading backingSheetIndex is caught", () => {
    const fixture = `const idx = entry.backingSheetIndex; await clearRangeWithOptions(0, 0, 1, 1, "all", idx);`;
    expect(/\bbackingSheetIndex\b/.test(stripComments(fixture))).toBe(true);
    expect(/\bbackingSheetIndex\b/.test(stripComments(`// entry.backingSheetIndex`))).toBe(false);
  });
});
