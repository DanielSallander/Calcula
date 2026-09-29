//! FILENAME: app/src/api/__tests__/scriptBatchDocs.test.ts
// PURPOSE: What the script API and the undo wrappers DOCUMENT about a cancelled
//          batch and an open transaction is what the code does.
// CONTEXT: Y8 (wave E; wave D undo report NEW defect 3 and fix-up NEW defect 5).
//            - `api.cancelBatch` was documented as "discarding all changes
//              since beginBatch()" with an example commented "reverted". It
//              only DROPS the batch's undo record: every write it made stays,
//              and nothing can undo them any more (host.ts executeCancelBatch,
//              core/engine/src/undo.rs `cancel_transaction`). A script author
//              who trusted the comment wrote try/catch "rollback" that rolls
//              nothing back.
//            - `UndoState.transactionOpen` told callers to PROBE it before
//              grouping their writes. Probe-then-begin is racy (the W3 window:
//              the transaction seen open commits in between, and the "join"
//              opens one nobody closes); the begin's own answer -- a ticket,
//              or null for a join -- is the race-free thing to use.
//          Both the typings TEMPLATE (what `npm run gen:script-typings` reads)
//          and the GENERATED file (what the editor shows) are checked, so the
//          two cannot drift apart either.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");

const TEMPLATE = "scripts/scriptTypings/objectContexts.template.d.ts";
const GENERATED = "extensions/ScriptableObjects/objectContexts.d.ts";

/** The doc block of `beginBatch` through `cancelBatch(): Promise<void>;`. */
function batchDocs(rel: string): string {
  const src = read(rel);
  const start = src.indexOf("Begin an undo transaction.");
  const end = src.indexOf("cancelBatch(): Promise<void>;", start);
  expect(start, `${rel}: the beginBatch doc is gone`).toBeGreaterThanOrEqual(0);
  expect(end, `${rel}: cancelBatch is gone`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe.each([TEMPLATE, GENERATED])("%s: the batch docs tell the truth", (rel) => {
  it("never promises that cancelBatch rolls the writes back", () => {
    const docs = batchDocs(rel);
    expect(docs, "cancelBatch is still documented as discarding the changes").not.toMatch(/discarding all changes/i);
    expect(docs, "the example still says a cancel REVERTS").not.toMatch(/\breverted\b/i);
    expect(docs, "the docs do not say plainly that a cancel is no rollback").toMatch(/not a rollback/i);
  });

  it("says what a cancel does: the undo record is dropped and the writes STAY", () => {
    const docs = batchDocs(rel);
    const cancel = docs.slice(docs.lastIndexOf("/**"));
    expect(cancel, "cancelBatch's own doc does not say the writes stay").toMatch(/writes?[^.]*\bstay\b/i);
    expect(cancel, "cancelBatch's own doc does not say what is dropped").toMatch(/undo (record|step)/i);
  });

  it("says a batch that JOINED another caller's step is not the script's to close", () => {
    expect(batchDocs(rel)).toMatch(/join/i);
  });

  // Wave E fix-up (review finding 2): the Y8 rewrite said "a sheet add /
  // delete / rename / move / copy ends the undo history ...; your batch
  // carries on as a new step after it". Only the script's OWN sheet change is
  // followed by a resume (host.ts calls resumeScriptBatchAfterHistoryEnded
  // from api.addSheet / deleteSheet / renameSheet / moveSheet / copySheet, for
  // the calling script only). When the USER changes the sheets mid-batch the
  // batch is over: later writes are separate steps and commitBatch closes
  // nothing (pinned in scriptHost/__tests__/scriptBatchOwnership.test.ts).
  it("says WHOSE sheet change a batch survives: the script's own, never the user's", () => {
    const docs = batchDocs(rel);
    expect(docs, "the docs promise the batch carries on after ANY sheet change").not.toMatch(
      /Excel; your batch carries on as a new step after it/,
    );
    expect(docs, "the docs do not say the batch resumes only after YOUR script's own sheet change").toMatch(
      /When YOUR script makes that change[\s\S]{0,200}?your batch resumes as a new step after it/,
    );
    expect(docs, "the docs do not say that a sheet change by the USER ends the batch").toMatch(
      /When the USER[\s\S]{0,120}?changes the sheets while your batch is open, your[\s\S]{0,12}?batch ends there/,
    );
    expect(docs, "the docs do not say the script's commitBatch / cancelBatch close nothing after that").toMatch(
      /batch ends there[\s\S]{0,200}?`commitBatch\(\)` \/ `cancelBatch\(\)` close nothing/,
    );
  });
});

describe("src/api/scriptableObjects.ts: the host-side script API interface", () => {
  it("documents cancelBatch as what it is, not a rollback", () => {
    const src = read("src/api/scriptableObjects.ts");
    const end = src.indexOf("cancelBatch(): Promise<void>;");
    expect(end, "cancelBatch is gone from the interface").toBeGreaterThan(0);
    const doc = src.slice(src.lastIndexOf("/**", end), end);
    expect(doc, "cancelBatch is still documented as discarding the changes").not.toMatch(/discarding all changes/i);
    expect(doc).toMatch(/writes?[^.]*\bstay\b/i);
    expect(doc).toMatch(/not a rollback/i);
  });
});

describe("UndoState.transactionOpen", () => {
  it("no longer tells callers to probe it before grouping (the begin's answer is the thing to use)", () => {
    const api = read("src/core/lib/tauri-api.ts");
    const start = api.indexOf("export interface UndoState {");
    const block = api.slice(start, api.indexOf("transactionOpen: boolean;", start));
    const doc = block.slice(block.lastIndexOf("/**"));
    expect(doc, "the doc still recommends probe-then-begin").not.toMatch(/Probe this before grouping/i);
    expect(doc, "the doc does not point at the begin's own answer").toMatch(/beginUndoTransaction/);
    expect(doc).toMatch(/ticket/i);
  });
});
