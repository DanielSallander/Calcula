//! FILENAME: app/src/core/lib/__tests__/dataTableEditText.test.ts
// PURPOSE: Ledger programme 2, wave 3 (BUG-0752 remainder): EDIT MODE of a data
//          table's body opens on Excel's `=TABLE(,A1)` -- no braces, never the
//          identity argument Calcula stores -- and the formula bar's reference
//          highlighting reads what the bar shows, not the stored marker (which
//          highlighted the identity cell M2). Excel [LIVE, Excel 16 over COM
//          and UI Automation, 2026-11-06, dtui/probe2.ps1]: L2 selected, the
//          bar reads `{=TABLE(;A1)}`; after F2, `=TABLE(;A1)`; Enter answers
//          "That function isn't valid." (the backend's check_cell_edit).
// SABOTAGE: make `dataTableEditText` return `formula` unchanged -- fails at
//           "STORED TEXT"; drop the call from useEditing's startEdit -- fails
//           at "EDIT OPENS ON THE MARKER"; from FormulaInput -- "HIGHLIGHTS M2".

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { dataTableEditText } from "../dataTableCopy";
import { parseFormulaReferences } from "../formulaRefParser";

describe("dataTableEditText", () => {
  it("opens edit mode on Excel's marker text", () => {
    expect(dataTableEditText("=TABLE(,A1,M2)", false), "STORED TEXT").toBe("=TABLE(,A1)");
    expect(dataTableEditText("=TABLE(;A1)", false)).toBe("=TABLE(;A1)");
    expect(dataTableEditText("=TABLE(B3,AA10,M2)", true)).toBe("=TABLE(R3C2,R10C27)");
    expect(dataTableEditText("=SUM(A1)", false)).toBeNull();
    expect(dataTableEditText(null, false)).toBeNull();
  });

  it("highlights the input cell, never the identity cell", () => {
    const shown = dataTableEditText("=TABLE(,A1,M2)", false) ?? "";
    const refs = parseFormulaReferences(shown, true);
    const cells = refs.map((r) => `${r.startRow},${r.startCol}`);
    expect(cells).toContain("0,0");
    expect(cells, "HIGHLIGHTS M2: the identity argument is highlighted").not.toContain("1,12");
  });

  it("both the editor and the formula bar use it", () => {
    const editing = fs.readFileSync(path.resolve(__dirname, "../../hooks/useEditing.ts"), "utf8");
    const start = editing.indexOf("const startEdit = useCallback(");
    expect(editing.slice(start, start + 6000), "EDIT OPENS ON THE MARKER").toContain("dataTableEditText(value, false)");
    const bar = fs.readFileSync(path.resolve(__dirname, "../../../shell/FormulaBar/FormulaInput.tsx"), "utf8");
    expect(bar, "HIGHLIGHTS M2").toContain("dataTableEditText(content, false)");
  });
});
