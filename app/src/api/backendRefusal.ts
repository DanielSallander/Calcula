//! FILENAME: app/src/api/backendRefusal.ts
// PURPOSE: Recognise the backend's RETRYABLE snapshot refusal
//          (`WORKBOOK_CHANGED_WHILE_SAVING`) and turn a backend error into the
//          text a person reads: that refusal's plain sentence with its internal
//          code stripped, and every other error exactly as it always was.
// CONTEXT: Rust refuses a save, an AutoRecover tick, a publish, its preview, the
//          working-copy diff and the merge (`take_consistent_snapshot`,
//          app/src-tauri/src/persistence.rs) with
//
//            WORKBOOK_CHANGED_WHILE_SAVING: the workbook changed while it was
//            being <what> -- a sheet was added, deleted or moved during each of
//            3 attempts to read it. Nothing was written; try again.
//
//          when a sheet renumbering -- an agent's delete or move, a
//          drill-through sheet appearing -- kept landing inside the snapshot.
//          The code is for BRANCHING (retry, count); the sentence is for people.
//          No screen recognised it, so the push dialog showed the raw code,
//          which its own doc comment says users must never see.
//
//          ONE RECOGNISER. Every display site (File > Save / Save As, the close
//          prompt's Save, Encryption, the push dialog's push / preview / diff /
//          merge, the code summary, the Application Explorer's preview, the
//          subscriber diff) and the AutoRecover streak ask here, so the code is
//          spelled in exactly one TypeScript place -- pinned against the Rust
//          constant by src/api/__tests__/backendRefusal.test.ts, which reads
//          persistence.rs (the direction is Rust -> TypeScript, never back).
//
//          Its own module, never the @api barrel: a test that doubles "@api"
//          with a flat factory must not be able to double the recogniser away.
//
//          A SECOND REFUSAL LIVES HERE, AND IT IS NOT RETRYABLE (review round
//          9). The publish doors -- the push, its preview, the working-copy and
//          subscriber diffs -- now take the ticked sheets by STABLE ID
//          (`sheetIds`), and refuse an id that names no sheet of the workbook
//          with `CALP_PUSH_SHEET_GONE: <sentence>`: the author deleted a ticked
//          sheet while the non-modal dialog was open, or an agent did. Sending
//          the same ids again cannot succeed -- the list has to be read again
//          -- so `isWorkbookChangedWhileSaving` stays false for it and nothing
//          offers "Try again"; `isSheetGoneRefusal` says which it is, and
//          `describeBackendRefusal` says both in plain words.
//
//          A THIRD, ALSO NOT RETRYABLE (review round 10). A request that names
//          its sheets BY POSITION -- a script (`caps.publish.package`), an e2e
//          helper, the push dialog's fallback for a ticked row listed without
//          an id; there is no command-line publish -- and asks for a position
//          past the end of the sheet list is refused with
//          `CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE: There is no sheet at index N:
//          ...`. It used to be the retryable refusal, which said the workbook
//          had changed and to try again even when nothing had changed (a script
//          counting its sheets from 1), so every retry met the same refusal.
//          The same positions can never succeed -- the list has to be read
//          again and the sheets chosen again -- so `isWorkbookChangedWhileSaving`
//          stays false for it too; `isSheetIndexOutOfRangeRefusal` says which
//          it is, and `describeBackendRefusal` strips its code like the others.

/** The stable code Rust prefixes the refusal with (`persistence::WORKBOOK_CHANGED_WHILE_SAVING`). */
export const WORKBOOK_CHANGED_WHILE_SAVING = "WORKBOOK_CHANGED_WHILE_SAVING";

/**
 * The stable code Rust refuses a publish door with when the request named a
 * sheet by its stable id that is no longer in the workbook. NOT retryable.
 */
export const CALP_PUSH_SHEET_GONE = "CALP_PUSH_SHEET_GONE";

/**
 * The stable code Rust refuses a publish door with when the request named a
 * sheet by POSITION (0-based) past the end of the workbook's sheet list
 * (`calp_commands::CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE`). NOT retryable.
 */
export const CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE = "CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE";

/**
 * The code, then its colon, then the sentence. Anywhere in the text, so the
 * same refusal is recognised raw (Tauri rejects with the bare string), inside
 * an Error ("Error: WORKBOOK_...") and behind a caller's own prefix. The word
 * boundary keeps a longer code that merely ends in these letters out.
 */
