//! FILENAME: app/extensions/Distribution/__tests__/pushHoldBack.test.ts
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

  it("clears the exclusions when the diff is refetched", () => {
    // The diff re-runs on a sheet-selection or includeComments change. A key
    // kept from the previous answer could name a row that no longer exists — an
    // invisible exclusion acting on a push nobody reviewed.
    // SABOTAGE: delete the `setExcludedCells(new Set())` from the diff effect.
    const effectStart = DIALOG.indexOf("diffWorkingCopy({");
    expect(effectStart).toBeGreaterThan(-1);
    const effectEnd = DIALOG.indexOf("}, [mode, workspace?.baseVersion", effectStart);
    expect(effectEnd).toBeGreaterThan(effectStart);
    expect(DIALOG.slice(effectStart, effectEnd)).toMatch(/setExcludedCells\(new Set\(\)\)/);
  });

  it("offers the checkboxes only on a PUSH with a base version", () => {
    // A first publish has no base version to take a held-back value FROM, so a
    // checkbox there would be a control with nothing behind it.
    // SABOTAGE: pass the selection unconditionally.
    expect(DIALOG).toMatch(/mode === "push" && workspace\?\.baseVersion\s*\n?\s*\?\s*\{/);
  });
});
