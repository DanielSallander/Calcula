//! FILENAME: app/src/api/scriptHost/scriptForms.ts
// PURPOSE: The host half of script-defined FORMS (the VBA UserForm replacement):
//          the per-script layout registry, the live form SESSIONS, their
//          deadlines and rate buckets, and the data-only exchange with the
//          trusted renderer (ScriptableObjects/components/scriptForm/). The
//          renderer paints; the worker supplies data; this module holds the
//          state between them. It reaches the host realm only through the
//          `FormSessionDeps` callbacks host.ts hands it, so it never imports
//          host.ts (and host.ts stays the one place that knows a MountedWorker).
//
// THE SHAPE OF A SHOW. `form.show` is a "ui"-class broker call, but unlike a
// dialog it does NOT await the answer: it resolves `{ showId }` the moment the
// renderer acknowledges the form is ON SCREEN, and the answer arrives later
// through `deps.closed(showId, result)` — which host.ts relays into the worker
// as `__form_closed`, where the shim resolves the script's awaited promise.
// That keeps every worker-side deadline the person-length one the pinned tests
// require (scriptDialogs.test.ts) without a multi-hour pending RPC, and it
// keeps the HOST -> WORKER relay alive too: while a script has a form open the
// host suspends that worker's method-call deadlines, or a `run()` awaiting the
// form would be abandoned after 30 s while the user was still typing.
//
// GUARDS. The modal slot is SHARED with scriptDialogs.ts (one modal app-wide,
// one per script, rejected not queued, three consecutive dismissals mute the
// script for dialogs and forms alike), so a form and an alert can never both
// be on screen and the dialog on screen unambiguously belongs to the script
// named in it. Two bounds are this module's own: a per-script SHOW bucket, so
// a form re-shown from its own onClose cannot loop the user, and a per-session
// UPDATE bucket, so a script cannot repaint the dialog thirty times a frame.
// Every one of them runs BEFORE the host reads a single bound cell: host.ts
// hands `showScriptForm` a `resolve` thunk rather than finished seeds, and a
// refused show never calls it (see the note on `showScriptForm`).
//
// DEADLINES. An open form is bounded by an IDLE deadline re-armed by every
// user interaction and an ABSOLUTE cap; both close it as dismissed (`null`),
// never as an error. Every no-answer path — Cancel, Escape, the X, the backdrop,
// the deadlines, a script unmount, a workbook reset — lands on the same
// `null`, so a script awaiting a form can never hang on one.

import { BrokerError } from "./broker";
import { emitAppEvent, onAppEvent } from "../events";
// The ONE dirtiness rule, shared with the write path in host.ts: a widget the
// user has edited is what decides both "write this cell" and "do not overwrite
// what is on screen", and two rules would eventually disagree about one of them.
import { coerceFormValue, isDirty } from "./scriptFormBindings";
import {
  claimModalSlot,
  isScriptDialogMuted,
  recordModalOutcome,
  releaseModalSlot,
} from "./scriptDialogs";
import {
  FORM_SHOWS_PER_MINUTE,
  FORM_UPDATE_PER_SECOND,
  FORM_INPUT_TYPE_SET,
  MAX_FORM_ERROR_CHARS,
  SCRIPT_FORM_CLOSE_EVENT,
  SCRIPT_FORM_INPUT_EVENT,
  SCRIPT_FORM_PATCH_EVENT,
  SCRIPT_FORM_REQUEST_EVENT,
  type FormCloseReason,
  type FormOrigin,
  type FormPatch,
  type FormSeed,
  type FormSpec,
  type FormValue,
  type FormWidget,
  type ScriptFormInputPayload,
  type ScriptFormPatchPayload,
  type ScriptFormRequestPayload,
} from "./scriptFormSpec";

// ============================================================================
// Deadlines and rates (host-side; the worker never sees these)
// ============================================================================

/** An open form with no user interaction for this long closes as dismissed. */
export const FORM_IDLE_DEADLINE_MS = 30 * 60_000;
/** Absolute cap on one open form, however busy the user is. */
export const FORM_MAX_OPEN_MS = 8 * 3_600_000;
/** The renderer must acknowledge "shown" within this window or the show fails. */
export const FORM_SHOWN_ACK_TIMEOUT_MS = 10_000;
/** Text-like widgets forward onChange this long after the last keystroke. */
export const FORM_TEXT_CHANGE_DEBOUNCE_MS = 150;

// ============================================================================
// The host callbacks a session drives (host.ts binds them to a MountedWorker)
// ============================================================================

/** The normalized answer to `onSubmit`; null = accept. */
export interface FormSubmitDecision {
  cancel: boolean;
  errors?: Record<string, string>;
  message?: string;
}

