//! FILENAME: app/src/shell/__tests__/sheetTabAddCanvas.test.ts
// PURPOSE: The sheet-tab "+" is a SPLIT control: the "+" still adds a worksheet
//          in one click (eighteen journeys and walkers select it by its title
//          and expect exactly that), and a caret beside it offers the kind --
//          Worksheet or Canvas. The context menu's "Insert Canvas" reaches the
//          same handler through `sheet:requestAdd`, which now reads its kind.
// CONTEXT: SOURCE-TEXT assertions, as in sheetTabContextIdentity.test.ts:
//          rendering SheetTabs means mocking ~25 symbols across three modules.
//          The kind's own path to the backend (`addSheet(name, kind)` ->
//          `add_sheet`) is covered by the Rust canvas tests.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SHELL = path.resolve(__dirname, "..");
const TABS = fs.readFileSync(path.join(SHELL, "SheetTabs/SheetTabs.tsx"), "utf8");
const EXT = fs.readFileSync(path.join(SHELL, "registries/sheetExtensions.ts"), "utf8");

/** Comments quote the behaviour they replaced, so a scanner must not read them. */
const code = (src: string): string =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const CODE = code(TABS);
const EXT_CODE = code(EXT);

describe("the split add control", () => {
  it("the '+' keeps its title and its ONE-CLICK worksheet add (no kind passed)", () => {
    const plus = CODE.match(/<S\.AddButton[\s\S]*?<\/S\.AddButton>/);
    expect(plus, "the + button is gone").not.toBeNull();
    expect(plus![0]).toContain('"Add new sheet"');
    // SABOTAGE: passing "canvas" here turns every journey's "+" into a canvas.
    expect(plus![0]).toMatch(/onClick=\{\(\) => void handleAddSheet\(\)\}/);
  });

  it("the caret announces a menu and toggles it", () => {
    const caret = CODE.match(/<S\.AddCaretButton[\s\S]*?<\/S\.AddCaretButton>/);
    expect(caret, "the caret is gone").not.toBeNull();
    expect(caret![0]).toContain('aria-haspopup="menu"');
    expect(caret![0]).toMatch(/aria-expanded=\{addMenu !== null\}/);
    expect(caret![0]).toContain("data-add-sheet-menu-trigger");
  });

  it("the outside-click dismissal ignores the caret, so a second click on it CLOSES the menu", () => {
    // Without this, the document mousedown closes the menu and the caret's own
    // click then reopens it: the toggle could never close.
    // The ADD menu's effect (the file has a second outside-click handler for
    // the tab context menu).
    const at = CODE.indexOf("if (!addMenu) return;");
    expect(at, "the add-menu effect is gone").toBeGreaterThan(-1);
    const outside = CODE.slice(at);
    expect(outside.slice(0, 500)).toMatch(/closest\?\.\("\[data-add-sheet-menu-trigger\]"\)\) return;/);
  });

  it("the menu offers both kinds and each passes ITS kind", () => {
    // SABOTAGE: the Canvas item calling plain handleAddSheet() adds a worksheet.
    expect(CODE).toMatch(
      /data-add-sheet-kind="worksheet"\s*onClick=\{\(\) => void handleAddSheet\("worksheet"\)\}/,
    );
    expect(CODE).toMatch(
      /data-add-sheet-kind="canvas"\s*onClick=\{\(\) => void handleAddSheet\("canvas"\)\}/,
    );
  });

  it("the handler forwards the kind to the backend wrapper", () => {
    const handler = CODE.slice(CODE.indexOf("const handleAddSheet = useCallback"));
    expect(handler.slice(0, 1200)).toMatch(/addSheet\(undefined, kind\)/);
  });
});

describe("sheet groups", () => {
  it("a canvas never joins a Ctrl+click group, from either end", () => {
    // A group replicates cell edits, clears and formats; the backend refuses
    // all of them on a canvas for the WHOLE group.
    const branch = CODE.slice(CODE.indexOf("if (event?.ctrlKey && !isCurrentlyFormulaMode)"));
    const guard = branch.slice(0, 600);
    expect(guard).toMatch(/sheetAt\(sheets, index\)\?\.kind === "canvas"/);
    expect(guard).toMatch(/sheetAt\(sheets, activeIndex\)\?\.kind === "canvas"/);
    expect(guard.indexOf('kind === "canvas"')).toBeLessThan(guard.indexOf("toggleSheetInGroup("));
  });
});

describe("the context menu route", () => {
  it("'Insert Canvas' asks for a canvas through sheet:requestAdd", () => {
    const item = EXT_CODE.slice(EXT_CODE.indexOf('id: "core:insertCanvas"'));
    expect(item.slice(0, 400)).toMatch(/sheet:requestAdd"[\s\S]{0,40}detail: \{ kind: "canvas" \}/);
  });

  it("the strip's requestAdd listener reads the kind instead of ignoring the detail", () => {
    const listener = CODE.slice(CODE.indexOf("const handleAdd = async"));
    expect(listener.slice(0, 300)).toMatch(/detail\?\.kind/);
    expect(listener.slice(0, 300)).toMatch(/handleAddSheetRef\.current\(kind === "canvas" \? "canvas" : undefined\)/);
  });

  it("'Duplicate Sheet' is hidden for a canvas (the backend refuses to copy one)", () => {
    const item = EXT_CODE.slice(EXT_CODE.indexOf('id: "core:copySheet"'));
    expect(item.slice(0, 400)).toMatch(/visible: \(context\) => context\.sheet\.kind !== "canvas"/);
  });
});
