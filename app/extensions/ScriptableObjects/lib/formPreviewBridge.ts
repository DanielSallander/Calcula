//! FILENAME: app/extensions/ScriptableObjects/lib/formPreviewBridge.ts
// PURPOSE: "Preview form" — paint a FORM script's layout from the code on
//          screen without saving, mounting, writing or auditing anything.
// CONTEXT: 2026-09-03 (TypeScript Forms, release one). Modelled on
//          aiEditBridge.ts / aiEditClient.ts: the Object Script Editor is a
//          separate Tauri window that activates no extensions, and both halves
//          of a preview belong to the MAIN window — the preview realm snapshots
//          the live workbook there, and the modal slot a form claims is that
//          window's. So the editor compiles its buffer and sends the JavaScript
//          over the Tauri event bridge; this, running in the main window, runs
//          it and paints the result. Results are replayed on EDITOR_READY, the
//          same "re-delivery is safe" rule the AI-edit bridge follows.
//
//          WHAT A PREVIEW IS, precisely. The source runs in the real preview
//          rung (`previewObjectScript`): the real Worker realm, the real
//          broker policy, a COPY of the active sheet as the backend. Only
//          `setup` runs — no hook is fired — because the layout is whatever
//          `form.define` declared during setup, and a handler fired with a
//          synthesized payload could only add ways for the run to be declined.
//          `form.show` is refused in that realm by design (it carries
//          `ui.dialog`, and the preview declares nothing); the rung exempts
//          that one refusal and hands back the captured layout instead.
//
//          BOUND WIDGETS ARE SEEDED FROM THE SAME SNAPSHOT THE RUN USED. The
//          bindings are not known until the layout has been captured, so the
//          run happens twice: once to learn the layout, once more asking the
//          rung to read back exactly the cells the layout binds. A preview
//          never reads the live grid — every seed is a fact about the copy the
//          script itself ran against. Only the active sheet is copied, so a
//          binding to another sheet, a defined name or a control value is shown
//          unbound, with that reason on the widget.
//
//          NOTHING IS WRITTEN. The dialog opens in preview mode (the renderer
//          turns Submit into "What would be written" and never emits a submit),
//          the session deps below forward nothing to any worker, and the
//          preview identity `preview:<scriptId>` is cleaned out of both
//          registries — layout, show bucket, dismissal streak — the moment the
//          dialog closes, so three closed previews can never mute the author.
//
//          EVERY FAILURE PATH ANSWERS. "No layout defined", a declined run, a
//          held modal slot and a thrown error all become a RESULT the editor
//          renders as a status line beside the action — never a global alert,
//          and never silence.

import { emitTauriEvent, listenTauriEvent } from "@api/backend";
import type { UnlistenFn } from "@api/backend";
import {
  defineScriptForm,
  previewObjectScript,
  revokeScriptDialogs,
  revokeScriptForms,
  showScriptForm,
} from "@api";
import type { FormSeed, FormSessionDeps, FormSpec, WorkerPreviewReport } from "@api";
import {
  collectFormBindings,
  parseFormBinding,
  seedFromCell,
} from "@api/scriptHost/scriptFormBindings";
import { shapeOf } from "@api/scriptHost/scriptPreview/grid";

// ============================================================================
// Wire (Editor <-> Main)
// ============================================================================

export const FormPreviewEvents = {
  /** Editor -> Main: preview this form from this JavaScript. */
  REQUEST: "objscript:form-preview-request",
  /** Main -> Editor: what became of the request (shown / closed / why not). */
  RESULT: "objscript:form-preview-result",
  /** Editor -> Main: the author dismissed the note; forget the stored result. */
  DISMISS: "objscript:form-preview-dismiss",
} as const;

export interface FormPreviewRequestPayload {
  /** Correlates the reply. The editor ignores a result for a superseded request. */
  requestId: string;
  scriptId: string;
  scriptName: string;
  /**
   * JAVASCRIPT — the buffer compiled through the same gate a save uses, but
   * NOT stored. The preview realm runs JavaScript; the buffer may be
   * TypeScript. Compiling in the editor keeps the compiler's message in the
   * window the author is typing in.
   */
  source: string;
}