export interface FormSessionDeps {
  /** Fire-and-forget event into the owning worker (onShow / onChange / onClick / onClose). */
  forward(hook: string, payload: unknown): void;
  /** Push a sync-getter mirror into the worker (form.values / form.isOpen). */
  mirror(path: string, value: unknown): void;
  /** Ask the owning worker's onSubmit for a verdict (bounded, default accept). */
  relaySubmit(values: Record<string, FormValue | string[]>): Promise<FormSubmitDecision | null>;
  /** Deliver the final answer to the awaiting `show()` (null = dismissed). */
  closed(showId: string, result: Record<string, FormValue | string[]> | null): void;
  /** Stop / restart the clock on relayed method calls into the owning worker. */
  suspendDeadlines(): void;
  resumeDeadlines(): void;
  /** The renderer acknowledged the form is on screen (the host starts its live cell watch here). */
  opened?(showId: string): void;
  /**
   * Write bound widgets back to their cells — every dirty one when `names` is
   * null (Submit), or exactly `names` (a `writeOn: "change"` widget). Resolves
   * the names written. A throw keeps the form open and its message is shown.
   */
  writeBindings?(
    showId: string,
    values: Record<string, FormValue | string[]>,
    names: string[] | null,
  ): Promise<string[]>;
}

// ============================================================================
// Registry state
// ============================================================================

interface FormSession {
  showId: string;
  scriptId: string;
  scriptName: string;
  /** Set when ANOTHER script opened this form (caps.forms.show); its unmount closes the session too. */
  callerScriptId?: string;
  spec: FormSpec;
  /** Widget type by name, for the text-change debounce and value coercion. */
  widgetTypes: Map<string, string>;
  /** Listboxes that take several answers — the value SHAPE depends on it. */
  multiNames: Set<string>;
  values: Record<string, FormValue | string[]>;
  /**
   * What each widget started from, refreshed whenever its cell changes. Held
   * so this registry can apply the RENDERER's rule about which widgets a fresh
   * seed may overwrite — see `refreshScriptFormSeeds`.
   */
  seeds: Record<string, FormSeed>;
  /** Widgets the USER has changed. A script patch is not a user edit. */
  touched: Set<string>;
  /** Bound widgets that write their cell on each committed change. */
  writeOnChange: Set<string>;
  deps: FormSessionDeps;
  shown: boolean;
  closed: boolean;
  submitting: boolean;
  ackTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  changeTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Token bucket for form.update. */
  updateTokens: number;
  updateRefilledAt: number;
  updateWarned: boolean;
  resolveShown: ((v: { showId: string }) => void) | null;
  rejectShown: ((e: Error) => void) | null;
}

/**
 * The layouts one script may describe. A script has ONE modal form ("form",
 * `form.define`) and may ALSO dock the same kind of tree as a task pane ("pane",
 * `pane.dock`, scriptPanes.ts). They are kept per KIND so that describing one
 * never overwrites the other — a form script that docks a status pane still
 * has its form the next time it calls `show()`.
 */
export type ScriptLayoutKind = "form" | "pane";

/** scriptId -> layout kind -> the spec its last define/dock declared. */
const definitions = new Map<string, Map<ScriptLayoutKind, FormSpec>>();
/** showId -> session. At most one entry (the modal slot), keyed for clarity. */
const sessions = new Map<string, FormSession>();
/** scriptId -> showId, so the per-script lookups are not scans. */
const sessionByScript = new Map<string, string>();
/** scriptId -> timestamps of recent show attempts (the re-show bound). */
const showAttempts = new Map<string, number[]>();
/**
 * A show whose modal slot is claimed while its bound reads are still in flight.
 *
 * IT RECORDS BOTH SCRIPTS, NOT ONLY THE OWNER. An open SESSION is closed on the
 * caller's unmount as well as the owner's (`callerScriptId`), because for
 * `caps.forms.show` the two are different scripts and the answer is awaited by
 * the CALLER. A pending show has to answer to both for the same reason: an
 * entry that named only the owner survived the caller's unmount, painted a form
 * for a script that no longer existed, and sent its answer nowhere.
 */
interface PendingShow {
  showId: string;
  /** Set when ANOTHER script asked for this show (caps.forms.show). */
  callerScriptId?: string;
}

/**
 * scriptId (the form's OWNER) -> the pending show whose modal slot is claimed
 * while its bound reads are still in flight. Between `claimModalSlot` and the
 * session existing there is nothing in `sessions` for an unmount or a reset to
 * close, so without this the slot would be held for the rest of the session and
 * every later dialog refused — the exact wedge `endSession`'s idempotence exists
 * to prevent.
 */
const pendingShows = new Map<string, PendingShow>();

let showSeq = 0;
let inputListenerInstalled = false;

/** Testing seam: the clock, so deadlines can be driven with fake timers. */
const now = (): number => Date.now();

// ============================================================================
// Layouts
// ============================================================================

/**
 * Remember a script's layout. Allowed at any time — while a form is OPEN the
 * open session keeps its own copy and the new layout applies to the next
 * show, so a debug remount that re-runs `setup` never throws here.
 */
export function defineScriptForm(scriptId: string, spec: FormSpec): void {
  defineScriptLayout(scriptId, "form", spec);
}

export function getScriptFormSpec(scriptId: string): FormSpec | null {
  return getScriptLayoutSpec(scriptId, "form");
}

