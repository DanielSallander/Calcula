//! FILENAME: app/src/api/scriptHost/authoringRun/index.ts
// PURPOSE: ONE record of one authoring run — what was asked, what the model
//          said, what the checks found, how it ended, and what the author then
//          decided — plus the wording that turns it into a sentence.
// CONTEXT: 2026-08-26, from a single report: "I saw the diff page (it looked
//          nice), however it did not change anything (maybe that was as it
//          should be) but I could not see the reasoning or the results from the
//          chat."  Two defects in one sentence.
//
//          ONE TYPE, NOT TWO. The live diff and the persisted history are the
//          same record read at two moments, so they are the same type. Two
//          near-identical run records — one for the wire, one for the log — is
//          the drift this file exists to prevent.
//
//          TWO ENUMS, NOT ONE. `outcome` says how the RUN ended; `decision`
//          says what the AUTHOR did about it. Collapsing them is the same
//          "two facts, one string" bug that let a script the model handed back
//          untouched and a script the author had edited underneath it show the
//          identical sentence.
//
//          NO IMPORTS. Both windows value-import this leaf directly
//          (`authorRunner` in main, `AiEditStrip`/`AiEditDiff` in the editor
//          window); the `@api` barrel reaches it only through type-only edges
//          that `verbatimModuleSyntax` erases. A wording leaf must not drag a
//          dependency graph behind it.

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** How the RUN ended. Nothing here is a statement about what the author did. */
export type RunOutcome =
  | "changed"    // a proposal that differs from the base
  | "unchanged"  // EDIT: the model read it and returned it as it was
  | "stalled"    // the same errors twice running; more patience will not help
  | "exhausted"  // the repair rounds ran out
  | "failed"     // the run threw
  | "cancelled"  // the author pressed Stop
  | "refused";   // it never started — no provider, no model, no route

/**
 * What the AUTHOR did about it.
 *
 * ABSENT UNTIL THEY ACT — and for a CREATE run, forever: it is persisted at
 * draft delivery under the `draft-*` id with `decision` unset, and it stays
 * unset, because Save only re-keys the bucket onto the saved script's id
 * (adoption IS the record that the draft was kept; the save path filters
 * un-adopted `draft-*` buckets out of the archive, so they die with the
 * session). An EDIT run is not persisted before a decision — only the
 * Accept/Reject/Save handlers write, decision included, and a persisted
 * rejection dirties the workbook like any other append (owner decision: a
 * rejection is exactly the provenance worth keeping). What must stay true: an
 * `objscript:ai-edit-result` event — a Tauri channel — must not be able to
 * write into a persisted store on its own.
 */
export type RunDecision = "accepted" | "rejected" | "saved";

export interface RunFinding {
  severity: "error" | "notice";
  /** The validator's stable machine code, so a reader can PARTITION notices. */
  code: string;
  message: string;
}

/**
 * A notice on its way to a PERSON, carrying the code that says which kind it is.
 *
 * WHY THE CODE TRAVELS. Both surfaces that render notices filtered by SEVERITY
 * and printed the lot under one heading — "check what it declares" — so the
 * moment the ladder grew a notice about something else ("you will not be able
 * to press Run on this"), it arrived under a heading telling the author their
 * capability pragmas were wrong. A channel reused for a payload it was not
 * shaped for is the same family of bug as `expose('onClick')`.
 *
 * `AuthoringRun.notices` stays whole sentences: it is mirrored in Rust and read
 * back as a log, where there is nothing left to partition.
 */
export interface RunNotice {
  /** The validator's stable machine code, e.g. `declared-not-observed`. */
  code: string;
  message: string;
}

export interface RunDryRun {
  applicable: boolean;
  ok: boolean;
  changedCells: number;
  error?: string;
  declinedReason?: string;
}

export interface RunAttempt {
  /** 1-based, the way the log says it. */
  attempt: number;
  /** Milliseconds since the run started. A long gap is visible AS a gap. */
  at: number;
  /** Wall clock for this attempt. Six minutes and thirty-five seconds is a
   *  measured figure on a local 9B, and "it was running for some time" becomes
   *  a fact rather than a feeling. */
  durationMs: number;
  ok: boolean;
  /** The model's WHOLE reply, capped. Never `extractScript(reply)`. */
  reply: string;
  /** True length before capping, so an elision is legible as one. */
  replyChars: number;
  /** The prose outside the fence — the model's account of what it did. */
  note: string;
  /** Reasoning deltas, capped. Empty for a model that emits none. */
  reasoning: string;
  reasoningChars: number;
  /** EVERY severity, not just errors: a notice is what tells a reviewer the
   *  script asks for `net.fetch` it never uses. */
  findings: RunFinding[];
  dryRun?: RunDryRun;
}

