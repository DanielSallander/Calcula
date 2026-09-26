//! FILENAME: app/src/api/__tests__/api-surface-stability.test.ts
// PURPOSE: Verify public API surface stability — catch accidental breaking changes.

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Warm the module graph ONCE with a generous budget (see the matching note
// in facade-completeness.test.ts): a starved first import under full-suite
// load poisons every later import of the same module in this file.
beforeAll(async () => {
  await import("../index");
}, 120_000);

// ============================================================================
// events.ts exports
// ============================================================================

describe("api/events.ts surface stability", () => {
  it("exports emitAppEvent as a function", async () => {
    const mod = await import("../events");
    expect(typeof mod.emitAppEvent).toBe("function");
  });

  it("exports onAppEvent as a function", async () => {
    const mod = await import("../events");
    expect(typeof mod.onAppEvent).toBe("function");
  });

  it("exports restoreFocusToGrid as a function", async () => {
    const mod = await import("../events");
    expect(typeof mod.restoreFocusToGrid).toBe("function");
  });

  it("exports AppEvents as an object with expected event keys", async () => {
    const mod = await import("../events");
    expect(mod.AppEvents).toBeDefined();
    expect(typeof mod.AppEvents).toBe("object");

    const expectedKeys = [
      "CUT", "COPY", "PASTE",
      "FIND", "REPLACE",
      "FREEZE_CHANGED", "SPLIT_CHANGED",
      "VIEW_MODE_CHANGED", "SHOW_FORMULAS_TOGGLED",
      "SELECTION_CHANGED", "SHEET_CHANGED",
      "DATA_CHANGED", "CELLS_UPDATED", "CELL_VALUES_CHANGED",
      "EDIT_STARTED", "EDIT_ENDED",
      "GRID_REFRESH",
      "CONTEXT_MENU_REQUEST", "CONTEXT_MENU_CLOSE",
      "ROWS_INSERTED", "COLUMNS_INSERTED", "ROWS_DELETED", "COLUMNS_DELETED",
      "NAVIGATE_TO_CELL",
      "NAMED_RANGES_CHANGED",
      "FILL_COMPLETED",
      "ANNOTATIONS_CHANGED",
      "ZOOM_CHANGED", "THEME_CHANGED",
      "BEFORE_SAVE", "AFTER_SAVE", "BEFORE_OPEN", "AFTER_OPEN",
      "DIRTY_STATE_CHANGED",
      "CHART_SELECTION_CHANGED",
    ];

    for (const key of expectedKeys) {
      expect(mod.AppEvents).toHaveProperty(key);
    }
  });

  it("AppEvents values are prefixed with 'app:'", async () => {
    const mod = await import("../events");
    for (const value of Object.values(mod.AppEvents)) {
      expect(value).toMatch(/^app:/);
    }
  });
});

// ============================================================================
// index.ts — the chart seams are reachable from the BARREL
// ============================================================================
// Extensions may import ONLY from `@api`, and every chart seam except these two
// blocks was already re-exported here (chartCues, chartQuickActions,
// chartParams). `chartSelection` and the right-click-target half of `chartData`
// were subpath-only, which reads as "private" to anyone obeying the Facade Rule
// — nothing was blocked, but the seam looked like it was not for them. This
// pins the two blocks so a future edit cannot quietly drop them back out.

describe("api/index.ts chart seam re-exports", () => {
  it("re-exports the chart selection registry", async () => {
    const mod = (await import("../index")) as Record<string, unknown>;
    for (const fn of [
      "chartSelectionDisplayName",
      "publishChartSelection",
      "getChartSelection",
      "onChartSelectionChanged",
      "resetChartSelectionRegistry",
    ]) {
      expect(typeof mod[fn]).toBe("function");
    }
    expect(Array.isArray(mod.CHART_SELECTION_ELEMENT_IDS)).toBe(true);
    expect(mod.EMPTY_CHART_SELECTION).toBeDefined();
  });

  it("re-exports the chart right-click target", async () => {
    const mod = (await import("../index")) as Record<string, unknown>;
    expect(typeof mod.setChartRightClickTarget).toBe("function");
    expect(typeof mod.getChartRightClickTarget).toBe("function");
    expect(Array.isArray(mod.CHART_TARGET_ELEMENTS)).toBe(true);
  });

  it("the barrel's copy IS the module's copy, not a second registry", async () => {
    // A re-export that accidentally became a re-implementation would let a
    // subpath writer and a barrel reader disagree about the current selection.
    const barrel = (await import("../index")) as Record<string, unknown>;
    const direct = await import("../chartSelection");
    expect(barrel.getChartSelection).toBe(direct.getChartSelection);
    expect(barrel.CHART_SELECTION_ELEMENT_IDS).toBe(direct.CHART_SELECTION_ELEMENT_IDS);
    const chartData = await import("../chartData");
    expect(barrel.setChartRightClickTarget).toBe(chartData.setChartRightClickTarget);
    expect(barrel.CHART_TARGET_ELEMENTS).toBe(chartData.CHART_TARGET_ELEMENTS);
  });
});

// ============================================================================
// index.ts — the OBJECT label registry (M8) is reachable from the BARREL
// ============================================================================
// The Name Box's label for a selected slicer / timeline / floating range /
// pivot box / control, and "N objects" for a canvas multi-selection. Written by
// the canvas extension, read by the shell -- so it must be barrel-visible, and
// the barrel's copy must be the module's copy (one registry, not two).

describe("api/index.ts object label re-exports", () => {
  it("re-exports the object label registry", async () => {
    const mod = (await import("../index")) as Record<string, unknown>;
    for (const fn of ["publishObjectLabel", "getObjectLabel", "onObjectLabelChanged", "resetObjectLabelRegistry"]) {
      expect(typeof mod[fn]).toBe("function");
    }
    expect(mod.EMPTY_OBJECT_LABEL).toEqual({ source: null, text: "", count: 0 });
  });

  it("the barrel's copy IS the module's copy", async () => {
    const barrel = (await import("../index")) as Record<string, unknown>;
    const direct = await import("../objectSelectionLabel");
    expect(barrel.publishObjectLabel).toBe(direct.publishObjectLabel);
    expect(barrel.getObjectLabel).toBe(direct.getObjectLabel);
    expect(barrel.onObjectLabelChanged).toBe(direct.onObjectLabelChanged);
  });
});

// ============================================================================
// objectGeometry.ts / objectStacking.ts — the ARRANGE seams (M8) are reachable
// from the BARREL, and the barrel's copy is the module's copy
// ============================================================================
// The canvas's align / distribute / nudge / group drag move objects of every
// family through ONE provider registry and ONE frontend-owned undo transaction;
// a second copy of either (a re-implementation behind the barrel) would let a
// family's persist join a transaction the canvas never commits.

describe("api/index.ts object geometry + stacking re-exports", () => {
  it("re-exports the geometry seam and the undo-transaction helpers", async () => {
    const mod = (await import("../index")) as Record<string, unknown>;
    for (const fn of [
      "registerObjectGeometryProvider",
      "hasObjectGeometryProvider",
      "getObjectGeometryProvider",
      "canMoveObject",
      "canResizeObject",
      "familyCoMovesOwnSelection",
      "previewObjectGeometry",
      "commitObjectGeometry",
      "flushObjectGeometry",
      "resetObjectGeometryProviders",
      "openUndoTransaction",
      "runInUndoTransaction",
      "joinUndoTransaction",
      "isUndoTransactionOpen",
      "registerObjectStackingService",
      "getObjectStackingService",
      "resetObjectStackingService",
    ]) {
      expect(typeof mod[fn]).toBe("function");
    }
  });

  it("the barrel's copy IS the module's copy", async () => {
    const barrel = (await import("../index")) as Record<string, unknown>;
    const geometry = await import("../objectGeometry");
    const stacking = await import("../objectStacking");
    expect(barrel.commitObjectGeometry).toBe(geometry.commitObjectGeometry);
    expect(barrel.registerObjectGeometryProvider).toBe(geometry.registerObjectGeometryProvider);
    expect(barrel.openUndoTransaction).toBe(geometry.openUndoTransaction);
    expect(barrel.runInUndoTransaction).toBe(geometry.runInUndoTransaction);
    expect(barrel.registerObjectStackingService).toBe(stacking.registerObjectStackingService);
    expect(barrel.getObjectStackingService).toBe(stacking.getObjectStackingService);
  });
});

// ============================================================================
// objectSelection.ts — the canvas SELECTION SET (M8) the arrange commands use
// ============================================================================

describe("api/objectSelection.ts selection-set surface", () => {
  it("exports the set API", async () => {
    const mod = (await import("../objectSelection")) as Record<string, unknown>;
    for (const fn of [
      "getSelectedObjectRegions",
      "getSetHeldObjectRegions",
      "getPrimaryObjectRegion",
      "isObjectInSelection",
      "setObjectSelectionSet",
      "addToObjectSelection",
      "removeFromObjectSelection",
      "clearObjectSelection",
      "clearSetHeldObjects",
      "onObjectSelectionChanged",
      "notifyObjectSelectionChanged",
      "noteObjectPress",
      "objectLabelOf",
    ]) {
      expect(typeof mod[fn]).toBe("function");
    }
  });
});

// ============================================================================
// keybindings.ts — the FACADE mirrors the FUNCTION it fronts
// ============================================================================
//
// `IKeybindingsAPI` is what an extension receives as `context.keybindings`; it
// fronts the free function `registerKeybinding`. The two drifted: the function
// grew a `when` applicability predicate (Excel's Ctrl+1 formats CELLS except
// while a chart element is selected, and Delete is the same shape), the facade
// kept its one-argument signature, and Charts only works because it imports the
// free function directly. An extension obeying the Facade Rule could not
// express the same claim at all — and TypeScript would not have told it,
// because a one-parameter arrow is assignable to a two-parameter method
// signature, so an argument passed through the facade is silently dropped and
// the binding fires everywhere.
//
// Runtime cannot see a type, so this reads the SOURCE at test time — the same
// shape as interpreterReachDrift.test.ts reading manifest.rs. The direction is
// fixed: `registerKeybinding` is the source of truth (it is the thing that
// runs), and the facade must mirror its parameter list. The `binding`
// parameter's TYPE is deliberately allowed to differ — the facade takes
// `Omit<KeyBinding, "source">` because the host stamps the attribution — so
// only its NAME is compared; every parameter after it must match exactly.

const KEYBINDINGS_TS = path.resolve(__dirname, "../keybindings.ts");

/**
 * Split a parameter list on top-level commas ONLY.
 *
 * Deliberately depth-aware rather than `split(",")`: `Omit<KeyBinding,
 * "source">` contains a comma, and a naive split reports the facade as taking
 * three parameters named `binding`, `"source">` and `when`. That is exactly the
 * failure mode this repo has already paid for once, in the `generate_handler!`
 * recount that read 789 because four doc comments contained commas.
 */
function splitTopLevel(params: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of params) {
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

/** Everything between the parentheses of `<head>(...)`, brace/angle aware. */
function paramListAfter(src: string, head: string): string {
  const at = src.indexOf(head);
  expect(at, `'${head}' not found in keybindings.ts`).toBeGreaterThan(-1);
  const open = at + head.length - 1;
  expect(src[open], `'${head}' does not end at its own '('`).toBe("(");
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated parameter list for '${head}'`);
}

/** `when?: () => boolean` -> { name: "when", optional: true, type: "() => boolean" } */
function parseParam(text: string): { name: string; optional: boolean; type: string } {
  const colon = text.indexOf(":");
  expect(colon, `parameter '${text}' has no type annotation`).toBeGreaterThan(0);
  const rawName = text.slice(0, colon).trim();
  const optional = rawName.endsWith("?");
  return {
    name: optional ? rawName.slice(0, -1) : rawName,
    optional,
    type: text.slice(colon + 1).trim(),
  };
}

describe("api/keybindings.ts — IKeybindingsAPI mirrors registerKeybinding", () => {
  const src = fs.readFileSync(KEYBINDINGS_TS, "utf8");

  /** The facade's own body, so `register(` cannot match the free function. */
  function facadeBody(): string {
    const start = src.indexOf("export interface IKeybindingsAPI {");
    expect(start, "IKeybindingsAPI is no longer declared in keybindings.ts").toBeGreaterThan(-1);
    const end = src.indexOf("\n}", start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it("the parser reads the two signatures it claims to (self-check)", () => {
    // A drift guard whose parser silently matched nothing would pass forever.
    const fn = splitTopLevel(paramListAfter(src, "export function registerKeybinding("));
    const facade = splitTopLevel(paramListAfter(facadeBody(), "register("));
    // Deliberately NOT a length assertion on the facade: that is the drift the
    // cases below exist to report, and a self-check that fails on the real
    // defect stops being a check on the PARSER.
    expect(fn.length).toBeGreaterThanOrEqual(2);
    expect(facade.length).toBeGreaterThanOrEqual(1);
    expect(parseParam(fn[0]).name).toBe("binding");
    expect(parseParam(facade[0]).name).toBe("binding");
    // The commas inside Omit<KeyBinding, "source"> must NOT have split it.
    expect(parseParam(facade[0]).type).toContain("Omit<KeyBinding");
  });

  it("declares the same parameters, in the same order, with the same names", () => {
    const fn = splitTopLevel(paramListAfter(src, "export function registerKeybinding(")).map(
      parseParam,
    );
    const facade = splitTopLevel(paramListAfter(facadeBody(), "register(")).map(parseParam);

    expect(
      facade.map((p) => p.name),
      "IKeybindingsAPI.register must accept every argument registerKeybinding does — " +
        "an extension reaching the registry through context.keybindings cannot pass " +
        "one that is not declared, and a wrapper that drops it type-checks silently. " +
        "FIX: widen the facade in app/src/api/keybindings.ts AND forward the argument " +
        "in the per-extension wrapper in app/src/shell/registries/ExtensionManager.ts.",
    ).toEqual(fn.map((p) => p.name));
  });

  it("every parameter after `binding` matches the function's type exactly", () => {
    // `binding` is exempt by design: the facade narrows it to
    // Omit<KeyBinding, "source"> because the HOST stamps source/extensionId.
    const fn = splitTopLevel(paramListAfter(src, "export function registerKeybinding(")).map(
      parseParam,
    );
    const facade = splitTopLevel(paramListAfter(facadeBody(), "register(")).map(parseParam);

    expect(facade.slice(1)).toEqual(fn.slice(1));
  });

  it("`when` is one of them, optional, and a boolean predicate", () => {
    // Named explicitly so the failure reads as the thing that went wrong rather
    // than as an array diff.
    const facade = splitTopLevel(paramListAfter(facadeBody(), "register(")).map(parseParam);
    const when = facade.find((p) => p.name === "when");
    expect(when, "IKeybindingsAPI.register no longer declares `when`").toBeDefined();
    expect(when!.optional).toBe(true);
    expect(when!.type).toBe("() => boolean");
  });
});

// ============================================================================
// commands.ts exports
// ============================================================================

describe("api/commands.ts surface stability", () => {
  it("exports CoreCommands as an object", async () => {
    const mod = await import("../commands");
    expect(mod.CoreCommands).toBeDefined();
    expect(typeof mod.CoreCommands).toBe("object");
  });

  it("CoreCommands contains expected command IDs", async () => {
    const mod = await import("../commands");
    const expected = [
      "CUT", "COPY", "PASTE", "PASTE_SPECIAL",
      "UNDO", "REDO", "FIND", "REPLACE",
      "CLEAR_CONTENTS", "CLEAR_FORMATTING", "CLEAR_ALL",
      "FORMAT_CELLS", "FORMAT_PAINTER",
      "MERGE_CELLS", "UNMERGE_CELLS", "FREEZE_PANES",
      "INSERT_ROW", "INSERT_COLUMN", "DELETE_ROW", "DELETE_COLUMN",
      "FILL_DOWN", "FILL_RIGHT", "FILL_UP", "FILL_LEFT",
    ];
    for (const key of expected) {
      expect(mod.CoreCommands).toHaveProperty(key);
    }
  });

  it("CoreCommands values are prefixed with 'core.'", async () => {
    const mod = await import("../commands");
    for (const value of Object.values(mod.CoreCommands)) {
      expect(value).toMatch(/^core\./);
    }
  });

  it("exports CommandRegistry singleton with ICommandRegistry methods", async () => {
    const mod = await import("../commands");
    expect(mod.CommandRegistry).toBeDefined();
    expect(typeof mod.CommandRegistry.execute).toBe("function");
    expect(typeof mod.CommandRegistry.register).toBe("function");
    expect(typeof mod.CommandRegistry.unregister).toBe("function");
    expect(typeof mod.CommandRegistry.has).toBe("function");
    expect(typeof mod.CommandRegistry.getAll).toBe("function");
  });
});

// ============================================================================
// lib.ts exports (spot-check key functions)
// ============================================================================

describe("api/lib.ts surface stability", () => {
  it("exports core cell operations", async () => {
    const mod = await import("../lib");
    const cellOps = [
      "getCell", "updateCell", "updateCellsBatch", "clearCell",
      "clearRange", "fillRange", "getGridBounds", "getCellCount",
    ];
    for (const fn of cellOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports sheet management functions", async () => {
    const mod = await import("../lib");
    const sheetOps = [
      "getSheets", "getActiveSheet", "setActiveSheet",
      "addSheet", "deleteSheet", "renameSheet", "moveSheet", "copySheet",
    ];
    for (const fn of sheetOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports undo/redo functions", async () => {
    const mod = await import("../lib");
    const undoOps = ["getUndoState", "undo", "redo", "beginUndoTransaction", "commitUndoTransaction"];
    for (const fn of undoOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports dimension functions", async () => {
    const mod = await import("../lib");
    const dimOps = ["setColumnWidth", "getColumnWidth", "setRowHeight", "getRowHeight"];
    for (const fn of dimOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports style functions", async () => {
    const mod = await import("../lib");
    const styleOps = ["getStyle", "getAllStyles", "setCellStyle", "applyFormatting"];
    for (const fn of styleOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports find/replace functions", async () => {
    const mod = await import("../lib");
    const findOps = ["findAll", "countMatches", "replaceAll", "replaceSingle"];
    for (const fn of findOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports merge cell functions", async () => {
    const mod = await import("../lib");
    const mergeOps = ["mergeCells", "unmergeCells", "getMergedRegions", "getMergeInfo"];
    for (const fn of mergeOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports named range functions", async () => {
    const mod = await import("../lib");
    const namedOps = [
      "createNamedRange", "updateNamedRange", "deleteNamedRange",
      "getNamedRange", "getAllNamedRanges",
    ];
    for (const fn of namedOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports data validation functions", async () => {
    const mod = await import("../lib");
    const valOps = [
      "setDataValidation", "clearDataValidation", "getDataValidation",
      "getAllDataValidations", "validateCell",
    ];
    for (const fn of valOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports comment functions", async () => {
    const mod = await import("../lib");
    const commentOps = ["addComment", "updateComment", "deleteComment", "getComment", "getAllComments"];
    for (const fn of commentOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports grouping/outline functions", async () => {
    const mod = await import("../lib");
    const groupOps = [
      "groupRows", "ungroupRows", "groupColumns", "ungroupColumns",
      "collapseRowGroup", "expandRowGroup", "getOutlineInfo",
    ];
    for (const fn of groupOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports autofilter functions", async () => {
    const mod = await import("../lib");
    const filterOps = [
      "applyAutoFilter", "clearColumnCriteria", "removeAutoFilter",
      "getAutoFilter", "getHiddenRows", "getFilterUniqueValues",
    ];
    for (const fn of filterOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exposes the pivot facade via IoC (registerPivotApi + delegating proxy)", async () => {
    // Pivot OPERATIONS are no longer individual @api/lib exports — the Pivot
    // extension registers an implementation and consumers use the `pivot`
    // object (the API facade imports no extension; see @api/pivot).
    const mod = await import("../pivot");
    expect(typeof mod.registerPivotApi).toBe("function");
    expect(mod.pivot).toBeDefined();
    // Layout persistence stays a direct (backend-backed) export.
    expect(typeof mod.savePivotLayout).toBe("function");
    // The proxy delegates to whatever the Pivot extension registers.
    let called = false;
    mod.registerPivotApi({
      getView: async () => {
        called = true;
        return undefined as never;
      },
    } as unknown as import("../pivotTypes").PivotApi);
    await (mod.pivot as unknown as { getView: () => Promise<unknown> }).getView();
    expect(called).toBe(true);
  });

  it("exports conditional formatting functions", async () => {
    const mod = await import("../lib");
    const cfOps = [
      "addConditionalFormat", "updateConditionalFormat",
      "deleteConditionalFormat", "getAllConditionalFormats",
    ];
    for (const fn of cfOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports protection functions", async () => {
    const mod = await import("../lib");
    const protOps = [
      "protectSheet", "unprotectSheet", "isSheetProtected",
      "canEditCell", "protectWorkbook", "unprotectWorkbook",
    ];
    for (const fn of protOps) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });

  it("exports data validation helper creators", async () => {
    const mod = await import("../lib");
    const helpers = [
      "createWholeNumberRule", "createDecimalRule", "createListRule",
      "createTextLengthRule", "createCustomRule",
    ];
    for (const fn of helpers) {
      expect(typeof (mod as Record<string, unknown>)[fn]).toBe("function");
    }
  });
});

// ============================================================================
// types.ts exports
// ============================================================================

describe("api/types.ts surface stability", () => {
  it("exports columnToLetter as a function", async () => {
    const mod = await import("../types");
    expect(typeof mod.columnToLetter).toBe("function");
  });

  it("exports letterToColumn as a function", async () => {
    const mod = await import("../types");
    expect(typeof mod.letterToColumn).toBe("function");
  });

  it("columnToLetter produces expected values", async () => {
    const { columnToLetter } = await import("../types");
    expect(columnToLetter(0)).toBe("A");
    expect(columnToLetter(25)).toBe("Z");
    expect(columnToLetter(26)).toBe("AA");
  });

  it("letterToColumn produces expected values", async () => {
    const { letterToColumn } = await import("../types");
    expect(letterToColumn("A")).toBe(0);
    expect(letterToColumn("Z")).toBe(25);
    expect(letterToColumn("AA")).toBe(26);
  });

  it("exports zoom constants", async () => {
    const mod = await import("../types");
    expect(typeof mod.ZOOM_MIN).toBe("number");
    expect(typeof mod.ZOOM_MAX).toBe("number");
    expect(typeof mod.ZOOM_DEFAULT).toBe("number");
    expect(typeof mod.ZOOM_STEP).toBe("number");
    expect(Array.isArray(mod.ZOOM_PRESETS)).toBe(true);
  });

  it("exports DEFAULT_GRID_CONFIG and DEFAULT_FREEZE_CONFIG", async () => {
    const mod = await import("../types");
    expect(mod.DEFAULT_GRID_CONFIG).toBeDefined();
    expect(mod.DEFAULT_FREEZE_CONFIG).toBeDefined();
  });

  it("exports isFormulaExpectingReference as a function", async () => {
    const mod = await import("../types");
    expect(typeof mod.isFormulaExpectingReference).toBe("function");
  });
});

// ============================================================================
// settings.ts exports
// ============================================================================

describe("api/settings.ts surface stability", () => {
  it("exports getSetting as a function", async () => {
    const mod = await import("../settings");
    expect(typeof mod.getSetting).toBe("function");
  });

  it("exports setSetting as a function", async () => {
    const mod = await import("../settings");
    expect(typeof mod.setSetting).toBe("function");
  });

  it("exports removeSetting as a function", async () => {
    const mod = await import("../settings");
    expect(typeof mod.removeSetting).toBe("function");
  });

  it("exports registerSettingDefinitions as a function", async () => {
    const mod = await import("../settings");
    expect(typeof mod.registerSettingDefinitions).toBe("function");
  });

  it("exports getAllSettingDefinitions as a function", async () => {
    const mod = await import("../settings");
    expect(typeof mod.getAllSettingDefinitions).toBe("function");
  });

  it("exports subscribeToSettings as a function", async () => {
    const mod = await import("../settings");
    expect(typeof mod.subscribeToSettings).toBe("function");
  });
});

// ============================================================================
// range.ts — CellRange class methods
// ============================================================================

describe("api/range.ts CellRange surface stability", () => {
  it("CellRange class is exported", async () => {
    const mod = await import("../range");
    expect(mod.CellRange).toBeDefined();
    expect(typeof mod.CellRange).toBe("function");
  });

  it("CellRange has static fromAddress method", async () => {
    const { CellRange } = await import("../range");
    expect(typeof CellRange.fromAddress).toBe("function");
  });

  it("CellRange has static fromCell method", async () => {
    const { CellRange } = await import("../range");
    expect(typeof CellRange.fromCell).toBe("function");
  });

  it("CellRange instance has all expected methods", async () => {
    const { CellRange } = await import("../range");
    const range = new CellRange(0, 0, 5, 5);

    const expectedMethods = [
      "contains", "intersects", "intersection", "union",
      "offset", "resize", "cells", "forEachCell",
      "getCell", "getRow", "getColumn",
      "equals", "toString",
    ];

    for (const method of expectedMethods) {
      expect(typeof (range as Record<string, unknown>)[method]).toBe("function");
    }
  });

  it("CellRange constructor sets row/col properties", async () => {
    const { CellRange } = await import("../range");
    const range = new CellRange(1, 2, 10, 20);
    expect(range.startRow).toBe(1);
    expect(range.startCol).toBe(2);
    expect(range.endRow).toBe(10);
    expect(range.endCol).toBe(20);
  });
});