/** Remember one of a script's layouts without touching the others. */
export function defineScriptLayout(scriptId: string, layout: ScriptLayoutKind, spec: FormSpec): void {
  let byKind = definitions.get(scriptId);
  if (!byKind) {
    byKind = new Map();
    definitions.set(scriptId, byKind);
  }
  byKind.set(layout, spec);
}

export function getScriptLayoutSpec(scriptId: string, layout: ScriptLayoutKind): FormSpec | null {
  return definitions.get(scriptId)?.get(layout) ?? null;
}

/** Forget one layout kind for one script (its unmount), leaving the other kind alone. */
export function forgetScriptLayout(scriptId: string, layout: ScriptLayoutKind): void {
  const byKind = definitions.get(scriptId);
  if (!byKind) return;
  byKind.delete(layout);
  if (byKind.size === 0) definitions.delete(scriptId);
}

/** Forget one layout kind for EVERY script (a workbook reset). */
export function forgetAllScriptLayouts(layout: ScriptLayoutKind): void {
  for (const scriptId of [...definitions.keys()]) forgetScriptLayout(scriptId, layout);
}

function indexWidgetTypes(spec: FormSpec): Map<string, string> {
  const out = new Map<string, string>();
  const stack: FormWidget[] = [...spec.children];
  while (stack.length > 0) {
    const w = stack.pop() as FormWidget;
    if (w.name) out.set(w.name, w.type);
    if ("children" in w && Array.isArray(w.children)) stack.push(...w.children);
    if (w.type === "tabs") for (const page of w.pages) stack.push(...page.children);
  }
  return out;
}

/** The names of every listbox that takes SEVERAL answers (the shape rule). */
function indexMultiNames(spec: FormSpec): Set<string> {
  const out = new Set<string>();
  const stack: FormWidget[] = [...spec.children];
  while (stack.length > 0) {
    const w = stack.pop() as FormWidget;
    if (w.name && w.type === "listbox" && w.multi === true) out.add(w.name);
    if ("children" in w && Array.isArray(w.children)) stack.push(...w.children);
    if (w.type === "tabs") for (const page of w.pages) stack.push(...page.children);
  }
  return out;
}

// ============================================================================
// Sessions
// ============================================================================

function clearTimers(s: FormSession): void {
  if (s.ackTimer !== null) clearTimeout(s.ackTimer);
  if (s.idleTimer !== null) clearTimeout(s.idleTimer);
  if (s.maxTimer !== null) clearTimeout(s.maxTimer);
  s.ackTimer = s.idleTimer = s.maxTimer = null;
  for (const t of s.changeTimers.values()) clearTimeout(t);
  s.changeTimers.clear();
}

function armIdle(s: FormSession): void {
  if (s.idleTimer !== null) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => endSession(s, "deadline", null), FORM_IDLE_DEADLINE_MS);
}

/**
 * Close a session on ANY path. Idempotent: the renderer's cancel, a script's
 * close, a deadline, an unmount and a reset all land here, and only the first
 * one settles anything.
 */
function endSession(
  s: FormSession,
  reason: FormCloseReason,
  result: Record<string, FormValue | string[]> | null,
): void {
  if (s.closed) return;
  s.closed = true;
  clearTimers(s);
  sessions.delete(s.showId);
  if (sessionByScript.get(s.scriptId) === s.showId) sessionByScript.delete(s.scriptId);
  releaseModalSlot(s.showId);
  // ONLY THE USER MOVES THE DISMISSAL STREAK, IN EITHER DIRECTION.
  //
  // Three consecutive dismissals mute a script's dialogs and forms for the
  // session; the streak exists to stop a script interrupting somebody who
  // keeps saying no. So a user decision counts — "submit" resets it, "cancel"
  // (Escape, the Cancel button, closing the window) and "deadline" (nobody
  // ever answered) advance it — and a close nobody chose is left ALONE:
  //  - counting "script" and "unmount" as dismissals muted a wizard that
  //    closed and reopened its own form three times, after which show()
  //    silently answered null with nobody having refused anything;
  //  - counting them as ENGAGEMENT would be worse: a script could reset the
  //    streak between the user's refusals by closing its own form, and never
  //    be muted however often the user said no.
  if (reason === "submit" || reason === "cancel" || reason === "deadline") {
    recordModalOutcome(s.scriptId, reason !== "submit");
  }
  emitAppEvent(SCRIPT_FORM_CLOSE_EVENT, { showId: s.showId, reason });
  if (!s.shown) {
    // The renderer never acknowledged: the awaiting show() must not hang.
    s.rejectShown?.(
      new BrokerError("HostError", "the form did not open (no renderer acknowledged it)"),
    );
    s.resolveShown = s.rejectShown = null;
  }
  s.deps.mirror("form.isOpen", false);
  s.deps.forward("onClose", { reason, values: s.values });
  s.deps.resumeDeadlines();
  s.deps.closed(s.showId, result);
}

function bucketAllowsShow(scriptId: string): boolean {
  const t = now();
  const recent = (showAttempts.get(scriptId) ?? []).filter((ts) => t - ts < 60_000);
  if (recent.length >= FORM_SHOWS_PER_MINUTE) {
    showAttempts.set(scriptId, recent);
    return false;
  }
  recent.push(t);
  showAttempts.set(scriptId, recent);
  return true;
}