export interface AuthoringRun {
  runId: string;
  kind: "create" | "edit";
  outcome: RunOutcome;
  decision?: RunDecision;
  /** ISO, set at the same moment as `decision`. */
  decidedAt?: string;
  startedAt: string;
  elapsedMs: number;
  /** The author's own words, verbatim and capped only at absurd lengths. */
  instruction: string;
  objectType: string;
  providerId: string;
  model: string;
  tier: string;
  /** The surface the model was shown, as a size rather than as text: recording
   *  ~13 KB of surface on each of seven rounds is not a log, it is a copy. */
  surfaceTokens: number;
  surfaceTruncated: boolean;
  summary: string;
  attempts: RunAttempt[];
  notices: string[];
  changedNothing: boolean;
  unexercisedHooks: string[];
  /** Set by `clampRun` when anything was elided to fit the caps. */
  elided?: boolean;
}

/** Runs by script id (or by `draft-*` id, before a draft is saved). */
export type ScriptAuthoringLog = Record<string, AuthoringRun[]>;

/** One line of a run log, live or finished. Shared so the two surfaces that
 *  render a run cannot show different accounts of it. */
export interface RunStep {
  at: number;
  kind: "info" | "ok" | "bad" | "done" | "error";
  text: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Caps. Every number here is the MIRROR of a `pub const` in
// core/calcula-format/src/features/script_authoring.rs — Rust is the authority
// (the renderer can be compromised; the Rust clamp is the one that holds), and
// `capsMirrorRust.test.ts` reads that file and fails on any drift.
// ---------------------------------------------------------------------------

export const MAX_REPLY_CHARS = 4000;
export const MAX_REASONING_CHARS = 2000;
export const MAX_INSTRUCTION_CHARS = 2000;
export const MAX_RUNS_PER_SCRIPT = 30;
/** The whole record's prose: the summary, every notice, and every reply, note
 *  and reasoning buffer TOGETHER. Enforced where the record is BUILT, never at
 *  render: a render-side cap still ships the bytes and still lets a verbose
 *  local model wedge the channel. */
export const MAX_RUN_CHARS = 12_000;
export const MAX_LOG_BYTES = 1_048_576;

/** Detail strings: each notice, each finding's message, each unexercised hook,
 *  and a dry run's error / declined reason. */
export const MAX_DETAIL_CHARS = 500;
/** Metadata strings: ids, enums-carried-as-strings, timestamps, provider and
 *  model names, and a finding's severity/code. */
export const MAX_META_CHARS = 200;
/** Attempts kept per run — the EARLIEST, matching the budget's attempt-order
 *  philosophy (what was first asked and first wrong is what a reader wants). */
export const MAX_ATTEMPTS_PER_RUN = 16;
export const MAX_NOTICES_PER_RUN = 50;
export const MAX_FINDINGS_PER_ATTEMPT = 8;
export const MAX_HOOKS_PER_RUN = 16;

/** Keep the head and the tail, and SAY how much went. A half-sentence with no
 *  marker reads as a bug; a marked elision reads as a cap.
 *
 *  THE RESULT IS NEVER LONGER THAN `max`. MEASURED 2026-08-26: the marker alone
 *  is ~35 characters, so for any `max` below that the "elided" string came back
 *  LONGER than the cap it was asked to enforce — and `clampRun`'s budget loop
 *  calls this with `left = 0` for every attempt past the overflow point, so a
 *  seven-attempt record came out at 12,135 characters against a 12,000 cap,
 *  growing by another 35 per extra attempt. A cap that does not cap is not a
 *  defence against a verbose local model wedging the channel; below the marker's
 *  own width the honest answer is a hard cut. */
export function elideMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 40);
  const head = Math.ceil(keep * 0.7);
  const tail = keep - head;
  const dropped = text.length - head - tail;
  const marked = `${text.slice(0, head)}\n... (${dropped} characters omitted) ...\n${text.slice(text.length - tail)}`;
  return marked.length <= max ? marked : text.slice(0, Math.max(0, max));
}

