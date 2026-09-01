//! FILENAME: app/src/shell/__tests__/sheetTabDecorationWiring.test.ts
// PURPOSE: The tab strip must actually CONSULT the decoration seam, key it on
//          the sheet's identity, and repaint when an extension says the answer
//          changed.
// CONTEXT: `src/api/__tests__/sheetTabDecorations.test.ts` proves the registry
//          composes and notifies. That is worth nothing if the strip never calls
//          it — and the failure would be invisible: no error, no warning, just a
//          badge that never appears.
//
//          SOURCE-TEXT ASSERTIONS, deliberately. Rendering `SheetTabs` means
//          mocking ~25 symbols across three modules plus a grid context, and a
//          mock that wide breaks on unrelated edits and gets deleted. Every
//          failure mode below is a JSX prop or a hook dependency, which is
//          exactly what source text can see.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SHELL = path.resolve(__dirname, "..");
const TABS = fs.readFileSync(path.join(SHELL, "SheetTabs/SheetTabs.tsx"), "utf8");
const STYLES = fs.readFileSync(path.join(SHELL, "SheetTabs/SheetTabs.styles.ts"), "utf8");

/** Comments quote the defects they removed, so a scanner must not read them. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const CODE = code(TABS);

describe("the sheet tab strip consults the decoration seam", () => {
  it("asks for every visible tab's marks", () => {
    // SABOTAGE: delete the `getSheetTabDecorations({...})` call.
    expect(CODE).toMatch(/getSheetTabDecorations\(\{/);
  });

  it("keys the ask on the sheet's stable id, not its index or name", () => {
    // A mark on the WRONG tab is worse than no mark, and index and name both
    // move — on insert/delete/move, and on rename.
    // SABOTAGE: drop `sheetId: sheet.sheetId` from the target literal.
    const call = CODE.match(/getSheetTabDecorations\(\{([\s\S]*?)\}\)/);
    expect(call, "the decoration call moved or was renamed").toBeTruthy();
    expect(call![1]).toMatch(/sheetId:\s*sheet\.sheetId/);
  });

  it("renders the marks BEFORE the name, and the formula marker after", () => {
    // Two glyph runs at the same edge read as one string ("Sales ↓ [*]").
    // Leading marks also line up down the strip, which is what makes it
    // scannable.
    // SABOTAGE: move the decorations block below `{sheet.name}`.
    const marks = CODE.indexOf("MAX_SHEET_TAB_DECORATION_GLYPHS");
    const name = CODE.indexOf("{sheet.name}");
    const source = CODE.indexOf("S.SourceIndicator");
    expect(marks).toBeGreaterThanOrEqual(0);
    expect(name).toBeGreaterThan(marks);
    expect(source).toBeGreaterThan(name);
  });

  it("caps the glyphs but never the disclosure", () => {
    // The cap limits pixels. Every mark's reason still reaches the title, or a
    // mark past the cap would be a symbol with no way to find out what it means.
    // SABOTAGE: remove the `.slice(0, MAX_...)`, or drop the tooltip spread
    // from the title expression.
    expect(CODE).toMatch(/\.slice\(0,\s*MAX_SHEET_TAB_DECORATION_GLYPHS\)/);
    expect(CODE).toMatch(/decorations\.map\(\(d\) => d\.tooltip\)/);
  });

  it("repaints when a provider registers or its answer changes", () => {
    // THE ENTIRE REASON the seam has a change channel: extensions activate after
    // the strip has mounted, and a .calp pull can land while it is up.
    // SABOTAGE: delete the `onSheetTabDecorationsChanged` effect.
    expect(CODE).toMatch(/onSheetTabDecorationsChanged\(\(\) =>\s*setDecorationTick/);
  });

  it("recomputes the overflow counters when a mark appears", () => {
    // Marks WIDEN tabs. Without this dependency the "(3)" hidden-count chips go
    // stale the moment an extension activates, and stay stale until a resize.
    // SABOTAGE: drop `decorationTick` from the dependency array.
    const dep = CODE.match(/\}, \[updateHiddenCounts, sheets[^\]]*\]\)/);
    expect(dep, "the hidden-count effect moved").toBeTruthy();
    expect(dep![0]).toContain("decorationTick");
  });

  it("gives the mark its own colour and weight, so the active tab cannot repaint it", () => {
    // `Tab` shifts to the accent colour and weight 600 when active. A mark that
    // inherited would look like a different state on the selected tab.
    // SABOTAGE: delete the `color:`/`font-weight:` lines from TabDecoration.
    const decoration = STYLES.match(/export const TabDecoration = styled\.span[\s\S]*?`;/);
    expect(decoration, "TabDecoration is gone from the styles").toBeTruthy();
    expect(decoration![0]).toMatch(/font-weight:\s*700/);
    expect(decoration![0]).toMatch(/color:\s*\$\{props => props\.\$color/);
  });

  it("labels the mark for a screen reader", () => {
    // The glyph carries the meaning for sighted users; `aria-label` carries it
    // for everyone else. `title` alone does not reach a screen reader reliably.
    // SABOTAGE: remove the aria-label prop.
    expect(CODE).toMatch(/aria-label=\{d\.tooltip\}/);
  });
});