function takeUpdateToken(s: FormSession): boolean {
  const t = now();
  const elapsed = (t - s.updateRefilledAt) / 1000;
  if (elapsed > 0) {
    s.updateTokens = Math.min(FORM_UPDATE_PER_SECOND, s.updateTokens + elapsed * FORM_UPDATE_PER_SECOND);
    s.updateRefilledAt = t;
  }
  if (s.updateTokens < 1) return false;
  s.updateTokens -= 1;
  return true;
}

/** What a `resolve` thunk hands back once the guards have let the show through. */
export interface ResolvedFormShowData {
  /** Seeds the host read from bound cells / control values (host.ts). */
  seeds?: Record<string, FormSeed>;
  /** Restricted tier: the sheet the bindings are pinned to, for the band. */
  pinnedSheetName?: string;
  /** Bound widgets whose effective writeOn is "change". */
  writeOnChange?: Iterable<string>;
}

/**
 * Open a script's form. Rejects (BrokerError) only when a guard refuses to SHOW
 * it — no layout, the show bucket, the shared modal slot — and otherwise
 * resolves `{ showId }` once the renderer acknowledged "shown". A muted script
 * (three consecutive dismissals) gets `{ showId, closed: true }` at once and
 * its awaited answer is delivered as null, the same definite "no" the dialog
 * registry gives it.
 *
 * THE GUARDS COME FIRST, INCLUDING BEFORE THE SHEET IS READ. The bound cells a
 * form starts from are not read by this module — host.ts does that, as audited
 * broker calls under the script's own handle — but WHEN they are read is this
 * module's business, because only this module knows whether the form is going
 * to open at all. So the reads arrive as a `resolve` thunk, awaited AFTER every
 * guard has passed and the modal slot is CLAIMED, and never called at all when
 * a guard refuses. Resolving first meant a muted script calling `show()` in a
 * loop still performed one audited read per bound cell (plus every `{ range }`
 * source and an image resolve) for a dialog nobody would ever see, and left an
 * audit trail saying a form had read the sheet when no form was ever painted.
 *
 * Awaiting it AFTER the claim also means the slot cannot be taken by somebody
 * else while the reads are in flight; a thunk that THROWS gives the slot back
 * and rejects, with no session ever entered in the maps and no close event for
 * a session that never existed. An unmount — of the OWNER or, for a
 * cross-script show, of the CALLER awaiting the answer — or a workbook reset
 * DURING the reads gives it back too (`pendingShows` / `dropPendingShow`), and
 * the show then refuses rather than painting for a script that is no longer
 * there.
 *
 * Callers that already hold their seeds pass `seeds` / `pinnedSheetName` /
 * `writeOnChange` directly; both forms are supported, and a `resolve` result
 * overrides the direct fields for whichever of the three it supplies.
 */