export type FormPreviewOutcome =
  /** The dialog is on screen in the main window. */
  | "shown"
  /** The dialog closed (Close, Escape, X, backdrop, a reset). */
  | "closed"
  /** The run completed but `form.define` was never called during setup. */
  | "noLayout"
  /** The preview rung could draw no conclusion (`applicable: false`). */
  | "declined"
  /** The registry refused to open the dialog (a modal slot already held, a mute). */
  | "refused"
  /** The run itself threw. */
  | "error";

export interface FormPreviewResultPayload {
  requestId: string;
  scriptId: string;
  outcome: FormPreviewOutcome;
  /** One line for the status strip. Empty only for "closed". */
  message: string;
}

export interface FormPreviewDismissPayload {
  scriptId: string;
}

export async function emitFormPreviewRequest(payload: FormPreviewRequestPayload): Promise<void> {
  await emitTauriEvent(FormPreviewEvents.REQUEST, payload);
}

export async function emitFormPreviewResult(payload: FormPreviewResultPayload): Promise<void> {
  await emitTauriEvent(FormPreviewEvents.RESULT, payload);
}

export async function emitFormPreviewDismiss(payload: FormPreviewDismissPayload): Promise<void> {
  await emitTauriEvent(FormPreviewEvents.DISMISS, payload);
}

