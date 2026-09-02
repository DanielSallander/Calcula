//! FILENAME: app/src/shell/__tests__/sheetTabContextIdentity.test.ts
// PURPOSE: The sheet context menu must resolve the right-clicked tab by its
//          `index` FIELD, and must hand extensions the sheet's stable id.
// CONTEXT: `getSheets()` filters object-backed sheets out of the list while
//          keeping the TRUE state-vector index on every row
//          (`build_sheet_list`, sheets.rs). `sheets[i].index === i` therefore
//          holds only while every object sheet sits at the tail — an invariant
//          maintained at exactly one site (`add_sheet_inner`) and NOT maintained
//          by the `.calp` pull, the drill-through sheet or the report-pages
//          sheet, all of which append past that tail.
//
//          When it breaks, a positional lookup fed a true index returns a
//          DIFFERENT sheet: the Detach confirm read `Detach "Detail" ...` while
//          the command detached KPIs, and the tab one further along resolved to
//          `undefined` and showed no extension menu items at all.
//
//          SOURCE-TEXT ASSERTIONS, for the reason its sibling
//          `sheetTabDecorationWiring.test.ts` gives: rendering `SheetTabs` means
//          mocking ~25 symbols across three modules. The behaviour half — that
//          a find-by-index resolver actually beats a subscript on a list with a
//          gap in it — is exercised directly below against the same expression.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SHELL = path.resolve(__dirname, "..");
const TABS = fs.readFileSync(path.join(SHELL, "SheetTabs/SheetTabs.tsx"), "utf8");

/** Comments quote the defects they removed, so a scanner must not read them. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const CODE = code(TABS);

describe("the strip resolves a sheet by index, not by position", () => {
  it("has one resolver, and it matches on the index FIELD", () => {
    // SABOTAGE: `sheets.find((s) => s.index === index)` -> `sheets[index]`.
    expect(CODE).toMatch(/const sheetAt = \([\s\S]{0,120}sheets\.find\(\(s\) => s\.index === index\)/);
  });

  it("NEVER subscripts a sheet list — every index in this file is a true one", () => {
    // Eleven sites did. Three were the context menu (`getContextMenuItems`, the
    // click handler, the rename prompt's default). The other eight were worse
    // and nobody had named them: `result.sheets[result.activeIndex]` broadcasts
    // `SHEET_CHANGED` and the Redux active sheet with one sheet's INDEX and
    // another's NAME, and the shift-click 3D reference built `Sheet1:Detail!`
    // out of two positional lookups.
    // SABOTAGE: put any `sheets[...]` subscript back.
    const subscripts = CODE.match(/\bsheets\[[^\]]+\]/g) ?? [];
    expect(
      subscripts,
      `a sheet list is being subscripted with what is a true index here: ` +
        `${subscripts.join(", ")}. \`getSheets()\` omits object-backed sheets ` +
        `while keeping true indices, so position and index are not the same ` +
        `number. Use \`sheetAt(list, index)\`.`,
    ).toEqual([]);
  });

  it("builds the extension context once, so index and sheet cannot disagree", () => {
    // They used to be built twice — once for `visible`/`label`, once for the
    // click — from two separate positional lookups.
    // SABOTAGE: inline a second `SheetContext` literal in either handler.
    const literals = CODE.match(/: SheetContext(?: \| null)? = \{|\): SheetContext \| null =>/g) ?? [];
    expect(literals.length).toBe(1);
    expect(CODE).toMatch(/const contextFor = useCallback\(/);
  });

  it("hands the extension the sheet's stable id", () => {
    // Without it an extension caching anything per sheet has only the index to
    // key on — which is exactly how Distribution's tab menu ended up pointing
    // one sheet over after a drag.
    // SABOTAGE: drop `sheetId: sheet.sheetId` from the context literal.
    const literal = CODE.match(/const contextFor = useCallback\(([\s\S]*?)\n {4}\[/);
    expect(literal, "contextFor moved or was renamed").toBeTruthy();
    expect(literal![1]).toMatch(/sheetId:\s*sheet\.sheetId/);
  });

  it("passes the TRUE index to the resolver from the tab", () => {
    // `sheet.index`, never the `visibleSheets.map` position — the backend
    // commands the menu items call all take a true index.
    // SABOTAGE: `handleContextMenu(e, visIdx)`.
    expect(CODE).toMatch(/handleContextMenu\(e, sheet\.index\)/);
  });
});

describe("the resolver's arithmetic, against a list with a gap", () => {
  // The shape a workbook takes after a floating range (object sheet at the
  // tail) and then a .calp pull (user sheets appended PAST it): getSheets()
  // returns rows whose `index` skips 1.
  const sheets = [
    { index: 0, name: "Sheet1" },
    { index: 2, name: "KPIs" },
    { index: 3, name: "Detail" },
  ];
  const sheetByIndex = (index: number) => sheets.find((s) => s.index === index);

  it("finds the sheet the index names", () => {
    expect(sheetByIndex(2)?.name).toBe("KPIs");
    expect(sheetByIndex(3)?.name).toBe("Detail");
  });

  it("is what a subscript gets wrong — silently, and then not at all", () => {
    // Right-clicking KPIs (true index 2) resolved to `sheets[2]` = Detail: the
    // confirm named one sheet and the command detached another. Right-clicking
    // Detail (true index 3) resolved to `undefined`, and `if (!sheet) return []`
    // gave that tab no extension menu items at all.
    expect(sheets[2].name).toBe("Detail");
    expect(sheets[3]).toBeUndefined();
  });

  it("answers nothing for an index the list does not carry", () => {
    // The object sheet's own index. It is not in the strip, so it has no menu.
    expect(sheetByIndex(1)).toBeUndefined();
  });
});
