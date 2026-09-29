//! FILENAME: app/src/api/__tests__/canvasStackingUndoComments.test.ts
// PURPOSE: X8 (wave D; wc-undo F3). Since W5 a canvas's STACKING (Bring to
//          Front / Send to Back) and its LOCKS are one undo step each
//          (`set_canvas_layout_inner` records a `canvas_stacking` restore);
//          only the page, snap grid and background stay non-undoable view
//          state. Four comments still said the whole layout was not undoable
//          -- two of them as the REASON a rule exists ("don't prune dead refs
//          from the layout, because the layout is not on the undo stack"), a
//          reason that is no longer true. The rule itself still stands, for a
//          reason that is: a delete does not prune the layout's refs, so Ctrl+Z
//          of the delete brings the object back under the same ref, and the
//          ref still names its lock and paint slot.
// CONTEXT: Comments are read by the next person who changes the code; a false
//          "not undoable" invites exactly the pruning (or the missing undo arm)
//          it claims is harmless. Pinned by source text.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "../../..");
function read(rel: string): string {
  return fs.readFileSync(path.join(APP, rel), "utf8");
}

/** The `///` doc block directly above `pub fn set_canvas_layout(`. */
function setCanvasLayoutDoc(sheetsRs: string): string {
  const fnAt = sheetsRs.indexOf("pub fn set_canvas_layout(");
  expect(fnAt, "fixture: set_canvas_layout not found in sheets.rs").toBeGreaterThan(-1);
  const lines = sheetsRs.slice(0, fnAt).split("\n");
  const doc: string[] = [];
  for (let i = lines.length - 2; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("///")) doc.unshift(line);
    else if (line.startsWith("#[")) continue;
    else break;
  }
  return doc.join("\n");
}

describe("no comment says canvas stacking or locks are not undoable (X8)", () => {
  it("sheets.rs: set_canvas_layout's doc names what IS undoable", () => {
    const doc = setCanvasLayoutDoc(read("src-tauri/src/sheets.rs"));
    expect(doc, "set_canvas_layout's doc still says the whole layout is not undoable").not.toMatch(
      /Not undoable, like zoom and the display flags: it is view\/layout state\./,
    );
    expect(doc, "the doc must say that stacking and locks are one undo step").toMatch(/stacking/i);
    expect(doc).toMatch(/undo step/i);
  });

  it("CanvasSheet zOrderStore.ts: restack and lock are undoable", () => {
    const text = read("extensions/CanvasSheet/lib/zOrderStore.ts");
    expect(text, "zOrderStore.ts still says restack/lock are not undoable").not.toMatch(
      /Neither is undoable today/,
    );
    expect(text).not.toMatch(/`set_canvas_layout` records no undo/);
  });

  it("the don't-prune rule gives the reason that is still true", () => {
    for (const rel of ["extensions/CanvasSheet/lib/layoutRefs.ts", "src/api/objectSelection.ts"]) {
      const text = read(rel);
      expect(text, `${rel} still rests the don't-prune rule on "the layout is not on the undo stack"`).not.toMatch(
        /the layout is not on the undo stack/,
      );
      expect(text, `${rel} still says set_canvas_layout records no undo`).not.toMatch(
        /`set_canvas_layout` records no undo/,
      );
      expect(text, `${rel} must say deletes do not prune layout refs`).toMatch(/delete[s]? (does|do) not prune/i);
    }
  });
});
