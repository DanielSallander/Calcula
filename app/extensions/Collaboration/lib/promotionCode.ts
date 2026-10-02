// FILENAME: app/extensions/Collaboration/lib/promotionCode.ts
// PURPOSE: Every word the Promote dialog -- and the push preview, which shows
//          the same summary (owner question 14) -- says about CODE (plan_M8
//          S5): the labels and consequence sentences keyed by the wire values
//          of `calp::code_summary` (core/calp/src/code_summary.rs), the
//          headline, and the sentence the promotion confirm carries.
// CONTEXT: The code summary is the first thing a promoter reads: which macros,
//          scripts, functions, notebooks, buttons and validators change for
//          everyone in the environment, and what each change means for them.
//          The sentences are ONE exhaustive table per wire value (the
//          CHECKOUT_TRUST pattern, never a ternary), so a value the backend
//          adds is a compile error here and a red drift test, never a row that
//          silently says nothing.
//
//          NO REACT, NO IPC. The dialog and the confirm both ask here.

import type {
  PromotionCodeChange,
  PromotionCodeChangeKind,
  PromotionCodeConsequence,
  PromotionCodeKind,
  PromotionImpact,
} from "@api/collaboration";

/** What each kind of code is called, keyed by `CodeKind`'s wire value. */
export const PROMOTION_CODE_KIND: Record<PromotionCodeKind, { label: string; noun: string }> = {
  macro: { label: "Macro", noun: "macro" },
  objectScript: { label: "Object script", noun: "object script" },
  customFunction: { label: "Custom function", noun: "custom function" },
  notebook: { label: "Notebook", noun: "notebook" },
  buttonCode: { label: "Button code", noun: "button" },
  buttonCellAction: { label: "Button cell", noun: "button cell" },
  writebackValidator: { label: "Writeback validator", noun: "writeback validator" },
  reservedScript: { label: "Reserved script id", noun: "script under a reserved id" },
};

/** What happened to it, keyed by `CodeChangeKind`'s wire value. */
export const PROMOTION_CODE_CHANGE: Record<PromotionCodeChangeKind, string> = {
  added: "new",
  removed: "removed",
  modified: "changed",
  unchanged: "unchanged",
};

/**
 * What a change means for everyone in the environment, keyed by
 * `SubscriberConsequence`'s wire value. `tone` picks the row's colour.
 */
export const PROMOTION_CODE_CONSEQUENCE: Record<
  PromotionCodeConsequence,
  { tone: "warn" | "info" | "quiet" | "error"; sentence: (environment: string) => string }
> = {
  asksApprovalAgain: {
    tone: "warn",
    sentence: (env) => `Everyone in ${env} is asked to approve it before it runs.`,
  },
  runsAfterApproval: {
    tone: "info",
    sentence: (env) => `Runs in ${env} once approved, and asks for no new approval of its own.`,
  },
  stopsRunning: {
    tone: "quiet",
    sentence: (env) => `Stops running for everyone in ${env}.`,
  },
  removedOnArrival: {
    tone: "quiet",
    sentence: (env) => `Never reaches ${env}: each subscriber's copy removes it on arrival.`,
  },
  neverRuns: {
    tone: "quiet",
    sentence: (env) => `Nothing in ${env} runs it.`,
  },
  refusesVersion: {
    tone: "error",
    sentence: (env) => `Subscribers in ${env} cannot take this version at all: Calcula refuses it.`,
  },
  blocksSubmit: {
    tone: "error",
    sentence: (env) => `Every submission from ${env} to this region is refused.`,
  },
};

/**
 * Which act the summary describes. The rows, the headline and every sentence
 * are the same for both -- the code that changes and what it means for the
 * people who receive it -- and only what is still possible when the
 * comparison fails differs.
 */
export type CodeSummaryAct = "promotion" | "push";

/**
 * Who receives a push: the development line, which takes every push the moment
 * it lands (an environment receives it only when it is promoted, and the
 * Promote dialog shows the summary again for that environment).
 */
export const PUSH_CODE_AUDIENCE = "the development line";

/** What a failed comparison leaves the person able to do, keyed by act. */
export const CODE_SUMMARY_FAILED_NOTE: Record<CodeSummaryAct, (audience: string) => string> = {
  promotion: (env) =>
    `Promoting still works; it moves the pointer without this list, so nobody here can see ` +
    `which code everyone in ${env} will run next.`,
  push: (line) =>
    `Pushing still works; it publishes without this list, so nobody here can see ` +
    `which code everyone in ${line} will run next.`,
};