export async function showScriptForm(args: {
  scriptId: string;
  scriptName: string;
  /** Local, or the package it arrived in. Structural — see `FormOrigin`. */
  origin: FormOrigin;
  initial?: Record<string, unknown>;
  /** Seeds the host read from bound cells / control values (host.ts). */
  seeds?: Record<string, FormSeed>;
  /** Restricted tier: the sheet the bindings are pinned to, for the band. */
  pinnedSheetName?: string;
  /** Bound widgets whose effective writeOn is "change". */
  writeOnChange?: Iterable<string>;
  /**
   * The bound reads, deferred until the guards have passed. Called at most
   * once, after the modal slot is claimed and before anything is painted.
   */
  resolve?: () => Promise<ResolvedFormShowData>;
  callerName?: string;
  callerScriptId?: string;
  preview?: boolean;
  deps: FormSessionDeps;
}): Promise<{ showId: string; closed?: true }> {
  const spec = getScriptLayoutSpec(args.scriptId, "form");
  if (!spec) {
    throw new BrokerError("HostError", "form.show: describe the layout first with form.define(...)");
  }
  if (!bucketAllowsShow(args.scriptId)) {
    throw new BrokerError(
      "HostError",
      `this script has opened ${FORM_SHOWS_PER_MINUTE} forms in the last minute; it may not open another yet`,
    );
  }
  const showId = `form-${++showSeq}`;
  if (isScriptDialogMuted(args.scriptId)) {
    // Definite "no", delivered like every other dismissal — but after the
    // caller has the showId to match it against.
    queueMicrotask(() => args.deps.closed(showId, null));
    return { showId, closed: true };
  }
  // Guards 1 + 2 (shared with dialogs). Throws a BrokerError the caller
  // surfaces to the script as a rejected show().
  claimModalSlot({ scriptId: args.scriptId, scriptName: args.scriptName, kind: "scriptForm", slotId: showId });

  // Everything above is synchronous, so a caller with its seeds already in hand
  // still reaches the renderer in the same turn it called show().
  let argSeeds = args.seeds;
  let pinnedSheetName = args.pinnedSheetName;
  let writeOnChange = args.writeOnChange;
  if (args.resolve) {
    pendingShows.set(args.scriptId, {
      showId,
      ...(args.callerScriptId ? { callerScriptId: args.callerScriptId } : {}),
    });
    let resolved: ResolvedFormShowData;
    try {
      resolved = await args.resolve();
    } catch (e) {
      // Nothing has been registered yet: give the slot back and let the show
      // reject with the reason the reads failed. No session, no close event.
      if (pendingShows.get(args.scriptId)?.showId === showId) {
        pendingShows.delete(args.scriptId);
        releaseModalSlot(showId);
      }
      throw e;
    }
    // EITHER script can have been unmounted, or the workbook reset, while the
    // owner's cells were being read. That already gave the slot back, and there
    // is nobody left to receive an answer — for a cross-script show the awaiting
    // side is the CALLER — so the show must not go on to paint.
    if (pendingShows.get(args.scriptId)?.showId !== showId) {
      throw new BrokerError("HostError", "the script was unloaded before its form could open");
    }
    pendingShows.delete(args.scriptId);
    if (resolved.seeds !== undefined) argSeeds = resolved.seeds;
    if (resolved.pinnedSheetName !== undefined) pinnedSheetName = resolved.pinnedSheetName;
    if (resolved.writeOnChange !== undefined) writeOnChange = resolved.writeOnChange;
  }

  const widgetTypes = indexWidgetTypes(spec);
  const multiNames = indexMultiNames(spec);
  const seeds: Record<string, FormSeed> = {};
  const values: Record<string, FormValue | string[]> = {};
  // Bound reads first, then `initial` on top: an explicit initial value wins
  // over the cell for this show only (and drops the cell's display text, which
  // no longer describes what the widget holds) — EXCEPT over a seed the host
  // marked read-only, which owns its value outright (see the loop below).
  for (const [name, seed] of Object.entries(argSeeds ?? {})) {
    const widgetType = widgetTypes.get(name);
    // Not a widget in THIS layout: a stale name from a previous `define`, or a
    // key the caller invented. It has nowhere to land.
    if (widgetType === undefined) continue;
    // A SEED IS NOT ONLY A VALUE. Two widget types take CONTENT rather than an
    // answer — a `table` reads `seed.rows` and an `image` reads the host's
    // resolved `seed.imageUrl` (FormWidgetTree.tsx) — and neither is an input
    // type. Filtering the whole seed on FORM_INPUT_TYPE_SET therefore threw
    // away exactly the content the host had just gone and read: a form with
    // `rows: { range: "D2:E9" }` resolved that range, dropped the answer here,
    // and painted an EMPTY table. Only the VALUE is input-only.
    seeds[name] = seed;
    if (!FORM_INPUT_TYPE_SET.has(widgetType)) continue;
    values[name] = seed.value;
  }
  if (args.initial) {
    for (const [name, value] of Object.entries(args.initial)) {
      if (!FORM_INPUT_TYPE_SET.has(widgetTypes.get(name) ?? "")) continue;
      const v = value as FormValue | string[];
      const prior = seeds[name];
      // A SEED THE HOST MARKED READ-ONLY OWNS ITS VALUE, AND `initial` LOSES.
      // `readOnly` is never something the calling code sets: the host stamps it
      // on a seed it read for the user — or refused to read — together with a
      // `reason` the renderer paints as its OWN help line under the field
      // (FormWidgetTree.tsx). Merging `initial` on top kept the marking, kept
      // that sentence and kept the cell's `formula`, and replaced only the
      // number. On an add-in's form every bound seed is read-only and the
      // sentence is "an add-in's form can show you this cell; it can never
      // change it" (extensionFormBindings.ts), so an add-in could put a figure
      // it invented inside a switched-off box that Calcula was captioning as
      // the user's own cell — with the genuine formula still appearing on
      // focus, which made the fabrication read MORE authentic, not less. That
      // falsifies `CONTRIBUTION_REACH_NOTE.form` ("Calcula then shows you that
      // cell's contents in it") at the point of use. Provenance and value are
      // one indivisible thing; a caller's default is what gives way. Silent on
      // purpose: the field already says what it holds and why, and there is no
      // sensible answer to give a script that asked for a default on a box the
      // user cannot type into.
      if (prior?.readOnly) continue;
      seeds[name] = prior ? { ...prior, value: v, display: undefined } : { value: v };
      values[name] = v;
    }
  }

  const session: FormSession = {
    showId,
    scriptId: args.scriptId,
    scriptName: args.scriptName,
    ...(args.callerScriptId ? { callerScriptId: args.callerScriptId } : {}),
    spec,
    widgetTypes,
    multiNames,
    values,
    seeds,
    touched: new Set<string>(),
    writeOnChange: new Set(writeOnChange ?? []),
    deps: args.deps,
    shown: false,
    closed: false,
    submitting: false,
    ackTimer: null,
    idleTimer: null,
    maxTimer: null,
    changeTimers: new Map(),
    updateTokens: FORM_UPDATE_PER_SECOND,
    updateRefilledAt: now(),
    updateWarned: false,
    resolveShown: null,
    rejectShown: null,
  };
  sessions.set(showId, session);
  sessionByScript.set(args.scriptId, showId);
  ensureInputListener();

  const request: ScriptFormRequestPayload = {
    showId,
    scriptId: args.scriptId,
    scriptName: args.scriptName,
    origin: args.origin,
    ...(args.callerName ? { callerName: args.callerName } : {}),
    spec,
    seeds,
    ...(pinnedSheetName ? { pinnedSheetName } : {}),
    ...(args.preview ? { preview: true } : {}),
  };

  return new Promise<{ showId: string }>((resolve, reject) => {
    session.resolveShown = resolve;
    session.rejectShown = reject;
    session.ackTimer = setTimeout(() => {
      if (!session.shown) endSession(session, "cancel", null);
    }, FORM_SHOWN_ACK_TIMEOUT_MS);
    emitAppEvent(SCRIPT_FORM_REQUEST_EVENT, request);
  });
}

