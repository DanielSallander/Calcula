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

/** scriptId -> the layout its last form.define declared. */
const definitions = new Map<string, FormSpec>();
/** showId -> session. At most one entry (the modal slot), keyed for clarity. */
const sessions = new Map<string, FormSession>();
/** scriptId -> showId, so the per-script lookups are not scans. */
const sessionByScript = new Map<string, string>();
/** scriptId -> timestamps of recent show attempts (the re-show bound). */
const showAttempts = new Map<string, number[]>();

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
  definitions.set(scriptId, spec);
}

export function getScriptFormSpec(scriptId: string): FormSpec | null {
  return definitions.get(scriptId) ?? null;
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

/**
 * Open a script's form. Rejects (BrokerError) only when a guard refuses to SHOW
 * it — no layout, the show bucket, the shared modal slot — and otherwise
 * resolves `{ showId }` once the renderer acknowledged "shown". A muted script
 * (three consecutive dismissals) gets `{ showId, closed: true }` at once and
 * its awaited answer is delivered as null, the same definite "no" the dialog
 * registry gives it.
 */
export function showScriptForm(args: {
  scriptId: string;
  scriptName: string;
  scriptOrigin: string;
  initial?: Record<string, unknown>;
  /** Seeds the host read from bound cells / control values (host.ts). */
  seeds?: Record<string, FormSeed>;
  /** Restricted tier: the sheet the bindings are pinned to, for the band. */
  pinnedSheetName?: string;
  /** Bound widgets whose effective writeOn is "change". */
  writeOnChange?: Iterable<string>;
  callerName?: string;
  callerScriptId?: string;
  preview?: boolean;
  deps: FormSessionDeps;
}): Promise<{ showId: string; closed?: true }> {
  const spec = definitions.get(args.scriptId);
  if (!spec) {
    return Promise.reject(
      new BrokerError("HostError", "form.show: describe the layout first with form.define(...)"),
    );
  }
  if (!bucketAllowsShow(args.scriptId)) {
    return Promise.reject(
      new BrokerError(
        "HostError",
        `this script has opened ${FORM_SHOWS_PER_MINUTE} forms in the last minute; it may not open another yet`,
      ),
    );
  }
  const showId = `form-${++showSeq}`;
  if (isScriptDialogMuted(args.scriptId)) {
    // Definite "no", delivered like every other dismissal — but after the
    // caller has the showId to match it against.
    queueMicrotask(() => args.deps.closed(showId, null));
    return Promise.resolve({ showId, closed: true });
  }
  // Guards 1 + 2 (shared with dialogs). Throws a BrokerError the caller
  // surfaces to the script as a rejected show().
  try {
    claimModalSlot({ scriptId: args.scriptId, scriptName: args.scriptName, kind: "scriptForm", slotId: showId });
  } catch (e) {
    return Promise.reject(e);
  }

  const widgetTypes = indexWidgetTypes(spec);
  const multiNames = indexMultiNames(spec);
  const seeds: Record<string, FormSeed> = {};
  const values: Record<string, FormValue | string[]> = {};
  // Bound reads first, then `initial` on top: an explicit initial value wins
  // over the cell for this show only (and drops the cell's display text, which
  // no longer describes what the widget holds).
  for (const [name, seed] of Object.entries(args.seeds ?? {})) {
    if (!FORM_INPUT_TYPE_SET.has(widgetTypes.get(name) ?? "")) continue;
    seeds[name] = seed;
    values[name] = seed.value;
  }
  if (args.initial) {
    for (const [name, value] of Object.entries(args.initial)) {
      if (!FORM_INPUT_TYPE_SET.has(widgetTypes.get(name) ?? "")) continue;
      const v = value as FormValue | string[];
      const prior = seeds[name];
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
    writeOnChange: new Set(args.writeOnChange ?? []),
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
    scriptOrigin: args.scriptOrigin,
    ...(args.callerName ? { callerName: args.callerName } : {}),
    spec,
    seeds,
    ...(args.pinnedSheetName ? { pinnedSheetName: args.pinnedSheetName } : {}),
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
  if (patch.values) {
    for (const [name, value] of Object.entries(patch.values)) {
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
  const payload: ScriptFormPatchPayload = { showId: s.showId, patch };
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
  for (const name of adopted) {
    s.deps.forward("onChange", { name, value: seeds[name].value, values: { ...s.values }, source: "cell" });
  }
}

/** The session on screen, if any (transparency / tests). */
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
  const showId = sessionByScript.get(scriptId);
  const s = showId ? sessions.get(showId) : undefined;
  if (s) endSession(s, "unmount", null);
  // A form this script OPENED on another script's behalf must not outlive
  // the caller either: nobody is left to receive the answer, and the modal
  // slot would be held until the deadline.
  for (const other of [...sessions.values()]) {
    if (other.callerScriptId === scriptId) endSession(other, "unmount", null);
  }
  definitions.delete(scriptId);
  showAttempts.delete(scriptId);
}

/** Forget everything (workbook reset / tests). Open forms close as "unmount". */
export function resetScriptForms(): void {
  for (const s of [...sessions.values()]) endSession(s, "unmount", null);
  sessions.clear();
  sessionByScript.clear();
  definitions.clear();
  showAttempts.clear();
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
function describeFormError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.length > MAX_FORM_ERROR_CHARS ? text.slice(0, MAX_FORM_ERROR_CHARS) : text;
}