const REFUSAL = /\bWORKBOOK_CHANGED_WHILE_SAVING:[ \t]*([\s\S]*)$/;

/** Said when the backend sent the code with no sentence after it. */
const SENTENCE_WHEN_MISSING =
  "The workbook changed while it was being read, so nothing was written. Try again.";

/** The gone-sheet refusal, read exactly the way {@link REFUSAL} is. */
const SHEET_GONE = /\bCALP_PUSH_SHEET_GONE:[ \t]*([\s\S]*)$/;

/** Said when the backend sent the gone-sheet code with no sentence after it. */
const SHEET_GONE_WHEN_MISSING =
  "A sheet you ticked is no longer in the workbook, so nothing was done. " +
  "Open the dialog again to see the current sheets.";

/** The past-the-end refusal, read exactly the way {@link REFUSAL} is. */
const SHEET_INDEX_OUT_OF_RANGE = /\bCALP_PUSH_SHEET_INDEX_OUT_OF_RANGE:[ \t]*([\s\S]*)$/;

/** Said when the backend sent the past-the-end code with no sentence after it. */
const SHEET_INDEX_OUT_OF_RANGE_WHEN_MISSING =
  "A sheet was asked for by a position the workbook's sheet list does not have, so nothing was done. " +
  "Read the sheet list again and choose the sheets again.";

/** The text a rejection carries: the bare string, an Error's message, or an error-shaped object's. */
function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(err);
}

/**
 * The sentence after `pattern`'s code, capitalised -- or `whenMissing` when the
 * code came with no sentence -- or null when `err` does not carry the code.
 */
function plainSentence(pattern: RegExp, whenMissing: string, err: unknown): string | null {
  const match = pattern.exec(messageOf(err));
  if (!match) return null;
  const sentence = match[1].trim();
  if (sentence === "") return whenMissing;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The refusal's plain sentence, or null when `err` is not the refusal. */
function plainRefusalSentence(err: unknown): string | null {
  return plainSentence(REFUSAL, SENTENCE_WHEN_MISSING, err);
}

/** The gone-sheet refusal's plain sentence, or null when `err` is not it. */
function plainSheetGoneSentence(err: unknown): string | null {
  return plainSentence(SHEET_GONE, SHEET_GONE_WHEN_MISSING, err);
}

/** The past-the-end refusal's plain sentence, or null when `err` is not it. */
function plainSheetIndexOutOfRangeSentence(err: unknown): string | null {
  return plainSentence(SHEET_INDEX_OUT_OF_RANGE, SHEET_INDEX_OUT_OF_RANGE_WHEN_MISSING, err);
}

/**
 * Is `err` the backend's retryable snapshot refusal? Nothing was written, and
 * the same act normally succeeds when it is simply tried again.
 */
export function isWorkbookChangedWhileSaving(err: unknown): boolean {
  return plainRefusalSentence(err) !== null;
}

/**
 * Is `err` the refusal of a request that named, by stable id, a sheet the
 * workbook no longer has (`CALP_PUSH_SHEET_GONE`)? Nothing was published,
 * previewed or compared, and the SAME request can never succeed: the caller
 * reads the sheet list again rather than offering a retry.
 */
export function isSheetGoneRefusal(err: unknown): boolean {
  return plainSheetGoneSentence(err) !== null;
}

/**
 * Is `err` the refusal of a request that named, by 0-based POSITION, a sheet
 * past the end of the workbook's sheet list
 * (`CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE`)? Nothing was published, previewed or
 * compared, and the SAME positions can never succeed: the caller reads the
 * sheet list again and chooses again rather than offering a retry.
 */
export function isSheetIndexOutOfRangeRefusal(err: unknown): boolean {
  return plainSheetIndexOutOfRangeSentence(err) !== null;
}

/**
 * A backend error as the person should read it.
 *
 * The retryable snapshot refusal, the gone-sheet refusal and the past-the-end
 * refusal each become their plain sentence -- the code stripped, the first
 * letter capitalised -- and ANY OTHER ERROR comes back exactly as
 * `String(err)` would have shown it, so a screen that switches to this changes
 * nothing about the errors it already showed.
 */
export function describeBackendRefusal(err: unknown): string {
  return (
    plainRefusalSentence(err) ??
    plainSheetGoneSentence(err) ??
    plainSheetIndexOutOfRangeSentence(err) ??
    String(err)
  );
}
