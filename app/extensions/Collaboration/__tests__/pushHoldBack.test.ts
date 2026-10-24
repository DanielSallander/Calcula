//! FILENAME: app/extensions/Collaboration/__tests__/pushHoldBack.test.ts
// PURPOSE: The un-revert must run on EVERY path out of a push that held cells
//          back. That is the only failure here that costs a developer their work.
// CONTEXT: Unticking a change in the push diff means "publish without this, keep
//          it locally". It is implemented as: roll the cell back to its base
//          value in the LIVE document, publish, then undo.
//
//          Rolling back at SERIALIZATION time instead would have been simpler
//          and is wrong — nothing on the receiving side ever recalculates, so a
//          formula whose inputs did not ship would show a number that was never
//          true, invisibly, because the diff hides formula cells whose formula
//          did not change.
//
//          The cost of the chosen mechanism is that the author's workbook is
//          MOMENTARILY WRONG. These tests are about the moment ending.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

/** Comments quote the defects they removed, so a scanner must not read them. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const DIALOG = code(read("components/PublishDialog.tsx"));

/** The body of `handlePublish`, up to the closing brace at its indent. */
function handlePublishBody(): string {
  const start = DIALOG.indexOf("const handlePublish = async () => {");
  expect(start, "handlePublish moved or was renamed").toBeGreaterThan(-1);
  const end = DIALOG.indexOf("\n  };", start);
  expect(end, "could not find the end of handlePublish").toBeGreaterThan(start);
  return DIALOG.slice(start, end);
}

