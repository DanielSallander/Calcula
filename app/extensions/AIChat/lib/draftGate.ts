//! FILENAME: app/extensions/AIChat/lib/draftGate.ts
// PURPOSE: Put the validation ladder in front of `draft_object_script`, so a
//          script the model gets wrong never reaches the user's review queue.
// CONTEXT: docs/design/local-model-script-authoring.md §5, §11.2.
//
//          THE CHAT ALREADY HAS A REPAIR LOOP — the agentic tool loop. So this
//          needs no new machinery: when a draft fails validation the gate
//          returns the repair text AS THE TOOL RESULT, the model reads it like
//          any other tool output, fixes the script and calls the tool again.
//          Bolting the standalone `authorScript` loop in beside it would have
//          meant two repair loops disagreeing about whose turn it was.
//
//          WHY GATE AT ALL. `draft_object_script` queues a script for a HUMAN to
//          read and mount. Every wrong draft that reaches that queue spends a
//          person's attention on something a machine could have rejected in a
//          millisecond — and, measured against two real local models, roughly
//          half of what they produce is wrong in a way the ladder can see.
//
//          NOTICES NEVER BLOCK (§11.2). A capability declared but not observed
//          is information for the reviewer, not a defect; feeding it back would
//          teach the model to strip declarations it cannot prove it needs.

import { validateScriptSource, repairPrompt } from "@api/scriptHost/scriptValidation";
// `@api/types`, NOT the `@api` barrel. The barrel is 2600 lines of grid context,
// script host and Tauri doors, and every AIChat suite that reaches it mocks it by
// hand -- draftGate.test.ts does not, because this module never needed it.
// `@api/types` re-exports the SAME function (app/src/api/types.ts:70) and imports
// nothing itself, so no suite has to learn a new double.
import { columnToLetter } from "@api/types";
// The user-facing wording, shared with the Object Script Editor's diff window.
import { unexercisedHookNote } from "@api/scriptHost/scriptPreview/unexercisedHooks";
// The report's shape is declared once, beside the authoring loop that also
// consumes it. A second mirror here would be one more thing to drift from
// `DryRunReport` in ai/dryrun.rs.
import type { DryRunReport } from "@api/scriptHost/scriptAuthoring";
// TYPE-ONLY, and the module it names imports nothing at all, so this costs the
// gate's own suite no new double.
import type { RunNotice } from "@api/scriptHost/authoringRun";
import { previewObjectScript } from "@api/scriptHost/scriptPreview";

/** What the gate decided about one tool call. */
export interface GateVerdict {
  /** True when the call may proceed to the backend. */
  allow: boolean;
  /** When `allow` is false, the text handed back to the model as a tool result. */
  message?: string;
  /**
   * FOR THE MODEL. Appended to the tool result so the next turn knows what the
   * draft would DO ("would change 3 cells (B2, B3)") rather than only that it
   * was queued.
   *
   * It may address the model in the second person — "Tell the user they must
   * raise the access level" — which is exactly why it must never be rendered
   * into the transcript. `userNote` is the human's copy of the same fact.
   */
  note?: string;
  /**
   * FOR THE USER. The same observation, worded for the person reading the
   * transcript, and the field a UI must render.
   *
   * Set on EVERY allowing arm that has anything to say, including the ones where
   * it is identical to `note`, so a caller reads one field and never has to know
   * which arm produced the verdict.
   */
  userNote?: string;
  /**
   * The draft is sound but only ran once the preview was raised to Unlocked.
   *
   * A permission only the USER can grant, so the transcript line is a WARNING
   * rather than a neutral status: without the grant the script mounts and does
   * nothing. Never a rejection (§11.2's "notices never block").
   */
  needsUnlocked?: boolean;
  /**
   * The ladder's NOTICES — today, capabilities the script declares that no call
   * in it appears to need.
   *
   * §11.2 makes these information for the reviewer rather than a defect, because
   * a machine cannot decide them and a person can. The gate then threw the whole
   * report away the instant `ok` was true, so the person they were written for
   * never saw a word of them — while pressing Save is precisely the act of
   * granting them. Absent, not empty, when there are none.
   *
   * EACH ONE CARRIES ITS CODE: the ladder now raises notices about more than
   * declarations, and a renderer has to be able to tell which heading one
   * belongs under.
   */
  notices?: RunNotice[];
}

const ALLOW: GateVerdict = { allow: true };

/**
 * Run a candidate through the dry run, tolerating a preview that cannot run.
 *
 * A dry run that cannot RUN must not block a draft: a gate that turns its own
 * failure into a rejection would make the chat refuse work for a reason the
 * user cannot act on. Returns null when no verdict could be reached, which the
 * caller treats as "no objection".
 *
 * WHY THIS NO LONGER CALLS `ai_dry_run_script`. That command runs in the Rust
 * QuickJS realm, which rejects `export` and shares a small fraction of the
 * Worker realm's `context` — so it declined every source this gate ever handed
 * it, correctly and unconditionally, and L3 was dead here. It remains the right
 * rung for a ONE-OFF script, which is that realm's own language; it was simply
 * never the right rung for an object script. `previewObjectScript` runs the
 * draft in the realm it will actually be mounted into, against a copy of the
 * workbook (§5c).
 *
 * HOOKS ARE FIRED OPPORTUNISTICALLY. This gate has no task description and
 * cannot know what the draft is FOR, but it knows the object type — a required
 * field of `draft_object_script` — and the object type determines which hooks
 * exist. So the preview offers all of them and fires exactly the ones the draft
 * registered, skipping the rest in silence. Worth doing because a handler that
 * throws is invisible to `setup` alone, and because `context.expose('onClick',
 * …)` — the shape every early draft used — mounts perfectly and never receives
 * a click.
 */
