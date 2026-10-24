//! FILENAME: app/src/api/__tests__/backendRefusal.test.ts
// PURPOSE: The ONE recogniser of the backend's retryable snapshot refusal
//          (`@api/backendRefusal`): it knows the code RUST sends, turns the
//          refusal into its plain sentence, and leaves every other error exactly
//          as `String(err)` showed it.
// CONTEXT: Rust refuses a save, an AutoRecover tick, a publish, its preview, the
//          working-copy diff and the merge with "WORKBOOK_CHANGED_WHILE_SAVING:
//          the workbook changed while it was being <what> -- ..." when a sheet
//          renumbering kept landing inside its snapshot
//          (`take_consistent_snapshot`, app/src-tauri/src/persistence.rs). No
//          screen recognised it, so the raw code reached the push dialog.
//
//          The refusal used below is BUILT FROM persistence.rs -- its constant,
//          its attempt count and its format literal -- so a renamed code or a
//          reworded prefix in Rust turns this file red instead of leaving the
//          recogniser matching a message Rust no longer sends. The direction is
//          Rust -> TypeScript.

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import {
  CALP_PUSH_SHEET_GONE,
  CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE,
  WORKBOOK_CHANGED_WHILE_SAVING,
  describeBackendRefusal,
  isSheetGoneRefusal,
  isSheetIndexOutOfRangeRefusal,
  isWorkbookChangedWhileSaving,
} from "../backendRefusal";

const APP_ROOT = path.resolve(__dirname, "../../..");
const RUST = fs.readFileSync(path.join(APP_ROOT, "src-tauri/src/persistence.rs"), "utf8");
/** Where the publish doors refuse a ticked sheet that is gone (review round 9). */
const CALP_RUST = fs.readFileSync(path.join(APP_ROOT, "src-tauri/src/calp_commands.rs"), "utf8");

/** Rust's `pub(crate) const NAME: TYPE = VALUE;`, the value's source text. */
function rustConst(name: string, type: string): string {
  const m = RUST.match(new RegExp(`pub\\(crate\\) const ${name}: ${type.replace(/[&]/g, "\\$&")} = ([^;]+);`));
  expect(m, `persistence.rs no longer declares ${name}`).toBeTruthy();
  return m![1].trim();
}

/** A Rust string literal's body, unescaped: line continuations, quotes, backslashes. */
function unescapeRust(body: string): string {
  return body
    .replace(/\\\r?\n\s*/g, "")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

/** The refusal exactly as `take_consistent_snapshot` formats it for `what`. */
function rustRefusal(what: string): string {
  const start = RUST.indexOf("pub(crate) fn take_consistent_snapshot<T>(");
  expect(start, "take_consistent_snapshot moved or was renamed").toBeGreaterThanOrEqual(0);
  const body = RUST.slice(start, RUST.indexOf("\n}\n", start));
  const m = body.match(
    /Err\(format!\(\s*"((?:[^"\\]|\\[\s\S])*)",\s*WORKBOOK_CHANGED_WHILE_SAVING,\s*what,\s*SNAPSHOT_ATTEMPTS\s*\)\)/,
  );
  expect(m, "the refusal's format literal moved or changed its arguments").toBeTruthy();
  const code = JSON.parse(rustConst("WORKBOOK_CHANGED_WHILE_SAVING", "&str")) as string;
  const attempts = rustConst("SNAPSHOT_ATTEMPTS", "usize");
  return unescapeRust(m![1]).replace("{}", code).replace("{}", what).replace("{}", attempts);
}