/** The Promote dialog's (and the push preview's) knowledge of the code. */
export interface PromotionCodeState {
  status: "loading" | "ready" | "failed";
  changes: PromotionCodeChange[];
  asksApprovalAgain: boolean;
  /** Why the code could not be compared: the backend's `codeError`, or the read's own rejection. */
  error: string | null;
}

export const PROMOTION_CODE_LOADING: PromotionCodeState = {
  status: "loading",
  changes: [],
  asksApprovalAgain: false,
  error: null,
};

/** The state for a rejected impact read: the failure is SAID, never swallowed. */
export function promotionCodeFailed(reason: unknown): PromotionCodeState {
  const text = String(reason ?? "").trim();
  return {
    status: "failed",
    changes: [],
    asksApprovalAgain: false,
    error: text || "the comparison returned no reason",
  };
}

/**
 * The state for an answered impact read -- or a push preview's `code`, which
 * carries the same three fields. A `codeError` is a failure, not an empty
 * list. Typed by PICKING the wire fields, so renaming one of them in
 * @api/collaboration is a compile error here (the wire tests read Rust).
 */
export function promotionCodeFromImpact(
  impact: Pick<PromotionImpact, "codeChanges" | "asksApprovalAgain" | "codeError">,
): PromotionCodeState {
  if (typeof impact.codeError === "string" && impact.codeError.trim() !== "") {
    return promotionCodeFailed(impact.codeError);
  }
  if (!Array.isArray(impact.codeChanges)) {
    // An answer with no code list cannot be read as "no code changes".
    return promotionCodeFailed("the answer carried no code list");
  }
  return {
    status: "ready",
    changes: impact.codeChanges,
    asksApprovalAgain: impact.asksApprovalAgain === true,
    error: null,
  };
}