export function onFormPreviewRequest(
  callback: (payload: FormPreviewRequestPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<FormPreviewRequestPayload>(FormPreviewEvents.REQUEST, callback);
}

export function onFormPreviewResult(
  callback: (payload: FormPreviewResultPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<FormPreviewResultPayload>(FormPreviewEvents.RESULT, callback);
}

export function onFormPreviewDismiss(
  callback: (payload: FormPreviewDismissPayload) => void,
): Promise<UnlistenFn> {
  return listenTauriEvent<FormPreviewDismissPayload>(FormPreviewEvents.DISMISS, callback);
}

// ============================================================================
// Seeding (pure): which cells to read back, and what each widget starts with
// ============================================================================

/** The reason on every widget a preview cannot bind. Tests match on it. */
export const PREVIEW_UNRESOLVED_REASON = "not resolved in a preview";

export interface FormPreviewSeedPlan {
  /** Distinct same-sheet cells to ask the rung to read back, in binding order. */
  cells: Array<{ row: number; col: number }>;
  /** Widget name -> the copied cell its seed comes from. */
  resolved: Map<string, { widgetType: string; row: number; col: number }>;
  /** Widget name -> why it stays unbound in a preview. */
  unresolved: Map<string, { widgetType: string; reason: string }>;
}

/**
 * Decide, from a captured layout, which bindings a preview can honour.
 *
 * Only a single cell on the ACTIVE sheet resolves: that is the sheet the rung
 * copies. A cell on another sheet, a defined name (which may land anywhere)
 * and a control value are all outside the copy, so they are declared unbound
 * here rather than answered from the live workbook — a preview must never read
 * what the run did not see.
 */
export function planFormPreviewSeeds(spec: FormSpec): FormPreviewSeedPlan {
  const cells: Array<{ row: number; col: number }> = [];
  const seen = new Set<string>();
  const resolved = new Map<string, { widgetType: string; row: number; col: number }>();
  const unresolved = new Map<string, { widgetType: string; reason: string }>();
  for (const decl of collectFormBindings(spec)) {
    let parsed: ReturnType<typeof parseFormBinding>;
    try {
      parsed = parseFormBinding(decl.bind);
    } catch (e) {
      unresolved.set(decl.name, {
        widgetType: decl.widgetType,
        reason: `${describeError(e)} — ${PREVIEW_UNRESOLVED_REASON}`,
      });
      continue;
    }
    // `sheetRef` null means "the sheet the form was shown on" — the only sheet
    // the rung copies. A NAME and an INDEX are both outside that copy, and a
    // number here is a real case (`{ cell: "B2", sheet: 1 }`), so neither is
    // resolved and neither is stringified into a fake sheet name.
    if (parsed.kind === "cell" && parsed.sheetRef === null) {
      resolved.set(decl.name, { widgetType: decl.widgetType, row: parsed.row, col: parsed.col });
      const key = `${parsed.row},${parsed.col}`;
      if (!seen.has(key)) {
        seen.add(key);
        cells.push({ row: parsed.row, col: parsed.col });
      }
      continue;
    }
    const target =
      parsed.kind === "cell"
        ? typeof parsed.sheetRef === "number"
          ? `a cell on sheet index ${parsed.sheetRef}`
          : `a cell on sheet "${parsed.sheetRef}"`
        : parsed.kind === "name"
          ? `the defined name "${parsed.name}"`
          : `the control "${parsed.name}"`;
    unresolved.set(decl.name, {
      widgetType: decl.widgetType,
      reason: `Bound to ${target}: ${PREVIEW_UNRESOLVED_REASON} (only the active sheet is copied)`,
    });
  }
  return { cells, resolved, unresolved };
}

/**
 * Turn the rung's read-back (input strings from the copy the run used) into
 * widget seeds. Typed through the same `seedFromCell` the real host uses, so a
 * number widget bound to "42" edits the NUMBER 42. A formula cell is shown
 * read-only with its formula text: nothing here evaluates, and a guessed value
 * would be a lie in the one direction the author cannot check.
 */
export function buildFormPreviewSeeds(
  plan: FormPreviewSeedPlan,
  readBack: ReadonlyArray<{ row: number; col: number; value: string }>,
): Record<string, FormSeed> {
  const inputs = new Map<string, string>();
  for (const cell of readBack) inputs.set(`${cell.row},${cell.col}`, cell.value);
  const seeds: Record<string, FormSeed> = {};
  for (const [name, target] of plan.resolved) {
    const input = inputs.get(`${target.row},${target.col}`);
    if (input === undefined) {
      // The layout changed between the two runs and this cell was never asked
      // for. Unbound, and said so — never a seed from anywhere else.
      seeds[name] = {
        value: null,
        readOnly: true,
        reason: `Its cell was not read back by this run — ${PREVIEW_UNRESOLVED_REASON}`,
      };
      continue;
    }
    const shape = shapeOf(input);
    const seed = seedFromCell(target.widgetType, shape);
    if (shape.formula !== undefined) {
      seed.display = shape.formula;
      seed.readOnly = true;
      seed.reason = "This cell holds a formula; a preview does not compute its value";
    }
    seeds[name] = seed;
  }
  for (const [name, entry] of plan.unresolved) {
    seeds[name] = { value: null, readOnly: true, reason: entry.reason };
  }
  return seeds;
}

// ============================================================================
// Messages (pure)
// ============================================================================

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The rung's own "[preview] ..." line about the layout, without the tag. */
function layoutNote(report: WorkerPreviewReport): string | undefined {
  const line = report.output.find((l) => l.startsWith("[preview]") && l.includes("layout"));
  return line?.replace(/^\[preview\]\s*/, "");
}

export function describeNoLayout(report: WorkerPreviewReport): string {
  const note = layoutNote(report) ?? "the script never called form.define during setup";
  const failure = !report.ok && report.error ? ` (${report.error})` : "";
  return `No layout defined — ${note}${failure}.`;
}

export function describeDeclined(report: WorkerPreviewReport): string {
  return `No preview: ${report.declinedReason ?? "this script cannot be previewed"}.`;
}

export function describeShown(plan: FormPreviewSeedPlan, report: WorkerPreviewReport): string {
  const bound = plan.resolved.size + plan.unresolved.size;
  const parts = ["Preview open in the main window."];
  if (bound > 0) {
    parts.push(
      `${plan.resolved.size} of ${bound} bound widget${bound === 1 ? "" : "s"} seeded from a copy of the active sheet.`,
    );
  }
  if (plan.unresolved.size > 0) {
    parts.push(`Not resolved in a preview: ${[...plan.unresolved.keys()].join(", ")}.`);
  }
  if (!report.ok && report.error) {
    parts.push(`The script also reported: ${report.error}.`);
  }
  return parts.join(" ");
}

// ============================================================================
// The run (main window)
// ============================================================================

/** The preview identity: a script id no real script can have. */
export function previewScriptId(scriptId: string): string {
  return `preview:${scriptId}`;
}

/**
 * Drop everything the preview identity holds.
 *
 * BOTH registries, always. `scriptForms` holds the layout and the show bucket;
 * `scriptDialogs` holds the dismissal streak, and a closed preview counts as a
 * dismissal there — three of them would mute the preview identity for the rest
 * of the session and every later preview would close itself in silence.
 */
function releasePreviewIdentity(previewId: string): void {
  revokeScriptForms(previewId);
  revokeScriptDialogs(previewId);
}

/**
 * A report that cannot be painted, with the outcome to say so — or null when
 * the report carries a layout.
 */
function judge(report: WorkerPreviewReport): { outcome: FormPreviewOutcome; message: string } | null {
  if (!report.applicable) return { outcome: "declined", message: describeDeclined(report) };
  if (report.formLayout === undefined) return { outcome: "noLayout", message: describeNoLayout(report) };
  return null;
}

/**
 * Run one preview to completion, reporting each step through `report`.
 *
 * Reports at most two results: a terminal failure, OR "shown" followed later
 * by "closed". Resolves once the dialog is on screen or the failure is
 * reported — never waits for the user to close the form.
 *
 * Callable directly by main-window code (the in-app CodeEditorDialog) and by
 * the bridge below on behalf of the editor window.
 */
export async function runFormPreview(
  req: FormPreviewRequestPayload,
  report: (result: FormPreviewResultPayload) => void,
): Promise<void> {
  const reply = (outcome: FormPreviewOutcome, message: string): void => {
    report({ requestId: req.requestId, scriptId: req.scriptId, outcome, message });
  };
  const preview = (readBack?: Array<{ row: number; col: number }>): Promise<WorkerPreviewReport> =>
    previewObjectScript({
      source: req.source,
      objectType: "form",
      // Setup only: the layout is what `form.define` declared there. A hook
      // fired with a synthesized payload could only add ways to be declined.
      event: [],
      eventOptional: true,
      ...(readBack ? { readBack } : {}),
    });

  let first: WorkerPreviewReport;
  try {
    first = await preview();
  } catch (e) {
    reply("error", `The preview could not run: ${describeError(e)}`);
    return;
  }
  const firstVerdict = judge(first);
  if (firstVerdict) {
    reply(firstVerdict.outcome, firstVerdict.message);
    return;
  }

  // PASS TWO. The bindings were unknown before the layout existed, so the run
  // repeats with a read-back of exactly the cells the layout binds. Every seed
  // then comes from the copy THAT run used — the layout is taken from the same
  // run for the same reason.
  let layout = first.formLayout as FormSpec;
  let plan = planFormPreviewSeeds(layout);
  let last = first;
  let readBack: Array<{ row: number; col: number; value: string }> = [];
  if (plan.cells.length > 0) {
    let second: WorkerPreviewReport;
    try {
      second = await preview(plan.cells);
    } catch (e) {
      reply("error", `The preview could not run: ${describeError(e)}`);
      return;
    }
    const secondVerdict = judge(second);
    if (secondVerdict) {
      reply(secondVerdict.outcome, secondVerdict.message);
      return;
    }
    layout = second.formLayout as FormSpec;
    plan = planFormPreviewSeeds(layout);
    last = second;
    readBack = second.readBack;
  }
  const seeds = buildFormPreviewSeeds(plan, readBack);

  // SHOW, under the preview identity. The registry claims the shared modal
  // slot (so a preview cannot coexist with a real script's dialog), keeps no
  // audit row, and the renderer paints it labelled as a preview. The deps
  // reach no worker: there is none.
  const previewId = previewScriptId(req.scriptId);
  // A SECOND preview REPLACES the first rather than being refused by it. The
  // modal slot is one per script, so an already-open preview of this same
  // script makes the show below throw "this script already has a dialog open"
  // — and the cleanup for that refusal revokes the identity anyway, so the
  // author would lose the open form AND be told the preview failed. Pressing
  // "Preview form" means "show me the code as it is now", so the previous one
  // is closed deliberately, before the slot is claimed. The stale "closed"
  // that produces carries the SUPERSEDED request id, which both editors'
  // state machines drop.
  releasePreviewIdentity(previewId);
  defineScriptForm(previewId, layout);
  let shownAcked = false;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releasePreviewIdentity(previewId);
  };
  const deps: FormSessionDeps = {
    forward: () => {},
    mirror: () => {},
    relaySubmit: () => Promise.resolve(null),
    closed: () => {
      release();
      // A close before "shown" is a refusal the show() below reports itself.
      if (shownAcked) reply("closed", "");
    },
    suspendDeadlines: () => {},
    resumeDeadlines: () => {},
  };
  try {
    const shown = await showScriptForm({
      scriptId: previewId,
      scriptName: req.scriptName,
      scriptOrigin: "local",
      seeds,
      preview: true,
      deps,
    });
    if (shown.closed) {
      release();
      reply("refused", "The preview was refused: this preview's dialogs are muted after repeated dismissals.");
      return;
    }
    shownAcked = true;
    reply("shown", describeShown(plan, last));
  } catch (e) {
    release();
    reply("refused", `The preview could not open: ${describeError(e)}`);
  }
}

// ============================================================================
// Main-window bridge: hear the editor, run, answer, replay
// ============================================================================

/**
 * The last result per script, for re-delivery on EDITOR_READY.
 *
 * A "closed" result is the one that is NOT kept: after it there is nothing on
 * screen and nothing to say, and a reopened editor is correctly idle.
 */
const lastResults = new Map<string, FormPreviewResultPayload>();

/** Test hook: forget everything this module remembers. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- the repo's `__reset*` test-hook convention (aiEditBridge.ts)
export function __resetFormPreviewBridge(): void {
  lastResults.clear();
}

/** Re-send whatever the editor missed while it was gone. */
export function replayFormPreviewResults(): void {
  for (const result of lastResults.values()) {
    void emitFormPreviewResult(result);
  }
}

function deliver(result: FormPreviewResultPayload): void {
  if (result.outcome === "closed") lastResults.delete(result.scriptId);
  else lastResults.set(result.scriptId, result);
  void emitFormPreviewResult(result);
}

function handle(req: FormPreviewRequestPayload): void {
  lastResults.delete(req.scriptId);
  void runFormPreview(req, deliver);
}

/**
 * Listen for preview requests for the lifetime of the extension.
 *
 * Returns a synchronous teardown suitable for `cleanupFunctions`, which also
 * covers the window where the listeners are still being registered.
 */
export function installFormPreviewBridge(): () => void {
  let disposers: Array<() => void> = [];
  let disposed = false;

  // A channel that cannot be subscribed must not abort activation of the whole
  // extension; it means the editor's preview is unavailable, nothing more.
  const track = (make: () => Promise<() => void>): void => {
    let p: Promise<() => void>;
    try {
      p = make();
    } catch (e) {
      console.warn("[ScriptableObjects] Could not subscribe to a form-preview channel:", e);
      return;
    }
    void p
      .then((off) => {
        if (disposed) off();
        else disposers.push(off);
      })
      .catch((e) => {
        console.warn("[ScriptableObjects] Failed to subscribe to a form-preview channel:", e);
      });
  };

  track(() => onFormPreviewRequest(handle));
  track(() =>
    onFormPreviewDismiss((payload) => {
      if (!payload?.scriptId) return;
      lastResults.delete(payload.scriptId);
    }),
  );

  return () => {
    disposed = true;
    for (const off of disposers) off();
    disposers = [];
    __resetFormPreviewBridge();
  };
}

// ============================================================================
// Editor-window client: ask, hold the status, dismiss
// ============================================================================

export type FormPreviewPhase = "idle" | "running" | "shown" | "failed";

export interface FormPreviewState {
  phase: FormPreviewPhase;
  /** The status line beside the action. */
  message: string;
  /** The request this state answers; "" when idle. */
  requestId: string;
}

/**
 * ONE idle object, returned by identity: `useSyncExternalStore` compares
 * snapshots with `Object.is`, and a fresh literal per read is an endless
 * change ("Maximum update depth exceeded").
 */
export const IDLE_FORM_PREVIEW: FormPreviewState = Object.freeze({
  phase: "idle",
  message: "",
  requestId: "",
}) as FormPreviewState;

/**
 * Fold one result into the state for its script.
 *
 * A result for a request this state did not make is accepted only while the
 * state is IDLE (a replayed delivery); one for a superseded request is
 * ignored, so a refusal for the newest ask is never wiped by the older form
 * finally closing.
 */
export function reduceFormPreviewState(
  prev: FormPreviewState,
  result: FormPreviewResultPayload,
): FormPreviewState {
  if (prev.requestId !== "" && result.requestId !== prev.requestId) return prev;
  switch (result.outcome) {
    case "closed":
      return IDLE_FORM_PREVIEW;
    case "shown":
      return { phase: "shown", message: result.message, requestId: result.requestId };
    default:
      return { phase: "failed", message: result.message, requestId: result.requestId };
  }
}

/** One state per script. NEVER mutated in place — every write replaces the entry. */
const states = new Map<string, FormPreviewState>();
const listeners = new Set<() => void>();
let requestSeq = 0;

function notify(): void {
  for (const fn of listeners) fn();
}

function set(scriptId: string, next: FormPreviewState): void {
  if (next === IDLE_FORM_PREVIEW) states.delete(scriptId);
  else states.set(scriptId, next);
  notify();
}

/** Subscribe to any change. Returns the unsubscribe. */
export function subscribeToFormPreviews(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The state for one script; the shared idle object when there is none. */
export function formPreviewStateFor(scriptId: string | null): FormPreviewState {
  if (!scriptId) return IDLE_FORM_PREVIEW;
  return states.get(scriptId) ?? IDLE_FORM_PREVIEW;
}

/** Test hook. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- the repo's `__reset*` test-hook convention (aiEditClient.ts)
export function __resetFormPreviewClient(): void {
  states.clear();
  listeners.clear();
  requestSeq = 0;
}

function mintRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${++requestSeq}`;
}

/** Send a preview request to the main window and enter the running state. */
export function requestFormPreview(opts: {
  scriptId: string;
  scriptName: string;
  /** JavaScript — already through the save gate. */
  source: string;
}): string {
  const requestId = mintRequestId("fp");
  set(opts.scriptId, { phase: "running", message: "Previewing the form in the main window…", requestId });
  void emitFormPreviewRequest({
    requestId,
    scriptId: opts.scriptId,
    scriptName: opts.scriptName,
    source: opts.source,
  }).catch((e) => {
    // The request never left the window. Nothing is coming back, so say so
    // here rather than wait for a result that cannot arrive.
    set(opts.scriptId, {
      phase: "failed",
      message: `Could not reach the main window: ${describeError(e)}`,
      requestId,
    });
  });
  return requestId;
}

/**
 * A failure found BEFORE asking (the buffer does not compile). Minted under
 * its own request id, so a late result for an earlier ask cannot replace it.
 */
export function reportFormPreviewFailure(scriptId: string, message: string): void {
  set(scriptId, { phase: "failed", message, requestId: mintRequestId("local") });
}

/**
 * Hide the status line, and tell the main window to forget the result — or a
 * note the author already read would come back the next time the window opens.
 */
export function dismissFormPreviewStatus(scriptId: string): void {
  set(scriptId, IDLE_FORM_PREVIEW);
  void emitFormPreviewDismiss({ scriptId }).catch(() => {});
}

/** Wire the editor window to the result channel. Returns a synchronous teardown. */
export function installFormPreviewClient(): () => void {
  let disposers: Array<() => void> = [];
  let disposed = false;

  // Subscribing must never take the WINDOW down with it: a preview channel that
  // cannot be reached is a missing optional feature, not a blank editor.
  const track = (make: () => Promise<() => void>): void => {
    let p: Promise<() => void>;
    try {
      p = make();
    } catch (e) {
      console.warn("[ObjectScriptEditor] Could not subscribe to the form-preview channel:", e);
      return;
    }
    void p
      .then((off) => {
        if (disposed) off();
        else disposers.push(off);
      })
      .catch((e) => {
        console.warn("[ObjectScriptEditor] Failed to subscribe to the form-preview channel:", e);
      });
  };

  track(() =>
    onFormPreviewResult((result) => {
      if (!result?.scriptId) return;
      set(result.scriptId, reduceFormPreviewState(formPreviewStateFor(result.scriptId), result));
    }),
  );

  return () => {
    disposed = true;
    for (const off of disposers) off();
    disposers = [];
  };
}
