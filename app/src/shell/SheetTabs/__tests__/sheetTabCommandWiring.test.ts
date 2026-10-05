//! FILENAME: app/src/shell/SheetTabs/__tests__/sheetTabCommandWiring.test.ts
// PURPOSE: The wiring between the core.sheet.* commands and the sheet tab
//          strip, and the one-rename-prompt rule, read from the source.
// CONTEXT: SOURCE-TEXT assertions for the strip itself, as in
//          sheetTabContextIdentity.test.ts and sheetTabAddCanvas.test.ts:
//          rendering SheetTabs means mocking ~25 symbols across three modules.
//          Everything the strip DELEGATES to is tested behaviourally:
//          sheetCommands.test.ts (the commands), sheetTabFlows.test.ts (the
//          backend sequences), sheetDeletePolicy.test.ts (when Delete asks),
//          sheetPlacement.test.ts (the arithmetic).

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const APP = path.resolve(__dirname, "../../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8");

/** Comments quote the behaviour they replaced, so a scanner must not read them. */
const code = (src: string): string =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const TABS = code(read("src/shell/SheetTabs/SheetTabs.tsx"));
const EXT = code(read("src/shell/registries/sheetExtensions.ts"));
const GRID_EXT = code(read("src/shell/registries/gridExtensions.ts"));
const GUARD = code(read("extensions/Protection/handlers/sheetTabGuard.ts"));