/** The rows that count as CHANGES (a reserved script listed unchanged does not). */
export function countedCodeChanges(changes: readonly PromotionCodeChange[]): PromotionCodeChange[] {
  return changes.filter((c) => c.change !== "unchanged");
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function sentenceEnd(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * WHY the environment cannot take the target, from the rows that say it
 * cannot, or null when none does. Core refuses a version for two different
 * reasons (core/calp/src/code_summary.rs), and each is said as itself: a
 * script under an id Calcula reserves (`reservedScript` rows), and an artifact
 * of the version's code a pull cannot parse (every other kind's
 * `refusesVersion` row -- `unreadable`), named.
 */
function refusalReason(changes: readonly PromotionCodeChange[]): string | null {
  const rows = changes.filter((c) => c.consequence === "refusesVersion");
  if (rows.length === 0) return null;
  const reasons: string[] = [];
  if (rows.some((c) => c.kind === "reservedScript")) {
    reasons.push("it carries a script under an id Calcula reserves");
  }
  const unreadable = rows.filter((c) => c.kind !== "reservedScript");
  if (unreadable.length > 0) {
    const named = unreadable
      .slice(0, CONFIRM_NAMED_CHANGES)
      .map((c) => `${PROMOTION_CODE_KIND[c.kind].noun} "${c.name}"`);
    const more = unreadable.length - named.length;
    const list = named.join(", ") + (more > 0 ? `, and ${more} more` : "");
    reasons.push(
      `${unreadable.length === 1 ? "a file of its code cannot be read" : `${unreadable.length} files of its code cannot be read`} (${list})`,
    );
  }
  return reasons.join(", and ");
}

/**
 * The one-line headline above the rows, e.g.
 * "Code: 3 changes. Everyone in prod will be asked to approve this
 * application's code again before it runs."
 */
export function describeCodeHeadline(
  state: PromotionCodeState,
  environment: string,
  firstPromotion: boolean,
  toVersion: string,
): string {
  if (state.status === "loading") return "Code: comparing…";
  if (state.status === "failed") {
    return sentenceEnd(`Code: the comparison failed: ${state.error ?? ""}`);
  }
  const counted = countedCodeChanges(state.changes);
  const n = counted.length;
  const what = firstPromotion ? plural(n, "item", "items") : plural(n, "change", "changes");
  const refused = refusalReason(state.changes);
  if (refused !== null) {
    const lead = n === 0 ? "Code: no changes" : `Code: ${what}`;
    return `${lead}. Subscribers in ${environment} cannot take v${toVersion}: ${refused}.`;
  }
  if (n === 0 && !state.asksApprovalAgain) {
    return firstPromotion
      ? `Code: v${toVersion} carries no code, so nobody is asked to approve anything.`
      : "Code: no changes, nobody is asked again.";
  }
  if (state.asksApprovalAgain) {
    return firstPromotion
      ? `Code: ${what}. Everyone in ${environment} will be asked to approve this application's code before it runs.`
      : `Code: ${what}. Everyone in ${environment} will be asked to approve this application's code again before it runs.`;
  }
  return firstPromotion
    ? `Code: ${what}, and nobody in ${environment} is asked to approve anything.`
    : `Code: ${what}, and nobody in ${environment} is asked to approve anything again.`;
}

/** What the promotion confirm is told about the code. */
export interface PromotionCodeConfirm {
  /** Rows that count as changes. */
  count: number;
  asksApprovalAgain: boolean;
  /**
   * Why the environment cannot take the target -- a script under a reserved
   * id, a file of its code that cannot be read -- or null when it can.
   */
  refusesVersion: string | null;
  /** The first few changes, named: `macro "Report" (changed)`. */
  names: string[];
  /** Set when the comparison failed or had not finished. */
  error?: string;
}

/** How many changes the confirm names before "and N more". */
export const CONFIRM_NAMED_CHANGES = 3;

/** One change, named for a sentence: `object script "Fetcher" (new, gains net.fetch)`. */
export function nameCodeChange(c: PromotionCodeChange): string {
  const where = c.sheetName ? ` on ${c.sheetName}` : "";
  const extra = c.addedCapabilities.length > 0 ? `, gains ${c.addedCapabilities.join(", ")}` : "";
  return `${PROMOTION_CODE_KIND[c.kind].noun} "${c.name}"${where} (${PROMOTION_CODE_CHANGE[c.change]}${extra})`;
}

/** The confirm's view of the dialog's code state. A state still loading is said as such. */
export function promotionCodeConfirm(state: PromotionCodeState): PromotionCodeConfirm {
  if (state.status === "loading") {
    return {
      count: 0,
      asksApprovalAgain: false,
      refusesVersion: null,
      names: [],
      error: "it had not finished when you pressed Promote",
    };
  }
  if (state.status === "failed") {
    return { count: 0, asksApprovalAgain: false, refusesVersion: null, names: [], error: state.error ?? "" };
  }
  const counted = countedCodeChanges(state.changes);
  return {
    count: counted.length,
    asksApprovalAgain: state.asksApprovalAgain,
    refusesVersion: refusalReason(state.changes),
    names: counted.map(nameCodeChange),
  };
}

/**
 * The confirm's code paragraph. It NAMES what changes (the first few, then a
 * count), says who is asked again, and says so plainly when the comparison
 * failed -- a failure never blocks the promotion, and never reads as "no
 * changes" either.
 */
export function describeCodeForConfirm(
  code: PromotionCodeConfirm,
  environment: string,
  toVersion: string,
  firstPromotion: boolean,
): string {
  if (code.error !== undefined) {
    return sentenceEnd(
      `Code: the comparison of the application's code failed (${code.error}), so this moves the ` +
        `pointer without knowing what code changes for everyone in ${environment}`,
    );
  }
  if (code.count === 0 && code.refusesVersion === null && !code.asksApprovalAgain) {
    return firstPromotion
      ? `Code: v${toVersion} carries no macros, scripts or button code, so nobody is asked to approve anything.`
      : `Code: no macro, script or button code changes, so nobody in ${environment} is asked to approve anything again.`;
  }
  const shown = code.names.slice(0, CONFIRM_NAMED_CHANGES);
  const more = code.names.length - shown.length;
  const list = shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
  const lead =
    code.count === 0
      ? "Code: no changes."
      : `${firstPromotion ? "Code it carries" : "Code that changes"}: ${list}.`;
  if (code.refusesVersion !== null) {
    return `${lead} Subscribers in ${environment} cannot take v${toVersion}: ${code.refusesVersion}.`;
  }
  if (code.asksApprovalAgain) {
    return firstPromotion
      ? `${lead} Everyone in ${environment} will be asked to approve this application's code before it runs.`
      : `${lead} Everyone in ${environment} will be asked to approve this application's code again before it runs.`;
  }
  return firstPromotion
    ? `${lead} Nobody in ${environment} is asked to approve anything.`
    : `${lead} Nobody in ${environment} is asked to approve anything again.`;
}