/** What the person must read for a refusal: the sentence after the code, capitalised. */
function plainOf(refusal: string): string {
  const rest = refusal.slice(refusal.indexOf(":") + 1).trim();
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

describe("the recogniser knows the code Rust sends", () => {
  it("is spelled exactly as persistence.rs spells it", () => {
    expect(JSON.parse(rustConst("WORKBOOK_CHANGED_WHILE_SAVING", "&str"))).toBe(WORKBOOK_CHANGED_WHILE_SAVING);
  });

  it("the refusal Rust formats starts with the code and a colon (the shape the recogniser reads)", () => {
    const refusal = rustRefusal("saved");
    expect(refusal.startsWith(`${WORKBOOK_CHANGED_WHILE_SAVING}: `)).toBe(true);
    // Sanity on the builder itself: a real sentence, nothing left unfilled.
    expect(refusal).not.toContain("{}");
    expect(refusal).toContain("Nothing was written; try again.");
  });
});

describe("the refusal becomes its plain sentence", () => {
  // SABOTAGE: make the pattern never match (e.g. require a code Rust does not
  // send) -- every refusal then comes back raw.
  it("for every door's act, the code is gone and the sentence is Rust's own", () => {
    for (const what of ["saved", "published", "previewed", "compared", "merged", "auto-saved"]) {
      const refusal = rustRefusal(what);
      expect(isWorkbookChangedWhileSaving(refusal), what).toBe(true);
      const shown = describeBackendRefusal(refusal);
      expect(shown, what).toBe(plainOf(refusal));
      expect(shown, what).not.toContain(WORKBOOK_CHANGED_WHILE_SAVING);
      expect(shown.startsWith(`The workbook changed while it was being ${what} -- `), what).toBe(true);
    }
  });

  it("is recognised in every shape a rejection takes: bare, inside an Error, error-shaped, behind a prefix", () => {
    const refusal = rustRefusal("published");
    const plain = plainOf(refusal);
    for (const err of [refusal, new Error(refusal), { message: refusal }, `Publish failed: ${refusal}`]) {
      expect(isWorkbookChangedWhileSaving(err)).toBe(true);
      expect(describeBackendRefusal(err)).toBe(plain);
    }
  });

  it("a code with no sentence after it still reads as a sentence, never the code", () => {
    const shown = describeBackendRefusal(`${WORKBOOK_CHANGED_WHILE_SAVING}:`);
    expect(isWorkbookChangedWhileSaving(`${WORKBOOK_CHANGED_WHILE_SAVING}:   `)).toBe(true);
    expect(shown).not.toContain(WORKBOOK_CHANGED_WHILE_SAVING);
    expect(shown).toMatch(/nothing was written/i);
  });
});

describe("every other error is left exactly as it was", () => {
  // SABOTAGE: strip ANY leading `CODE:` prefix -- the CALP codes and the
  // "Error:" of an Error then change on every screen that switched to this.
  it("is String(err), character for character", () => {
    const others: unknown[] = [
      "not_dirty",
      "disk full",
      "CALP_PUSH_STALE_BASE: v1.2.0 landed while you were working.",
      "CALP_WORKSPACE_UNREADABLE: the share is gone",
      "Sheet index 4 out of range",
      new Error("access denied"),
      { message: "not this one" },
      undefined,
      null,
      42,
      "",
    ];
    for (const err of others) {
      expect(isWorkbookChangedWhileSaving(err), String(err)).toBe(false);
      expect(describeBackendRefusal(err), String(err)).toBe(String(err));
    }
  });

  it("look-alikes are not the refusal", () => {
    for (const err of [
      "NOT_WORKBOOK_CHANGED_WHILE_SAVING: something else",
      "WORKBOOK_CHANGED_WHILE_SAVING_LATER: something else",
      "WORKBOOK_CHANGED_WHILE_SAVING without its colon",
      "workbook_changed_while_saving: lower case is not the code",
    ]) {
      expect(isWorkbookChangedWhileSaving(err), err).toBe(false);
      expect(describeBackendRefusal(err), err).toBe(err);
    }
  });
});

// THE GONE-SHEET REFUSAL (review round 9). The publish doors take the ticked
// sheets by stable id and refuse an id the workbook no longer has with
// `CALP_PUSH_SHEET_GONE: <sentence>`. It is NOT retryable -- the same ids can
// never succeed -- so it must never read as the snapshot refusal, and it must
// never reach a person as its code.
describe("the gone-sheet refusal: plain words, and never retryable", () => {
  /** One door's refusal, shaped as Rust's `sheet_gone_refusal` formats it. */
  const gone = (subject: string, what: string): string =>
    `${CALP_PUSH_SHEET_GONE}: ${subject} no longer in the workbook, so nothing was ${what}. ` +
    "Open the dialog again to see the current sheets.";

  it("is spelled exactly as calp_commands.rs spells it, and Rust puts its sentence after the code and a colon", () => {
    const m = CALP_RUST.match(/pub\(crate\) const CALP_PUSH_SHEET_GONE: &str = ("[^"]*");/);
    expect(m, "calp_commands.rs no longer declares CALP_PUSH_SHEET_GONE").toBeTruthy();
    expect(JSON.parse(m![1])).toBe(CALP_PUSH_SHEET_GONE);
    // The shape the recogniser reads: the code, a colon, then the sentence.
    expect(CALP_RUST).toContain('"{CALP_PUSH_SHEET_GONE}: {subject} no longer in the workbook');
  });

  // SABOTAGE: drop `plainSheetGoneSentence` from describeBackendRefusal -- the
  // code reaches the preview's and the diff's screens again.
  it("becomes its plain sentence in every shape a rejection takes, for every door", () => {
    for (const what of ["published", "previewed", "compared"]) {
      for (const subject of ["The sheet 'Private' you ticked is", "The sheet you ticked is", "2 of the sheets you ticked are"]) {
        const refusal = gone(subject, what);
        const plain = refusal.slice(`${CALP_PUSH_SHEET_GONE}: `.length);
        for (const err of [refusal, new Error(refusal), { message: refusal }, `Publish failed: ${refusal}`]) {
          expect(isSheetGoneRefusal(err), refusal).toBe(true);
          expect(describeBackendRefusal(err), refusal).toBe(plain);
          expect(describeBackendRefusal(err)).not.toContain(CALP_PUSH_SHEET_GONE);
        }
      }
    }
  });

  // SABOTAGE: make isWorkbookChangedWhileSaving also match CALP_PUSH_SHEET_GONE
  // -- every dialog would then offer a "Try again" that can never succeed.
  it("is never the retryable snapshot refusal, and that one is never it", () => {
    const refusal = gone("The sheet 'Private' you ticked is", "published");
    expect(isWorkbookChangedWhileSaving(refusal)).toBe(false);
    expect(isSheetGoneRefusal(`${WORKBOOK_CHANGED_WHILE_SAVING}: the workbook changed while it was being saved.`)).toBe(false);
  });

  it("a code with no sentence after it still reads as a sentence", () => {
    expect(isSheetGoneRefusal(`${CALP_PUSH_SHEET_GONE}:`)).toBe(true);
    const shown = describeBackendRefusal(`${CALP_PUSH_SHEET_GONE}:   `);
    expect(shown).not.toContain(CALP_PUSH_SHEET_GONE);
    expect(shown).toMatch(/no longer in the workbook/);
  });

  it("look-alikes are not it, and stay exactly as they were", () => {
    for (const err of [
      "XCALP_PUSH_SHEET_GONE: something else",
      "CALP_PUSH_SHEET_GONE_LATER: something else",
      "CALP_PUSH_SHEET_GONE without its colon",
      "CALP_PUSH_SHEET_WITHOUT_ID: the sheet 'X' has no stable id",
    ]) {
      expect(isSheetGoneRefusal(err), err).toBe(false);
      expect(describeBackendRefusal(err), err).toBe(err);
    }
  });
});

// THE PAST-THE-END REFUSAL (review round 10). A request that names its sheets
// BY POSITION and asks for one past the end of the sheet list used to get the
// RETRYABLE snapshot refusal -- "the workbook changed ... try again" -- even
// when nothing had changed (a script counting from 1), so every retry met the
// same refusal and the push dialog's positions-only fallback offered a Try
// again that could never succeed. Rust now refuses it with
// `CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE: There is no sheet at index N: ...`,
// which is NOT retryable: the list has to be read again.
describe("the past-the-end refusal: plain words, and never retryable", () => {
  /** One door's refusal, shaped as Rust's `sheet_index_out_of_range_refusal` formats it. */
  const pastEnd = (past: number, has: string, what: string): string =>
    `${CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE}: There is no sheet at index ${past}: the workbook has ${has}. ` +
    `Nothing was ${what}; read the sheet list again and choose the sheets again.`;

  // SABOTAGE: respell the TypeScript constant (or the pattern) -- Rust's code
  // then reaches a person raw, and the dialog offers no re-read.
  it("is spelled exactly as calp_commands.rs spells it, and Rust puts its sentence after the code and a colon", () => {
    const m = CALP_RUST.match(/pub\(crate\) const CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE: &str = ("[^"]*");/);
    expect(m, "calp_commands.rs no longer declares CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE").toBeTruthy();
    expect(JSON.parse(m![1])).toBe(CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE);
    // The shape the recogniser reads: the code, a colon, then the sentence.
    expect(CALP_RUST).toContain('"{CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE}: There is no sheet at index {past}');
  });

  // SABOTAGE: drop `plainSheetIndexOutOfRangeSentence` from
  // describeBackendRefusal -- the code reaches the preview's, the diff's and
  // every other screen that asks here.
  it("becomes its plain sentence in every shape a rejection takes, for every door", () => {
    for (const what of ["published", "previewed", "compared", "merged"]) {
      for (const [past, has] of [
        [3, "3 sheets (indexes 0 to 2)"],
        [1, "1 sheet (index 0)"],
        [0, "no sheets"],
      ] as const) {
        const refusal = pastEnd(past, has, what);
        const plain = refusal.slice(`${CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE}: `.length);
        for (const err of [refusal, new Error(refusal), { message: refusal }, `Publish failed: ${refusal}`]) {
          expect(isSheetIndexOutOfRangeRefusal(err), refusal).toBe(true);
          expect(describeBackendRefusal(err), refusal).toBe(plain);
          expect(describeBackendRefusal(err)).not.toContain(CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE);
        }
      }
    }
  });

  // SABOTAGE: make isWorkbookChangedWhileSaving also match this code -- every
  // dialog would then offer a "Try again" that resends the same positions.
  it("is never the retryable snapshot refusal, nor the gone-sheet refusal, and neither of those is it", () => {
    const refusal = pastEnd(3, "3 sheets (indexes 0 to 2)", "published");
    expect(isWorkbookChangedWhileSaving(refusal)).toBe(false);
    expect(isSheetGoneRefusal(refusal)).toBe(false);
    expect(
      isSheetIndexOutOfRangeRefusal(`${WORKBOOK_CHANGED_WHILE_SAVING}: the workbook changed while it was being saved.`),
    ).toBe(false);
    expect(
      isSheetIndexOutOfRangeRefusal(`${CALP_PUSH_SHEET_GONE}: The sheet you ticked is no longer in the workbook.`),
    ).toBe(false);
  });

  it("a code with no sentence after it still reads as a sentence, never the code", () => {
    expect(isSheetIndexOutOfRangeRefusal(`${CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE}:`)).toBe(true);
    const shown = describeBackendRefusal(`${CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE}:   `);
    expect(shown).not.toContain(CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE);
    expect(shown).toMatch(/read the sheet list again/i);
  });

  it("look-alikes are not it, and stay exactly as they were", () => {
    for (const err of [
      "XCALP_PUSH_SHEET_INDEX_OUT_OF_RANGE: something else",
      "CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE_LATER: something else",
      "CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE without its colon",
      "Sheet index 4 out of range",
    ]) {
      expect(isSheetIndexOutOfRangeRefusal(err), err).toBe(false);
      expect(describeBackendRefusal(err), err).toBe(err);
    }
  });
});
