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
// The report's shape is declared once, beside the authoring loop that also
// consumes it. A second mirror here would be one more thing to drift from
// `DryRunReport` in ai/dryrun.rs.
import type { DryRunReport } from "@api/scriptHost/scriptAuthoring";
import { previewObjectScript } from "@api/scriptHost/scriptPreview";

/** What the gate decided about one tool call. */
export interface GateVerdict {
  /** True when the call may proceed to the backend. */
  allow: boolean;
  /** When `allow` is false, the text handed back to the model as a tool result. */
  message?: string;
  /**
   * When `allow` is true and a dry run produced a usable observation, a
   * one-line note the caller APPENDS to the tool result — so the model and the
   * transcript say something concrete ("would change 3 cells") instead of just
   * "queued". `describeDryRun` existed for exactly this and was dead code until
   * the adversarial review noticed nothing ever called it.
   */
  note?: string;
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
 * `onClick` is fired OPPORTUNISTICALLY: this gate has no task description and
 * cannot know what the draft is for, so the hook is fired when the script
 * registered it and skipped in silence when it did not. It is worth firing
 * because a handler that throws is invisible to `setup` alone — and because
 * `context.expose('onClick', …)`, the shape every early draft used, mounts
 * perfectly and never receives a click.
 */
async function tryDryRun(source: string): Promise<DryRunReport | null> {
  try {
    return await previewObjectScript({
      source,
      objectType: "button",
      event: "onClick",
      eventOptional: true,
    });
  } catch {
    return null;
  }
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

  // L0-L2: parse, reach, capabilities.
  const report = validateScriptSource(source);
  if (!report.ok) {
    return {
      allow: false,
      message:
        "The script was NOT queued for review — it does not pass Calcula's checks.\n\n" +
        repairPrompt(report) +
        "\n\nFix these and call draft_object_script again.",
    };
  }

  // L3: does it actually run?
  //
  // `applicable === false` means the preview realm cannot host this script, so
  // its answer describes the emulator rather than the draft. Object scripts —
  // which is everything this gate sees — land there, and treating that as a
  // failure rejected every valid draft with "it FAILS when run".
  const dry = await tryDryRun(source);
  if (dry && dry.applicable !== false && !dry.ok) {
    return {
      allow: false,
      message:
        "The script was NOT queued for review. It passes every static check but FAILS when run " +
        `against a copy of the workbook:\n  ${dry.error ?? "unknown error"}\n\n` +
        "Fix the runtime error and call draft_object_script again.",
    };
  }

  const note = describeDryRun(dry);
  return note ? { allow: true, note } : ALLOW;
}

/**
 * A one-line note about what the draft would do, appended to the tool result so
 * the model — and the transcript — say something concrete rather than "queued".
 *
 * Deliberately separate from the gate: this runs only for drafts that PASSED,
 * and it is descriptive, never a rejection.
 */
export function describeDryRun(dry: DryRunReport | null): string {
  // Say nothing rather than "it changed no cells" about a script that was never
  // run — that sentence reads as a finding, and it would be fabricated.
  if (!dry || !dry.ok || dry.applicable === false) return "";
  if (dry.totalChanges === 0) {
    return " When run against a copy of the workbook it changed no cells.";
  }
  return ` When run against a copy of the workbook it would change ${dry.totalChanges} cell${
    dry.totalChanges === 1 ? "" : "s"
  }.`;
}