/** Change what an open form shows. A closed form is a no-op (audited ok). */
export function updateScriptForm(scriptId: string, patch: FormPatch): void {
  const showId = sessionByScript.get(scriptId);
  const s = showId ? sessions.get(showId) : undefined;
  if (!s || s.closed) return;
  if (!takeUpdateToken(s)) {
    if (!s.updateWarned) {
      s.updateWarned = true;
      console.warn(
        `[ScriptHost] "${s.scriptName}" updates its form more than ${FORM_UPDATE_PER_SECOND} times a second; excess updates are dropped`,
      );
    }
    return;
  }
  // THE SAME RULE `initial` MEETS AT SHOW TIME, and it has to be here too: a
  // patch is the second way to put a value in a field, so guarding only the
  // show would let the identical substitution land a tick later, under the
  // identical host-authored read-only sentence. The name is stripped from the
  // PAYLOAD as well as from `s.values`, because the renderer's `landFormPatch`
  // (scriptFormState.ts) applies `patch.values` on its own and consults no
  // seed; leaving it in would paint the caller's value while the host believed
  // it had refused it — and dirty the widget, which is what stops the cell's
  // display text from masking the substitution.
  let outgoing = patch;
  if (patch.values) {
    const sealed = Object.keys(patch.values).filter((name) => s.seeds[name]?.readOnly === true);
    if (sealed.length > 0) {
      const values = { ...patch.values };
      for (const name of sealed) delete values[name];
      outgoing = { ...patch, values };
    }
    for (const [name, value] of Object.entries(outgoing.values ?? {})) {
      const type = s.widgetTypes.get(name) ?? "";
      if (!FORM_INPUT_TYPE_SET.has(type)) continue;
      // THE SAME COERCION THE RENDERER APPLIES. `form.control("qty").set("7")`
      // lands as the number 7 on the widget; mirroring the raw "7" made
      // `form.values.qty` disagree with what the form holds and with what a
      // submit would write, until the next thing the user touched.
      s.values[name] = coerceFormValue(type, s.multiNames.has(name), value as FormValue | string[]);
    }
    s.deps.mirror("form.values", { ...s.values });
  }
  const payload: ScriptFormPatchPayload = { showId: s.showId, patch: outgoing };
  emitAppEvent(SCRIPT_FORM_PATCH_EVENT, payload);
}

/** Close a script's own open form from code; `result` becomes show()'s answer. */
export function closeScriptForm(
  scriptId: string,
  result: Record<string, FormValue | string[]> | null,
): void {
  const showId = sessionByScript.get(scriptId);
  const s = showId ? sessions.get(showId) : undefined;
  if (!s) return;
  endSession(s, "script", result);
}

/**
 * A bound cell changed underneath an open form: hand the renderer fresh seeds
 * and keep `form.values` saying what is on screen.
 *
 * TWO CALLERS, ONE DIFFERENCE. The live watch reports somebody ELSE's change
 * and the script wants to hear about it; the write-back after the form's own
 * `writeOn: "change"` write reports the form's own doing, and forwarding that
 * as `source: "cell"` told a script its own write was an external edit — the
 * echo `isOwnScriptWrite` suppresses on the watch itself. `echo: false` says
 * so.
 *
 * The renderer's rule about WHICH widgets a fresh seed may overwrite is
 * applied here as well, rather than assumed: a widget the user has edited
 * keeps their value on screen and is marked stale, so a host that adopted the
 * new cell value into `form.values` would report a number the user cannot see
 * — and an onChange handler computing a total from it would be wrong.
 */
/**
 * How many DISCRETE `onChange{source:"cell"}` events one seed refresh forwards
 * to the script. The mirror (`form.values`) is always updated in full; this
 * bounds only the per-name fan-out, which a large paste otherwise turned into
 * hundreds of events each carrying a full copy of the same values.
 */
export const MAX_FORM_CHANGE_FANOUT = 32;