/**
 * Bring one run inside the caps. Per-field first, then the overall budget.
 *
 * EVERY string and EVERY vector is capped — the metadata, the summary, the
 * notices, the findings, the dry-run reasons and the hook names, not just the
 * transcript buffers — so a clamped run has a serialized ceiling a hostile
 * append cannot exceed. Vectors keep their EARLIEST entries, matching the
 * budget's attempt-order philosophy. Byte-for-byte the twin of `clamp_run` in
 * core/calcula-format/src/features/script_authoring.rs, which re-applies all
 * of it on the other side of the IPC boundary.
 *
 * A run that ALREADY fits is returned as the SAME OBJECT with `elided`
 * untouched — an off-by-one that marked an honest log `elided` would make the
 * marker meaningless.
 */
export function clampRun(run: AuthoringRun): AuthoringRun {
  let elided = false;
  const cap = (v: string, max: number): string => {
    if (v.length <= max) return v;
    elided = true;
    return elideMiddle(v, max);
  };
  const capOpt = (v: string | undefined, max: number): string | undefined =>
    v === undefined ? undefined : cap(v, max);
  const bound = <T,>(v: T[], max: number): T[] => {
    if (v.length <= max) return v;
    elided = true;
    return v.slice(0, max); // the EARLIEST entries are the ones kept
  };

  // Metadata. The unions are compile-time only — a hostile payload can put any
  // string in them — so they are capped like everything else and the union
  // types re-asserted after the cap.
  const runId = cap(run.runId, MAX_META_CHARS);
  const kind = cap(run.kind, MAX_META_CHARS) as AuthoringRun["kind"];
  const outcome = cap(run.outcome, MAX_META_CHARS) as RunOutcome;
  const decision = capOpt(run.decision, MAX_META_CHARS) as RunDecision | undefined;
  const decidedAt = capOpt(run.decidedAt, MAX_META_CHARS);
  const startedAt = cap(run.startedAt, MAX_META_CHARS);
  const objectType = cap(run.objectType, MAX_META_CHARS);
  const providerId = cap(run.providerId, MAX_META_CHARS);
  const model = cap(run.model, MAX_META_CHARS);
  const tier = cap(run.tier, MAX_META_CHARS);

  const instruction = cap(run.instruction, MAX_INSTRUCTION_CHARS);
  const summary = cap(run.summary, MAX_REPLY_CHARS);
  let notices = bound(run.notices, MAX_NOTICES_PER_RUN).map((n) => cap(n, MAX_DETAIL_CHARS));
  const unexercisedHooks = bound(run.unexercisedHooks, MAX_HOOKS_PER_RUN)
    .map((h) => cap(h, MAX_DETAIL_CHARS));

  let attempts = bound(run.attempts, MAX_ATTEMPTS_PER_RUN).map((a) => {
    const findings = bound(a.findings, MAX_FINDINGS_PER_ATTEMPT).map((f) => ({
      severity: cap(f.severity, MAX_META_CHARS) as RunFinding["severity"],
      code: cap(f.code, MAX_META_CHARS),
      message: cap(f.message, MAX_DETAIL_CHARS),
    }));
    const dryRun = a.dryRun === undefined ? undefined : {
      ...a.dryRun,
      error: capOpt(a.dryRun.error, MAX_DETAIL_CHARS),
      declinedReason: capOpt(a.dryRun.declinedReason, MAX_DETAIL_CHARS),
    };
    const clamped = {
      ...a,
      reply: cap(a.reply, MAX_REPLY_CHARS),
      note: cap(a.note, MAX_REPLY_CHARS),
      reasoning: cap(a.reasoning, MAX_REASONING_CHARS),
      findings,
    };
    return dryRun === undefined ? clamped : { ...clamped, dryRun };
  });

  // The overall budget, spent headline-first: the summary, then the notices,
  // then the attempts in attempt order — the EARLY entries are the ones a
  // reader wants (what was first asked, what was first wrong), so the tail is
  // what gives ground. The summary is capped at MAX_REPLY_CHARS, well under
  // MAX_RUN_CHARS, so the headline always fits and pays first.
  let spent = summary.length;
  notices = notices.map((n) => {
    if (spent + n.length <= MAX_RUN_CHARS) { spent += n.length; return n; }
    const left = Math.max(0, MAX_RUN_CHARS - spent);
    spent = MAX_RUN_CHARS;
    elided = true;
    return elideMiddle(n, left);
  });
  attempts = attempts.map((a) => {
    const cost = a.reply.length + a.note.length + a.reasoning.length;
    if (spent + cost <= MAX_RUN_CHARS) { spent += cost; return a; }
    const left = Math.max(0, MAX_RUN_CHARS - spent);
    spent = MAX_RUN_CHARS;
    elided = true;
    return { ...a, reply: elideMiddle(a.reply, left), note: "", reasoning: "" };
  });

  if (!elided) return run; // the SAME object: nothing exceeded any cap
  return {
    ...run,
    runId, kind, outcome, decision, decidedAt, startedAt,
    objectType, providerId, model, tier,
    instruction, summary, attempts, notices, unexercisedHooks,
    elided: true,
  };
}