/** The body of `const <name> = useCallback(` up to its dependency list. */
function callback(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`);
  expect(at, `${name} is gone`).toBeGreaterThan(-1);
  const end = src.indexOf("\n  );", at);
  return src.slice(at, end === -1 ? at + 3000 : end);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("the strip seats the controller the commands reach it through", () => {
  it("registers it once and releases it on unmount", () => {
    expect(TABS).toMatch(/registerSheetTabsController\(\{/);
    const at = TABS.indexOf("registerSheetTabsController({");
    // Released by the same effect's cleanup.
    expect(TABS.slice(at, at + 2500)).toMatch(/releaseController\(\)/);
  });

  it("every controller method routes to the strip's own handler (never the raw @api wrapper)", () => {
    const at = TABS.indexOf("registerSheetTabsController({");
    const body = TABS.slice(at, TABS.indexOf("});", at));
    expect(body).toMatch(/insertSheetBefore:/);
    expect(body).toMatch(/deleteSheet: \(index\) => handleDeleteSheetRef\.current\(index, \{ confirm: "whenNotBlank" \}\)/);
    expect(body).toMatch(/renameSheet: \(index, newName\) => handleRenameSheetRef\.current\(index, newName\)/);
    expect(body).toMatch(/moveOrCopySheet:/);
    // SABOTAGE: `deleteSheet: (index) => deleteSheet(index)` skips the switch steps.
    expect(body).not.toMatch(/=> deleteSheet\(/);
    expect(body).not.toMatch(/=> addSheet\(/);
  });

  it("the snapshot is read from a ref the render keeps current (the commands are asked synchronously)", () => {
    expect(TABS).toMatch(/controllerStateRef\.current = \{ sheets, activeIndex, locked: structuralLocked \}/);
  });
});

describe("insert before / move or copy apply through the strip's commit-before-switch steps", () => {
  it("insert-before runs the flow and FORCES the switch steps (the active index can be unchanged while the sheet is new)", () => {
    const body = callback(TABS, "handleInsertSheetBefore");
    expect(body).toMatch(/insertSheetBefore\(/);
    expect(body).toMatch(/forceSwitch: true/);
    expect(body).toMatch(/if \(structuralLocked\)/);
  });

  it("move or copy runs the flow and forces the switch for a copy", () => {
    const body = callback(TABS, "handleMoveOrCopySheet");
    expect(body).toMatch(/moveOrCopySheet\(/);
    expect(body).toMatch(/forceSwitch: copy/);
  });

  it("applySheetsResult honours forceSwitch", () => {
    expect(TABS).toMatch(/if \(switchSheet && \(forceSwitch \|\| result\.activeIndex !== activeIndex\)\)/);
  });
});

describe("Delete Sheet asks only when the sheet holds something (Excel) -- from the COMMAND", () => {
  it("both doors go through handleDeleteSheet; only the Excel-rule door consults the policy", () => {
    const body = callback(TABS, "handleDeleteSheet");
    expect(body).toMatch(/options\.confirm !== "whenNotBlank" \|\|\s*\(await sheetDeleteNeedsConfirmation\(/);
    expect(body).toMatch(/setDeleteConfirm\(/);
    expect(body).toMatch(/executeDeleteSheet\(index\)/);
  });

  it("the tab menu's door keeps ALWAYS asking (journeys drive that confirmation; moving it is the owner's call)", () => {
    const listener = TABS.slice(TABS.indexOf("const handleDelete = async"));
    expect(listener.slice(0, 200)).toMatch(/await handleDeleteSheetRef\.current\(index\);/);
  });

  it("a delete tells Core's per-sheet view cache which index went away", () => {
    expect(callback(TABS, "executeDeleteSheet")).toMatch(/removalReorderDetail\(index\)/);
  });
});

describe("Duplicate Sheet tells the view cache about the inserted copy", () => {
  it("dispatches the insertion remap after the copy lands", () => {
    const at = TABS.indexOf("const copySheetAt = async");
    expect(at).toBeGreaterThan(-1);
    expect(TABS.slice(at, at + 900)).toMatch(/insertionReorderDetail\(result\.activeIndex\)/);
  });
});

describe("the Unhide dialog's double-click unhides the sheet it was double-clicked on", () => {
  it("passes the clicked sheet's index (the old closure unhid the PREVIOUS selection)", () => {
    expect(TABS).toMatch(/onDoubleClick=\{\(\) => \{?\s*void handleUnhideConfirm\(sheet\.index\)/);
  });
});

describe("ONE rename prompt", () => {
  it("the question is asked in exactly one source file of the shell and the extensions", () => {
    const files = [...sourceFiles(path.join(APP, "src")), ...sourceFiles(path.join(APP, "extensions"))];
    const asking = files.filter((f) => code(fs.readFileSync(f, "utf8")).includes('"Enter new sheet name:"'));
    expect(asking.map((f) => path.relative(APP, f).replace(/\\/g, "/"))).toEqual([
      "src/shell/SheetTabs/renameSheetPrompt.ts",
    ]);
  });

  it("the tab double-click and the tab menu's Rename use it", () => {
    expect(callback(TABS, "handleDoubleClick")).toMatch(/promptForSheetName\(/);
    const item = EXT.slice(EXT.indexOf('id: "core:rename"'));
    expect(item.slice(0, 500)).toMatch(/promptForSheetName\(/);
  });

  it("Protection's Rename override runs the rename COMMAND for the clicked sheet (the seam, not a copy)", () => {
    const item = GUARD.slice(GUARD.indexOf('id: "core:rename"'));
    expect(item.slice(0, 900)).toMatch(/CommandRegistry\.execute\(CoreCommands\.SHEET_RENAME, \{ index: context\.index \}\)/);
  });
});

describe("bootstrap registers the commands with the core menus", () => {
  it("the sheet commands ride registerCoreSheetContextMenu", () => {
    const fn = EXT.slice(EXT.indexOf("export function registerCoreSheetContextMenu"));
    expect(fn.slice(0, 600)).toMatch(/registerSheetCommands\(\)/);
  });

  it("the Cell Size / Visibility commands ride registerCoreGridContextMenu", () => {
    const fn = GRID_EXT.slice(GRID_EXT.indexOf("export function registerCoreGridContextMenu"));
    expect(fn.slice(0, 900)).toMatch(/registerGridFormatCommands\(\)/);
  });
});