async function tryDryRun(
  source: string,
  objectType: string,
  tier: "restricted" | "unlocked",
): Promise<DryRunReport | null> {
  try {
    return await previewObjectScript({ source, objectType, tier });
  } catch {
    return null;
  }
}

/**
 * The note appended when a draft only runs at the unlocked tier.
 *
 * Exported so the test asserts the real string rather than a copy of it.
 */
export const NEEDS_UNLOCKED =
  " NOTE: this script does NOT run at the Restricted access level a draft is mounted with — it " +
  "only ran once the preview was raised to Unlocked. Tell the user they must raise the script's " +
  "access level to Unlocked in the Object Script Editor before it will work.";

/**
 * The same fact, said to the PERSON reading the transcript.
 *
 * Second person, and no "Tell the user" — a line relayed from the model's own
 * instructions reads to its subject as being talked about rather than to.
 */
export const NEEDS_UNLOCKED_USER =
  " NOTE: this script does NOT run at the Restricted access level a draft is mounted with — it " +
  "only ran once the preview was raised to Unlocked. Raise the script's access level to Unlocked " +
  "in the Object Script Editor before mounting it, or it will do nothing.";

/**
 * The object type the draft targets, or undefined when the call named none.
 *
 * WHY THIS NO LONGER DEFAULTS. The answer now feeds the VALIDATOR as well as the
 * preview, and the two want opposite things from a missing value. The preview
 * must run as something, so it falls back to "button" at the call site. The
 * validator must not: narrowing an unlabelled draft to a button's context would
 * REJECT a correct sheet script for a type nobody claimed, and this is a linter
 * — its worst outcome must be missing a defect, never inventing one.
 *
 * `object_type` is REQUIRED by the tool schema and constrained to
 * `DRAFT_OBJECT_TYPES`, so in practice it is always present and always valid;
 * this covers the malformed call the gate deliberately does not police
 * (`validate_draft` in mcp/drafts.rs answers that clearly).
 */