describe("a push that holds cells back always puts them back", () => {
  it("undoes in a finally, not on the success path", () => {
    // SABOTAGE: move the `if (holdBackSeq !== null) await undo(...)` into the try
    // block after publishApplication. A FAILED publish then leaves the author's
    // workbook holding the base values, with no message saying so.
    const body = handlePublishBody();
    const finallyAt = body.indexOf("} finally {");
    const undoAt = body.indexOf("await undo(");
    expect(finallyAt, "the finally block is gone").toBeGreaterThan(-1);
    expect(undoAt, "the un-revert is gone").toBeGreaterThan(-1);
    expect(undoAt).toBeGreaterThan(finallyAt);
  });

  it("SCOPES the undo to the entry the hold-back left", () => {
    // THE REASON THIS FEATURE SHIPPED DISABLED. `undo()` was a blind
    // `pop_undo()`, and this dialog is non-modal while a publish takes seconds
    // — so an edit the author makes, or a write from an MCP tool or a script,
    // is what the `finally` reversed. The hold-back then stayed applied
    // permanently and silently: the author's value gone from their own
    // workbook, the dialog reporting success, a save persisting the base value.
    // AutoRecover does not save them either — it snapshots LIVE state.
    // SABOTAGE: `await undo()` with no argument.
    const body = handlePublishBody();
    expect(body).toMatch(/await undo\(holdBackSeq\)/);
  });

  it("keys the undo on the ID the backend REPORTED, not on what was asked", () => {
    // `holdBackCells` returns the id of the entry it left, and `null` when it
    // wrote nothing. An undo with nothing to reverse takes back the author's own
    // last edit.
    // SABOTAGE: `holdBackSeq = excludedCells.size > 0 ? 1 : null`.
    const body = handlePublishBody();
    expect(body).toMatch(/holdBackSeq\s*=\s*r\.undoSeq\s*\?\?\s*null/);
    expect(body).toMatch(/if \(holdBackSeq !== null\)/);
  });

  it("refuses rather than falling back to a bare undo when there is no id", () => {
    // A write the backend recorded but could not identify is the unsafe shape
    // this was disabled for. It should be unreachable — `undoRecorded` is
    // derived from the id — so the disagreement is treated as the refusal it is.
    // SABOTAGE: delete the branch, or make it fall through to the publish.
    const body = handlePublishBody();
    const guard = body.indexOf("r.undoRecorded && holdBackSeq === null");
    const publishAt = body.indexOf("publishApplication(");
    expect(guard, "the no-id guard is gone").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(publishAt);
    expect(body.slice(guard, publishAt)).toMatch(/return;/);
  });

  it("shows the backend's refusal sentence when the un-revert is declined", () => {
    // A refusal is not an exception — `undo` returns normally having done
    // nothing — so a caller that only catches would report success while the
    // author's changes stayed rolled back.
    // SABOTAGE: drop the `if (r.refusal)` branch.
    const body = handlePublishBody();
    expect(body).toMatch(/if \(r\.refusal\)/);
    expect(body).toMatch(/were NOT `\s*\+\s*`restored automatically/);
  });

  it("refuses the push when the hold-back itself fails", () => {
    // Nothing was written, so there is nothing to put back — but publishing now
    // would ship the very changes the author unticked.
    // SABOTAGE: swallow the error and fall through to publishApplication.
    const body = handlePublishBody();
    const holdAt = body.indexOf("holdBackCells(");
    const publishAt = body.indexOf("publishApplication(");
    expect(holdAt).toBeGreaterThan(-1);
    expect(holdAt).toBeLessThan(publishAt);
    // The catch around the hold-back must return rather than continue.
    const between = body.slice(holdAt, publishAt);
    expect(between).toMatch(/return;/);
  });

  it("tells the user how to recover when the un-revert fails", () => {
    // The one failure this dialog cannot repair. The edits are still in the undo
    // stack, and that sentence is the whole remedy.
    // SABOTAGE: swallow the undo error.
    const body = handlePublishBody();
    expect(body).toMatch(/Ctrl\+Z/);
  });

  it("SORTS and PRUNES the exclusions by what the ANSWER says the push carries, and never clears them there", () => {
    // The diff re-runs whenever the selection moves -- also when the dialog
    // itself reads the sheet list again after a gone-sheet refusal. CLEARING
    // there (what this pin used to require) ticked every held-back change
    // again with no message, and the next Push published it (review round 9,
    // F1). Then the unticks were sorted BEFORE the fetch by the ticked rows'
    // ids -- and a push carries more than its ticked rows (a floating grid's
    // backing sheet with its host, a chart's source), so an untick on such a
    // sheet was parked while the push shipped it (review round 11, RV11-TS-1).
    // Now NOTHING moves before the fetch; when the answer lands, the unticks
    // are sorted by the sheets it says the push carries (`carriedSheetIds`) --
    // acting there, PARKED elsewhere, never dropped -- and on those sheets only
    // the unticks that are one of its rows stay. The behaviour is pinned
    // MOUNTED in pushHoldBackSurvivesReRead.test.tsx and by
    // lib/__tests__/holdBack.test.ts.
    // SABOTAGE: put `dispatchHoldBack({ type: "reset" })` back in the effect,
    // sort before the fetch again, drop either dispatch, or judge the answer
    // by anything but its `carriedSheetIds`.
    const effectStart = DIALOG.indexOf('if (mode !== "push" || !workspace?.baseVersion) return;');
    expect(effectStart, "the diff effect moved").toBeGreaterThan(-1);
    const fetchAt = DIALOG.indexOf("diffWorkingCopy({", effectStart);
    const thenAt = DIALOG.indexOf(".then((result) => {", fetchAt);
    const catchAt = DIALOG.indexOf(".catch((e: unknown) => {", thenAt);
    const effectEnd = DIALOG.indexOf("}, [mode, workspace?.baseVersion", effectStart);
    expect(fetchAt).toBeGreaterThan(effectStart);
    expect(thenAt).toBeGreaterThan(fetchAt);
    expect(catchAt).toBeGreaterThan(thenAt);
    expect(effectEnd).toBeGreaterThan(catchAt);
    const effect = DIALOG.slice(effectStart, effectEnd);
    // Before the fetch: nothing is sorted, and no guess at the carried sheets.
    const beforeFetch = DIALOG.slice(effectStart, fetchAt);
    expect(beforeFetch, "the unticks are moved before the answer says where").not.toMatch(/dispatchHoldBack\(/);
    expect(beforeFetch).not.toMatch(/askedFor/);
    // When the answer lands: the sort and then the row prune, both over the
    // sheets THAT ANSWER says the push carries.
    const onAnswer = DIALOG.slice(thenAt, catchAt);
    expect(onAnswer).toMatch(/const carried = new Set\(result\.carriedSheetIds\);/);
    const sortAt = onAnswer.indexOf('dispatchHoldBack({ type: "keepSheets", sheetIds: carried });');
    const pruneAt = onAnswer.indexOf(
      'dispatchHoldBack({ type: "keepRows", keys: rowKeysOf(result.diff), sheetIds: carried });',
    );
    expect(sortAt, "the answer does not sort the unticks by the sheets it carries").toBeGreaterThan(-1);
    expect(pruneAt, "the answer does not prune the unticks on the sheets it carries").toBeGreaterThan(-1);
    expect(sortAt, "the prune runs before the sort").toBeLessThan(pruneAt);
    // And nowhere in the effect a clear.
    expect(effect).not.toMatch(/type: "reset"/);
    expect(effect).not.toMatch(/type: "includeAll"/);
    expect(effect).not.toMatch(/setExcludedCells/);
  });

  it("sends EVERY untick with the push's own kind and selection -- the very selection the publish sends", () => {
    // Which sheets a push carries is Rust's to say, so the hold-back is told
    // the push it is part of and holds back exactly the cells on the sheets
    // that push carries (review round 11, RV11-TS-1). Sending only `excluded`
    // left a parked untick on a sheet the push carries again unsent.
    // SABOTAGE: send `[...excludedCells]`, drop `kind` or the selection, or
    // compute the publish's selection a second time.
    const body = handlePublishBody();
    const READ_ONCE = "const selection = tickedWire();";
    const selectionAt = body.indexOf(READ_ONCE);
    const holdAt = body.indexOf("holdBackCells(");
    const publishAt = body.indexOf("publishApplication(");
    expect(selectionAt, "the push's selection is not read once").toBeGreaterThan(-1);
    expect(selectionAt).toBeLessThan(holdAt);
    const holdCall = body.slice(holdAt, body.indexOf("});", holdAt));
    expect(holdCall, "the hold-back is not sent every untick").toMatch(/cells: \[\.\.\.untickedCells\]\.map\(parseCellKey\),/);
    expect(holdCall, "the hold-back is not told the push's kind").toMatch(/\bkind,/);
    expect(holdCall, "the hold-back is not told the push's selection").toMatch(/\.\.\.selection,/);
    const publishCall = body.slice(publishAt, body.indexOf("});", publishAt));
    expect(publishCall, "the publish does not send the one selection the hold-back was told").toMatch(
      /\.\.\.selection,/,
    );
    expect(body.slice(selectionAt + READ_ONCE.length), "the selection is read a second time").not.toMatch(
      /tickedWire\(\)/,
    );
    // EVERY untick is both sets: the acting ones and the parked ones.
    expect(DIALOG).toMatch(/new Set<string>\(\[\.\.\.holdBack\.excluded, \.\.\.holdBack\.parked\]\)/);
  });

  it("forgets the hold-back only where a push starts afresh: a new show, and a push that landed", () => {
    // SABOTAGE: drop the reset from the landed push -- the unticks of a push
    // that shipped would then hold back the NEXT push's cells too.
    const body = handlePublishBody();
    const landedAt = body.indexOf("setPushed(true);");
    const catchAt = body.indexOf("} catch (err: unknown) {", landedAt);
    expect(landedAt, "the landed push no longer marks itself").toBeGreaterThan(-1);
    expect(body.slice(landedAt, catchAt)).toMatch(/dispatchHoldBack\(\{ type: "reset" \}\)/);
    const show = DIALOG.indexOf("const openCount = data?.__openCount;");
    const showEnd = DIALOG.indexOf("}, [openCount]);", show);
    expect(DIALOG.slice(show, showEnd)).toMatch(/dispatchHoldBack\(\{ type: "reset" \}\)/);
  });

  it("offers the checkboxes only on a PUSH with a base version", () => {
    // A first publish has no base version to take a held-back value FROM, so a
    // checkbox there would be a control with nothing behind it.
    // SABOTAGE: pass the selection unconditionally.
    expect(DIALOG).toMatch(/mode === "push" && workspace\?\.baseVersion\s*\n?\s*\?\s*\{/);
  });
});
