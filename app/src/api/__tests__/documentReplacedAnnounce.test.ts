//! FILENAME: app/src/api/__tests__/documentReplacedAnnounce.test.ts
// PURPOSE: Every path that replaces the WHOLE document must announce through the
//          one helper, not assemble its own sequence.
// CONTEXT: `announceBackendStateReplaced` exists because four extension caches
//          and the SHEET LIST have no per-mutation wrapper to speak for them. Its
//          own comment records the measured symptom: a two-sheet workbook
//          followed by File > New left a phantom tab whose backend index no
//          longer existed, and clicking it errored with "Sheet index 1 out of
//          range".
//
//          `calp_checkout` then replaced the document too, emitted `AFTER_OPEN`
//          by hand, and skipped the helper — reproducing that bug symptom for
//          symptom, this time after "Open Application for Editing". AFTER_OPEN
//          is not a substitute: `SheetTabs` does not listen for it. It listens
//          for SHEET_CHANGED, which is one of the events the helper emits.
//
//          So the rule is not "remember to emit the right events". It is "call
//          the helper", and this test is what holds the next document-replacing
//          command to it.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

/** Comments quote the defects they removed, so a scanner must not read them. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const FILE_API = code(read("core/lib/file-api.ts"));
const DISTRIBUTION = code(read("api/distribution.ts"));

describe("a replaced document announces through one helper", () => {
  it("open and new both call it", () => {
    // The two original callers. If either stops, the caches this exists for go
    // stale again.
    const opens = FILE_API.match(/announceBackendStateReplaced\(\)/g) ?? [];
    // One definition + two call sites.
    expect(opens.length).toBeGreaterThanOrEqual(2);
  });

  it("checkout calls it — it replaces the document exactly as an open does", () => {
    // SABOTAGE: delete the `announceBackendStateReplaced()` line from
    // `checkoutApplication`. That is precisely the shipped bug: the tab strip
    // keeps the previous document's sheets and the next click asks the backend
    // for an index that is gone.
    expect(DISTRIBUTION).toMatch(/announceBackendStateReplaced\(\)/);
  });

  it("the helper still refreshes the SHEET LIST, which is the tab a user can click", () => {
    // The four caches are invisible until something reads them; the phantom tab
    // is not. SABOTAGE: drop the SHEET_CHANGED emit from the helper.
    const body = FILE_API.match(
      /export function announceBackendStateReplaced\(\): void \{([\s\S]*?)\n\}/,
    );
    expect(body, "the helper moved or was renamed").toBeTruthy();
    expect(body![1]).toMatch(/AppEvents\.SHEET_CHANGED/);
    expect(body![1]).toMatch(/AppEvents\.OUTLINE_CHANGED/);
    expect(body![1]).toMatch(/AppEvents\.SHEET_DISPLAY_FLAGS_CHANGED/);
  });

  it("checkout does not hand-roll the sequence instead", () => {
    // Emitting the individual events from the call site is how the two copies
    // drift: the helper gained SHEET_DISPLAY_FLAGS_CHANGED after it was written,
    // and a hand-rolled copy would not have.
    // SABOTAGE: replace the helper call with the four emits.
    const checkout = DISTRIBUTION.match(
      /export async function checkoutApplication\([\s\S]*?\n\}/,
    );
    expect(checkout, "checkoutApplication moved or was renamed").toBeTruthy();
    expect(checkout![0]).not.toMatch(/AppEvents\.OUTLINE_CHANGED/);
    expect(checkout![0]).not.toMatch(/AppEvents\.SHEET_DISPLAY_FLAGS_CHANGED/);
  });
});