export function refreshScriptFormSeeds(
  showId: string,
  seeds: Record<string, FormSeed>,
  opts?: { echo?: boolean },
): void {
  const s = sessions.get(showId);
  if (!s || s.closed) return;
  const names = Object.keys(seeds);
  if (names.length === 0) return;
  const payload: ScriptFormPatchPayload = { showId, seeds };
  emitAppEvent(SCRIPT_FORM_PATCH_EVENT, payload);
  const adopted: string[] = [];
  for (const name of names) {
    // Untouched = the user never edited it, or edited it back to what it held
    // before. The renderer decides the same way (ScriptFormDialog's seeds
    // branch), from the same two values.
    const untouched = !s.touched.has(name) || !isDirty(s.seeds[name], s.values[name]);
    s.seeds[name] = seeds[name];
    if (!untouched) continue;
    s.values[name] = seeds[name].value;
    adopted.push(name);
  }
  if (adopted.length === 0) return;
  s.deps.mirror("form.values", { ...s.values });
  if (opts?.echo === false) return;
  // FAN-OUT CAP. Every adopted seed is already in `s.values` (the mirror is
  // updated in full above); what is capped is the number of DISCRETE onChange
  // events one refresh forwards. A paste touching 200 bound cells used to send
  // 200 events with 200 full-values copies — each carrying the same picture.
  // Past the cap the script still sees every value through `form.values` and
  // through the events it does get; it just is not told 200 times.
  const forwarded = Array.from(adopted).slice(0, MAX_FORM_CHANGE_FANOUT);
  for (const name of forwarded) {
    s.deps.forward("onChange", { name, value: seeds[name].value, values: { ...s.values }, source: "cell" });
  }
}

/**
 * The MODAL form session on screen, if any (transparency / tests).
 *
 * WHAT "ACTIVE" MEANS NOW THAT A SECOND SURFACE EXISTS. This answers "which
 * form is blocking the user right now" and nothing else: it reads the modal
 * `sessions` of THIS registry, of which there is at most one (the app-wide
 * modal slot). A docked task pane (scriptPanes.ts) is never "active" in that
 * sense — it blocks nobody and several may be open at once — so it never
 * appears here, and its counterpart is `listScriptPanes()`, which is a LIST
 * because the question it answers ("what is holding a surface?") has several
 * answers. A caller that wants "any script surface on screen" asks both.
 */
export function getActiveScriptForm(): { showId: string; scriptId: string; scriptName: string } | null {
  for (const s of sessions.values()) return { showId: s.showId, scriptId: s.scriptId, scriptName: s.scriptName };
  return null;
}

/**
 * Drop a script's form state on unmount: its open session closes as
 * "unmount" (the worker is gone; the renderer must not stay up asking on
 * behalf of code that no longer exists), its layout is forgotten, and its
 * show bucket is reset so a remount starts clean.
 */
export function revokeScriptForms(scriptId: string): void {
  dropPendingShow(scriptId);
  const showId = sessionByScript.get(scriptId);
  const s = showId ? sessions.get(showId) : undefined;
  if (s) endSession(s, "unmount", null);
  // A form this script OPENED on another script's behalf must not outlive
  // the caller either: nobody is left to receive the answer, and the modal
  // slot would be held until the deadline.
  for (const other of [...sessions.values()]) {
    if (other.callerScriptId === scriptId) endSession(other, "unmount", null);
  }
  // Only the FORM layout: the pane layout is scriptPanes.ts's to forget, and
  // hostUnmountScript asks both registries.
  forgetScriptLayout(scriptId, "form");
  showAttempts.delete(scriptId);
}

/** Forget everything (workbook reset / tests). Open forms close as "unmount". */
export function resetScriptForms(): void {
  for (const scriptId of [...pendingShows.keys()]) dropPendingShow(scriptId);
  for (const s of [...sessions.values()]) endSession(s, "unmount", null);
  sessions.clear();
  sessionByScript.clear();
  forgetAllScriptLayouts("form");
  showAttempts.clear();
}

/**
 * Give back a slot claimed for a show whose bound reads are still running. The
 * show itself notices its claim is gone and refuses rather than painting for a
 * script that is no longer there.
 *
 * MATCHES THE OWNER **OR** THE CALLER. `caps.forms.show` opens one script's
 * form on another script's behalf, and the caller is the one awaiting the
 * answer, so its unmount must drop the claim exactly as the owner's does.
 */
function dropPendingShow(scriptId: string): void {
  for (const [ownerId, pending] of [...pendingShows.entries()]) {
    if (ownerId !== scriptId && pending.callerScriptId !== scriptId) continue;
    pendingShows.delete(ownerId);
    releaseModalSlot(pending.showId);
  }
}

// ============================================================================
// Renderer -> host
// ============================================================================

function ensureInputListener(): void {
  if (inputListenerInstalled) return;
  inputListenerInstalled = true;
  onAppEvent(SCRIPT_FORM_INPUT_EVENT, (detail) => {
    const input = detail as ScriptFormInputPayload;
    const s = sessions.get(input.showId);
    if (!s || s.closed) return;
    handleInput(s, input);
  });
}

function isTextLike(type: string | undefined): boolean {
  return type === "textbox" || type === "number" || type === "date";
}