// ---------------------------------------------------------------------------
// Deriving the outcome, and saying it
// ---------------------------------------------------------------------------

/**
 * `ok` IS TESTED FIRST, and that ordering is the whole point.
 *
 * `authorScript` sets `unchanged` on its final `ok: false` return too
 * (scriptAuthoring/index.ts), and `authorRunner` carries it onto its
 * `!result.ok` early return. An `unchanged`-first ordering therefore headlines
 * a run that exhausted every repair round with "This is a real answer, not a
 * failure."
 */
export function outcomeOf(r: { ok: boolean; unchanged?: boolean; stalled?: boolean }): RunOutcome {
  if (!r.ok) return r.stalled ? "stalled" : "exhausted";
  return r.unchanged ? "unchanged" : "changed";
}

export interface VerdictInput {
  outcome: RunOutcome;
  /** The proposal is byte-identical to what is in the buffer RIGHT NOW. */
  identicalToBuffer: boolean;
  /**
   * The buffer has moved since the author pressed Ask.
   *
   * THE INPUT NEITHER SOURCE DESIGN HAD. `unchanged` is measured against the
   * source captured at Ask; `identicalToBuffer` is measured against the buffer
   * now. They diverge for two unrelated reasons — the model round-tripped
   * whitespace, or the author typed during a six-minute run. In the second case
   * Accept REVERTS their typing while the header promises it is a no-op.
   *
   * FALSE means "not known to have moved", never "known not to have moved":
   * a replayed result carries no `askedAgainst`, and an unknown must never be
   * reported as a measurement.
   */
  bufferMovedSinceAsk: boolean;
  model: string;
  attempts: number;
  elapsedMs: number;
}

/** `headline: ""` means "say nothing extra" — the caller's own line stands. */
export function editVerdict(i: VerdictInput): { headline: string; detail: string } {
  const who = i.model ? `${i.model}` : "The model";
  switch (i.outcome) {
    case "unchanged":
      if (i.bufferMovedSinceAsk) {
        return {
          headline: "You have edited this script since you asked.",
          detail:
            `${who} was given the earlier version and returned it unchanged. Accepting would ` +
            "REPLACE what you have typed with that earlier version.",
        };
      }
      if (i.identicalToBuffer) {
        return {
          headline: `${who} read the script and found nothing to change.`,
          detail:
            "This is a real answer, not a failure. Nothing was written, and there is nothing " +
            "to accept.",
        };
      }
      return {
        headline: `${who} returned the same script, reformatted.`,
        detail:
          "The only differences are whitespace and line endings, which a model round-trip " +
          "introduces for free. Nothing about what the script does has changed.",
      };
    case "changed":
      return i.identicalToBuffer
        ? { headline: "Your script already matches what the model proposes.", detail: "" }
        : { headline: "", detail: "" };
    case "stalled":
      return {
        headline: `${who} made the same mistake on every attempt.`,
        detail:
          "Running it again will not help. A larger model, or rewording what you asked for, " +
          "is more likely to.",
      };
    case "exhausted":
      return {
        headline: `${who} could not produce a valid script in ${i.attempts} attempt${i.attempts === 1 ? "" : "s"}.`,
        detail: "The best attempt is below. Nothing has been written to your script.",
      };
    case "refused":
      return {
        headline: "The edit never started.",
        detail: "No model was reached, so nothing was asked and nothing was written.",
      };
    case "cancelled":
      return {
        headline: "You stopped this run.",
        detail: "Nothing was written to your script.",
      };
    case "failed":
    default:
      return {
        headline: "The run did not finish.",
        detail: "Nothing was written to your script.",
      };
  }
}