function objectTypeOf(input: unknown): string | undefined {
  const raw = (input as { object_type?: unknown } | null)?.object_type;
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

/**
 * Decide whether a tool call may proceed.
 *
 * Only `draft_object_script` is gated. `run_script` is deliberately NOT: it is
 * the execute-now path the user asked for explicitly, it is undoable, and
 * refusing it on a static check would be the chat second-guessing a direct
 * instruction. The draft path is different precisely because its output is
 * queued for someone to read.
 */
export async function gateToolCall(name: string, input: unknown): Promise<GateVerdict> {
  if (name !== "draft_object_script") return ALLOW;

  // Only a real, non-empty STRING is worth validating. A missing or non-string
  // `source` is malformed input, and `validate_draft` in mcp/drafts.rs already
  // answers that clearly — whereas coercing `42` to a script and reporting that
  // it "defines no setup function" would be a confusing critique of a type
  // error.
  const raw = (input as { source?: unknown } | null)?.source;
  if (typeof raw !== "string" || raw.trim() === "") return ALLOW;
  const source = raw;

  // Read BEFORE the static ladder, not just before the dry run: L1 cannot tell
  // `context.onSheetChange` (WorkbookContext only) or `context.cell.setValue`
  // (only a sheet or a table can obtain a cell) from a member this object really
  // has without it, and a button draft using either validated CLEAN and threw at
  // mount.
  const objectType = objectTypeOf(input);
  /** The dry run must run as SOMETHING; an unlabelled draft is previewed as a button. */
  const previewType = objectType ?? "button";

  // L0-L2: parse, reach, capabilities.
  const report = validateScriptSource(source, objectType);
  if (!report.ok) {
    return {
      allow: false,
      message:
        "The script was NOT queued for review — it does not pass Calcula's checks.\n\n" +
        repairPrompt(report) +
        "\n\nFix these and call draft_object_script again.",
    };
  }

  // THE OTHER HALF OF THE REPORT, which nothing read. §11.2 makes "declared but
  // not observed" a NOTICE because a machine cannot decide it and a person can --
  // and then this gate threw the report away the instant `ok` was true, so the
  // person it was written for never saw a word of it. Those are exactly the
  // capabilities the reviewer grants by pressing Save.
  //
  // SELECTED by severity, CARRIED with its code. Selecting by severity is what
  // picks up every notice the ladder ever grows; carrying the code is what stops
  // the renderer printing all of them under one heading. As of 2026-08-26 the
  // ladder raises a `no-run-target` notice, and under "check what it declares"
  // it would tell the author their capability pragmas were wrong.
  const notices: RunNotice[] = report.findings
    .filter((f) => f.severity === "notice")
    .map((f) => ({ code: f.code, message: f.message }));

  // L3: does it actually run?
  //
  // `applicable === false` means the preview realm cannot host this script, so
  // its answer describes the emulator rather than the draft.
  //
  // AT THE TIER IT ACTUALLY MOUNTS AT. `previewObjectScript` defaults to
  // "unlocked" while `draftToScriptDefinition` mounts every draft "restricted".
  const dry = await tryDryRun(source, previewType, "restricted");

  if (dry && dry.applicable !== false && !dry.ok) {
    // THE DIAGNOSIS IS A DEDUCTION, NOT A REGEX. Re-run at the unlocked tier: it
    // is the only thing that changed.
    const unlocked = await tryDryRun(source, previewType, "unlocked");
    if (unlocked && unlocked.applicable !== false && unlocked.ok) {
      // ALLOWED, NOT REJECTED (§11.2's "notices never block"). The script is
      // sound; it needs a permission only the USER can grant -- which is why a
      // sentence that reaches nobody but the model does nothing, and why the
      // model's copy ("Tell the user they must raise...") is not a thing to put
      // in front of the person it is about.
      const observed = describeDryRun(unlocked);
      return {
        allow: true,
        needsUnlocked: true,
        note: observed + NEEDS_UNLOCKED,
        userNote: observed + NEEDS_UNLOCKED_USER,
        ...(notices.length > 0 ? { notices } : {}),
      };
    }
    return {
      allow: false,
      message:
        "The script was NOT queued for review. It passes every static check but FAILS when run " +
        `against a copy of the workbook:\n  ${dry.error ?? "unknown error"}\n\n` +
        "Fix the runtime error and call draft_object_script again.",
    };
  }

  const note = describeDryRun(dry);
  // ALLOW is the shared constant every ungated call returns: an arm that carries
  // something must build its own object rather than mutate that one.
  if (!note && notices.length === 0) return ALLOW;
  const verdict: GateVerdict = { allow: true };
  if (note) {
    verdict.note = note;
    // Identical to `note` on this path -- nothing in `describeDryRun` addresses
    // the model -- but set EXPLICITLY so the caller reads ONE field and never has
    // to know which arm the verdict came from.
    verdict.userNote = note;
  }
  if (notices.length > 0) verdict.notices = notices;
  return verdict;
}

/**
 * How many changed cells the note names before it stops.
 *
 * Three, because this is ONE line in a transcript and in a tool result. The
 * report's own list is capped far higher (MAX_REPORTED_CHANGES = 200), so
 * `changes` can be shorter than `totalChanges` and the sentence must never imply
 * it is the whole story.
 */
const MAX_NAMED_CELLS = 3;

/**
 * A one-line note about what the draft would do, appended to the tool result and
 * shown to the user as its own transcript line.
 *
 * IT NAMES CELLS, not just a count. `changes` is the one field that says what the
 * script actually DID -- computed cell by cell, sorted row-major -- and nothing
 * read it: the reviewer was told "it would change 3 cells" and had to open the
 * editor to find out which three.
 *
 * IT REFUSES TO SAY "changed no cells" ALONE when a handler the script registered
 * was never fired. That zero is a fact about the PREVIEW, not about the script,
 * and the bare sentence is read by the model as evidence -- it will "fix" a draft
 * whose only problem is that the preview could not exercise it.
 */
export function describeDryRun(dry: DryRunReport | null): string {
  // Say nothing rather than "it changed no cells" about a script that was never
  // run — that sentence reads as a finding, and it would be fabricated.
  if (!dry || !dry.ok || dry.applicable === false) return "";
  const caveat = unexercisedHookNote(dry.unexercisedHooks);
  if (dry.totalChanges === 0) {
    return caveat
      // SECOND PERSON, not "Tell the user to...". This return value is stored
      // as `userNote` as well as `note`, and ChatView renders `userNote`
      // straight into the transcript — so model-facing phrasing here reaches
      // the person as an instruction addressed to somebody else. Byte-compatible
      // with the sibling wording in `scriptPreview/dryRunCaveat.ts`, deliberately.
      ? ` When run against a copy of the workbook it changed no cells — but that is not evidence ` +
          `about the script. ${caveat} Try it on real data before relying on it.`
      : " When run against a copy of the workbook it changed no cells.";
  }
  // Guarded on the LIST, never on the count: a report can legitimately arrive
  // with a count and no entries, and inventing "(A1)" for one would be worse
  // than the bare count. The count clause is unchanged either way.
  const named = dry.changes
    .slice(0, MAX_NAMED_CELLS)
    .map((c) => `${columnToLetter(c.col)}${c.row + 1}`);
  const where =
    named.length > 0
      ? ` (${named.join(", ")}${dry.totalChanges > named.length ? ", ..." : ""})`
      : "";
  const changed =
    ` When run against a copy of the workbook it would change ${dry.totalChanges} cell${
      dry.totalChanges === 1 ? "" : "s"
    }${where}.`;
  return caveat ? `${changed} ${caveat}` : changed;
}