function handleInput(s: FormSession, input: ScriptFormInputPayload): void {
  switch (input.kind) {
    case "shown": {
      if (s.shown) return;
      s.shown = true;
      if (s.ackTimer !== null) clearTimeout(s.ackTimer);
      s.ackTimer = null;
      s.values = { ...input.values };
      s.deps.suspendDeadlines();
      armIdle(s);
      s.maxTimer = setTimeout(() => endSession(s, "deadline", null), FORM_MAX_OPEN_MS);
      s.deps.mirror("form.values", { ...s.values });
      s.deps.mirror("form.isOpen", true);
      s.resolveShown?.({ showId: s.showId });
      s.resolveShown = s.rejectShown = null;
      s.deps.opened?.(s.showId);
      s.deps.forward("onShow", { values: { ...s.values } });
      return;
    }
    case "interaction":
      armIdle(s);
      return;
    case "change": {
      armIdle(s);
      s.values = { ...input.values };
      s.deps.mirror("form.values", { ...s.values });
      const name = input.name ?? "";
      // The USER changed this one. Only their edits protect a widget from
      // being overwritten by a refreshed seed (see refreshScriptFormSeeds).
      if (name) s.touched.add(name);
      const deliver = (): void => {
        s.changeTimers.delete(name);
        if (s.closed) return;
        s.deps.forward("onChange", {
          name,
          value: input.value ?? null,
          values: { ...s.values },
          source: "user",
        });
        // writeOn: "change" — the cell follows each committed change, as a
        // keystroke would (one undo step each). A refused write shows its
        // reason in the banner and the form stays open.
        if (s.writeOnChange.has(name) && s.deps.writeBindings) {
          void s.deps.writeBindings(s.showId, { ...s.values }, [name]).catch((e: unknown) => {
            if (s.closed) return;
            const payload: ScriptFormPatchPayload = {
              showId: s.showId,
              message: { text: describeFormError(e), kind: "error" },
            };
            emitAppEvent(SCRIPT_FORM_PATCH_EVENT, payload);
          });
        }
      };
      if (isTextLike(s.widgetTypes.get(name))) {
        const pending = s.changeTimers.get(name);
        if (pending !== undefined) clearTimeout(pending);
        s.changeTimers.set(name, setTimeout(deliver, FORM_TEXT_CHANGE_DEBOUNCE_MS));
      } else {
        deliver();
      }
      return;
    }
    case "click":
      armIdle(s);
      s.values = { ...input.values };
      s.deps.mirror("form.values", { ...s.values });
      s.deps.forward("onClick", { name: input.name ?? "", values: { ...s.values } });
      return;
    case "submit":
      armIdle(s);
      void submit(s, input.values);
      return;
    case "cancel":
      endSession(s, "cancel", null);
      return;
    default:
      return;
  }
}

/** Clamp a script's per-widget errors to the renderer's bounds. */
function clampErrors(errors: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!errors) return undefined;
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(errors)) {
    if (typeof text !== "string") continue;
    out[name] = text.length > MAX_FORM_ERROR_CHARS ? text.slice(0, MAX_FORM_ERROR_CHARS) : text;
  }
  return out;
}

async function submit(s: FormSession, values: Record<string, FormValue | string[]>): Promise<void> {
  if (s.submitting) return;
  s.submitting = true;
  try {
    // Flush any debounced text change first, so the script's onChange state
    // is never behind the values it is about to be asked to accept.
    for (const t of s.changeTimers.values()) clearTimeout(t);
    s.changeTimers.clear();
    s.values = { ...values };
    s.deps.mirror("form.values", { ...s.values });
    const decision = await s.deps.relaySubmit({ ...s.values });
    if (s.closed) return;
    if (decision?.cancel) {
      // `refused` is stated, never inferred: a bare `{ cancel: true }` (the
      // normalizer's answer to `false` and to `"cancel"`) carries no errors and
      // no message, and a renderer that reads refusal off those two fields
      // leaves the form pending forever.
      const payload: ScriptFormPatchPayload = {
        showId: s.showId,
        refused: true,
        errors: clampErrors(decision.errors),
        message: decision.message
          ? { text: decision.message.slice(0, MAX_FORM_ERROR_CHARS), kind: "error" }
          : undefined,
      };
      emitAppEvent(SCRIPT_FORM_PATCH_EVENT, payload);
      return;
    }
    // The script accepted: write the dirty bound widgets back (one undo step)
    // BEFORE the form closes, so a refused write keeps the user's entries on
    // screen with the reason rather than losing them.
    if (s.deps.writeBindings) {
      try {
        await s.deps.writeBindings(s.showId, { ...s.values }, null);
      } catch (e) {
        if (s.closed) return;
        const payload: ScriptFormPatchPayload = {
          showId: s.showId,
          refused: true,
          message: { text: describeFormError(e), kind: "error" },
        };
        emitAppEvent(SCRIPT_FORM_PATCH_EVENT, payload);
        return;
      }
      if (s.closed) return;
    }
    endSession(s, "submit", { ...s.values });
  } finally {
    s.submitting = false;
  }
}

/** A write failure as one bounded line for the banner. */
/** The text a refused write shows in the band, bounded. Shared with the pane registry. */
export function describeFormError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.length > MAX_FORM_ERROR_CHARS ? text.slice(0, MAX_FORM_ERROR_CHARS) : text;
}
