//! FILENAME: app/src/api/scriptFormPreview.ts
// PURPOSE: Paint a FORM script's layout from SOURCE — run the draft in the real
//          preview rung, seed its widgets from the copy that run used, and open
//          the trusted renderer in preview mode. Nothing is mounted, nothing is
//          written, and no audit row is produced.
// CONTEXT: 2026-09-03, TypeScript Forms follow-up (docs/design/typescript-forms.md;
//          open-items §2.ab). TWO surfaces need exactly this: the Object Script
//          Editor's "Preview form" (extensions/ScriptableObjects/lib/
//          formPreviewBridge.ts) and the package inspector, which shows what a
//          form inside a distributed `.calp` would look like before anyone
//          consents to running it. The editor had the whole procedure inline;
//          copying it into the inspector would have made a second source of
//          truth for the seeding rules, and this project has measured that
//          shape often enough to name it: two implementations of one truth is
//          one implementation and one lie.
//
// WHAT A PREVIEW IS, precisely. The source runs in the real preview rung
// (`previewObjectScript`): the real Worker realm, the real broker policy, a
// COPY of the active sheet as the backend. Only `setup` runs — no hook is
// fired — because the layout is whatever `form.define` declared during setup,
// and a handler fired with a synthesized payload could only add ways for the
// run to be declined. `form.show` is refused in that realm by design (it
// carries `ui.dialog`, and the preview declares nothing); the rung exempts that
// one refusal and hands back the captured layout instead.
//
// WHERE EVERY WIDGET'S CONTENT COMES FROM — the whole point of this file:
//
//   1. A `bind`ing to a cell ON THE COPIED SHEET is read back out of the SAME
//      grid the script ran against. The bindings are not known until the layout
//      exists, so the run happens TWICE: once to learn the layout, once more
//      asking the rung to read back exactly the cells it binds.
//   2. `options: { range }` and a table's `rows: { range }` are resolved by the
//      RUNG, against that same copy, and arrive on the report (`formSources`).
//      They cannot be resolved out here: the copy never leaves the rung, so a
//      caller re-reading those ranges would be reading the LIVE workbook and
//      seeding a dropdown with data the script never saw.
//   3. A `{ control }` binding is LIVE app state, not workbook state, and is
//      read here — see `readControlSeeds` for why that is the trusted path and
//      not the audited one.
//   4. Everything else — another sheet's cell, a defined name, an image — is
//      seeded READ-ONLY with the reason on the widget. Never invented.
//
// NOTHING IS WRITTEN. The dialog opens in preview mode (the renderer turns
// Submit into "what would be written" and never emits a submit), the session
// deps forward nothing to any worker because there is none, and the preview
// identity is cleaned out of BOTH registries the moment the dialog closes.

import { getControlValue, type ControlValue } from "./controlValues";
import { revokeScriptDialogs } from "./scriptHost/scriptDialogs";
import {
  defineScriptForm,
  revokeScriptForms,
  showScriptForm,
  type FormSessionDeps,
} from "./scriptHost/scriptForms";
import {
  collectFormBindings,
  parseFormBinding,
  seedFromCell,
  seedFromControlValue,
} from "./scriptHost/scriptFormBindings";
import type { FormOrigin, FormSeed, FormSpec } from "./scriptHost/scriptFormSpec";
import {
  namesTheActiveSheet,
  previewObjectScript,
  PREVIEW_FORM_LAYOUT_NOTES,
  type WorkerPreviewReport,
} from "./scriptHost/scriptPreview";
import type { PreviewCellDisplay, PreviewFormSourceSeed } from "./scriptHost/scriptPreview";
import { shapeOf } from "./scriptHost/scriptPreview/grid";

// ============================================================================
// The preview identity
// ============================================================================

/** Prefix of the script id a preview registers under. No real script has it. */
export const PREVIEW_SCRIPT_ID_PREFIX = "preview:";

/** The preview identity for a script id. */
export function previewScriptId(scriptId: string): string {
  return `${PREVIEW_SCRIPT_ID_PREFIX}${scriptId}`;
}

/**
 * Drop everything a preview identity holds.
 *
 * BOTH registries, always. `scriptForms` holds the layout and the show bucket;
 * `scriptDialogs` holds the dismissal streak, and a closed preview counts as a
 * dismissal there — three of them would mute the preview identity for the rest
 * of the session and every later preview would close itself in silence.
 */
export function releasePreviewIdentity(previewId: string): void {
  revokeScriptForms(previewId);
  revokeScriptDialogs(previewId);
}

// ============================================================================
// Seeding (pure)
// ============================================================================

/** The reason on every widget a preview cannot bind. Tests match on it. */
export const PREVIEW_UNRESOLVED_REASON = "not resolved in a preview";

export interface FormPreviewSeedPlan {
  /** Distinct same-sheet cells to ask the rung to read back, in binding order. */
  cells: Array<{ row: number; col: number }>;
  /**
   * Widget name -> the copied cell its seed comes from.
   *
   * `multi` rides along because it decides the SHAPE of the seed, not just its
   * content: only a multi-select listbox holds a LIST, and production passes
   * `decl.multi` into `seedFromCell` for exactly that reason. A preview that
   * dropped it painted a single-select listbox seeded as a list from a cell
   * reading "EMEA, APAC" — which the renderer judges DIRTY while untouched, the
   * defect that truncated the cell on submit in production.
   */
  resolved: Map<string, { widgetType: string; row: number; col: number; multi: boolean }>;
  /**
   * Widget name -> the Controls-pane value it binds. Populated only when the
   * caller asked for live control reads; otherwise these land in `unresolved`.
   */
  controls: Map<string, { widgetType: string; controlName: string; multi: boolean }>;
  /** Widget name -> why it stays unbound in a preview. */
  unresolved: Map<string, { widgetType: string; reason: string }>;
}

/**
 * Decide, from a captured layout, which bindings a preview can honour.
 *
 * Only a single cell on the ACTIVE sheet resolves from the copy: that is the
 * sheet the rung copies. A cell on another sheet and a defined name (which may
 * land anywhere) are both outside it, so they are declared unbound here rather
 * than answered from the live workbook — a preview must never read what the run
 * did not see.
 *
 * "The active sheet" includes it NAMED. `bind: "Sheet1!B2"` while Sheet1 is
 * active is the active sheet's own cell, and refusing it while
 * `options: { range: "Sheet1!A1:A3" }` resolved was two rules for one question
 * — so the rule is `formSources`' own `namesTheActiveSheet`, and the name comes
 * from the run's report (`activeSheetName`), never from a second live read.
 * With no name to compare against, every qualified reference stays unresolved.
 *
 * A `{ control }` binding is the ONE exception, and only when the caller opts
 * in: a control value is not workbook state at all, so "the run did not see it"
 * does not apply — see `readControlSeeds`.
 */
export function planFormPreviewSeeds(
  spec: FormSpec,
  opts?: { readControls?: boolean; activeSheetName?: string },
): FormPreviewSeedPlan {
  const cells: Array<{ row: number; col: number }> = [];
  const seen = new Set<string>();
  const resolved = new Map<
    string,
    { widgetType: string; row: number; col: number; multi: boolean }
  >();
  const controls = new Map<string, { widgetType: string; controlName: string; multi: boolean }>();
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
    // the rung copies — and a NAME that spells that same sheet means it too.
    // An INDEX does not: a number here is a real case
    // (`{ cell: "B2", sheet: 1 }`), the copy carries no index to match it
    // against, and it is never stringified into a fake sheet name.
    if (parsed.kind === "cell" && onTheCopiedSheet(parsed.sheetRef, opts?.activeSheetName)) {
      resolved.set(decl.name, {
        widgetType: decl.widgetType,
        row: parsed.row,
        col: parsed.col,
        multi: decl.multi,
      });
      const key = `${parsed.row},${parsed.col}`;
      if (!seen.has(key)) {
        seen.add(key);
        cells.push({ row: parsed.row, col: parsed.col });
      }
      continue;
    }
    if (parsed.kind === "control" && opts?.readControls) {
      controls.set(decl.name, {
        widgetType: decl.widgetType,
        controlName: parsed.name,
        multi: decl.multi,
      });
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
  return { cells, resolved, controls, unresolved };
}

/**
 * Whether a cell binding's sheet reference lands on the ONE sheet the copy
 * holds: unqualified, or naming that sheet (the rung's own rule for ranges).
 *
 * A numeric `sheet` is never accepted. The copy carries a NAME, not the
 * workbook's sheet order, so matching an index against it would be a guess —
 * and a wrong guess seeds a widget from a different sheet's cell at the same
 * coordinates, which is the worst kind of wrong because it looks right.
 */
function onTheCopiedSheet(
  sheetRef: string | number | null,
  activeSheetName: string | undefined,
): boolean {
  if (sheetRef === null) return true;
  if (typeof sheetRef === "number") return false;
  return namesTheActiveSheet(sheetRef, activeSheetName);
}

/**
 * Turn everything a preview gathered into one seed per widget.
 *
 * FOUR SOURCES, MERGED IN ONE ORDER. Range-fed CONTENT goes down first
 * (`options` / `rows` belong to the widget, not to its value), then the VALUE
 * each bound widget starts with is laid over it while keeping that content —
 * the same merge the production host performs, where a dropdown can be both
 * `bind`-ed to a cell and fed its choices from a range.
 */
export function buildFormPreviewSeeds(opts: {
  plan: FormPreviewSeedPlan;
  /** The rung's read-back: input strings from the copy the run used. */
  readBack: ReadonlyArray<{ row: number; col: number; value: string }>;
  /**
   * What each of those cells EVALUATED TO in the same copy, for the cells that
   * have a computed value. Without it every formula-bound widget seeds from a
   * bare "=SUM(B2:B9)" — no value, no display — and previews disabled saying
   * the preview does not compute it, which the rung's own recalculation makes
   * untrue. A cell missing here genuinely has no computed value.
   */
  readBackDisplays?: ReadonlyArray<PreviewCellDisplay>;
  /** The rung's resolved range-fed content, from the same run's report. */
  sources?: ReadonlyArray<PreviewFormSourceSeed>;
  /** Live control values by widget name, already read (see readControlSeeds). */
  controlSeeds?: Readonly<Record<string, FormSeed>>;
}): Record<string, FormSeed> {
  const { plan, readBack } = opts;
  const seeds: Record<string, FormSeed> = {};

  // 1. CONTENT from ranges (and the images a preview declines to resolve).
  for (const src of opts.sources ?? []) {
    const seed: FormSeed = seeds[src.name] ?? { value: null };
    if (src.reason !== undefined) {
      seed.readOnly = true;
      seed.reason = `${src.reason} — ${PREVIEW_UNRESOLVED_REASON}`;
      // An empty list rather than none at all: the widget must paint as a list
      // with nothing in it, not as one still waiting for its content.
      if (src.kind === "options") seed.options = [];
      if (src.kind === "rows") seed.rows = [];
    } else {
      if (src.options !== undefined) seed.options = src.options;
      if (src.rows !== undefined) seed.rows = src.rows;
    }
    seeds[src.name] = seed;
  }

  // 2. VALUES from the copied cells the run read back.
  const inputs = new Map<string, string>();
  for (const cell of readBack) inputs.set(`${cell.row},${cell.col}`, cell.value);
  const displays = new Map<string, string>();
  for (const cell of opts.readBackDisplays ?? []) {
    displays.set(`${cell.row},${cell.col}`, cell.display);
  }
  for (const [name, target] of plan.resolved) {
    const key = `${target.row},${target.col}`;
    const input = inputs.get(key);
    if (input === undefined) {
      // The layout changed between the two runs and this cell was never asked
      // for. Unbound, and said so — never a seed from anywhere else.
      seeds[name] = merge(seeds[name], {
        value: null,
        readOnly: true,
        reason: `Its cell was not read back by this run — ${PREVIEW_UNRESOLVED_REASON}`,
      });
      continue;
    }
    // THE SAME TWO ARGUMENTS PRODUCTION PASSES. The cached value makes a
    // formula cell shape up as the number the copy computed rather than as an
    // unevaluated husk, and `multi` decides whether the seed is a list or one
    // string — the shape mismatch that makes an untouched listbox read as
    // edited and truncate its cell on submit.
    const cached = displays.get(key);
    const shape = shapeOf(input, cached);
    const seed = seedFromCell(target.widgetType, shape, target.multi);
    if (shape.formula !== undefined && cached === undefined) {
      // Only NOW is the read-only reason true: the copy carries no value for
      // this cell (the script overwrote it, or the copy was truncated and its
      // formulas deliberately not re-evaluated). When the run DID compute one,
      // the widget seeds exactly as a real `form.show` would — value, display
      // and the formula text — instead of opening disabled over a claim the
      // rung's own recalculation contradicts.
      seed.display = shape.formula;
      seed.readOnly = true;
      seed.reason = "This cell holds a formula this run computed no value for";
    }
    seeds[name] = merge(seeds[name], seed);
  }

  // 3. VALUES from live controls (read-only, with `seedFromControlValue`'s own reason).
  for (const [name, seed] of Object.entries(opts.controlSeeds ?? {})) {
    seeds[name] = merge(seeds[name], seed);
  }

  // 4. Everything a preview cannot reach at all.
  for (const [name, entry] of plan.unresolved) {
    seeds[name] = merge(seeds[name], { value: null, readOnly: true, reason: entry.reason });
  }
  return seeds;
}

/**
 * Lay a value seed over whatever content a range source already produced.
 *
 * `options` / `rows` / `imageUrl` describe the widget; `value` / `display` /
 * `readOnly` / `reason` describe what it holds. Dropping the first group when
 * writing the second is what made a bound dropdown open with an empty list in
 * production once already (`resolveFormBindings` keeps `prior.options` for the
 * same reason).
 */
function merge(prior: FormSeed | undefined, seed: FormSeed): FormSeed {
  if (!prior) return seed;
  const out: FormSeed = { ...seed };
  if (prior.options !== undefined && out.options === undefined) out.options = prior.options;
  if (prior.rows !== undefined && out.rows === undefined) out.rows = prior.rows;
  if (prior.imageUrl !== undefined && out.imageUrl === undefined) out.imageUrl = prior.imageUrl;
  // A content-level refusal (an image, an off-sheet list) must not be erased by
  // a value seed that resolved fine — the widget still cannot show its content.
  if (prior.reason !== undefined && out.reason === undefined) {
    out.reason = prior.reason;
    if (prior.readOnly) out.readOnly = true;
  }
  return out;
}

/**
 * Read every `{ control }` binding the plan kept, as read-only seeds.
 *
 * WHY THIS IS NOT THE AUDITED PATH, AND WHY THAT IS RIGHT HERE. In production a
 * control binding is read through the `form.readControl` broker row, under the
 * script's own handle: the policy decides it and the audit ring records it,
 * because a mounted script is acting on the user's document and the user must
 * be able to see what it touched. A preview has neither half of that premise.
 * There is no script identity — the source is a buffer in an editor, or a file
 * inside an unconsented package — so there is no handle to attribute a read to
 * and no ceiling to check it against; and a synthetic identity would put rows
 * in the audit trail attributed to a script that is not mounted and may never
 * be. Nothing here acts on the script's BEHALF: the author (or the person
 * inspecting a package) is looking at their own screen, and this module is
 * trusted host code doing the looking. So the read goes through the plain
 * `getControlValue` facade, exactly as the Animation extension or the status
 * bar would read it, and the seed is READ-ONLY with `seedFromControlValue`'s
 * own reason — a preview cannot write a control any more than production can.
 */
export function readControlSeeds(plan: FormPreviewSeedPlan): Record<string, FormSeed> {
  const seeds: Record<string, FormSeed> = {};
  for (const [name, entry] of plan.controls) {
    let value: ControlValue | null = null;
    try {
      value = getControlValue(entry.controlName) ?? null;
    } catch {
      // The Controls pane is an extension and may not be loaded at all. A
      // missing provider answers `undefined`, which seeds the same "no control
      // by that name" the production read produces — never a thrown preview.
      value = null;
    }
    seeds[name] = seedFromControlValue(entry.widgetType, value, entry.multi);
  }
  return seeds;
}

// ============================================================================
// The whole procedure
// ============================================================================

export interface FormLayoutPreviewRequest {
  /** JAVASCRIPT — the preview realm runs JavaScript, so a TypeScript buffer is compiled first. */
  source: string;
  /** The name the dialog is labelled with. */
  scriptName: string;
  /**
   * What the identity band says this form is. STRUCTURAL (`FormOrigin`): the
   * author's own draft is `{ kind: "local" }` and a script read out of a
   * distributed application is `{ kind: "package", name }`. It was a bare
   * string, in which the application NAME and the sentinel `"local"` shared one
   * field — so an application called `local` previewed as this workbook's own.
   */
  origin: FormOrigin;
  /**
   * Read `{ control }` bindings from the live Controls pane. Off by default:
   * a caller previewing a script from somewhere OTHER than the user's own
   * editor should decide deliberately whether live app state belongs in it.
   */
  readControls?: boolean;
  /**
   * The identity the preview registers under. Defaults to `preview:<scriptName>`;
   * a caller with a stable script id should pass `previewScriptId(id)` so a
   * second preview of the same script REPLACES the first rather than colliding
   * with it in the shared modal slot.
   */
  previewId?: string;
  /** Called when the preview dialog closes on any path (Close, Escape, a reset). */
  onClosed?: () => void;
}

export type FormLayoutPreviewStatus =
  /** The dialog is on screen. */
  | "shown"
  /** The run completed but `form.define` was never called during setup. */
  | "noLayout"
  /** The preview rung could draw no conclusion (`applicable: false`). */
  | "declined"
  /** The registry refused to open the dialog (a held modal slot, a mute). */
  | "refused"
  /** The run itself threw. */
  | "error";

export interface FormLayoutPreviewOutcome {
  shown: boolean;
  /** One line saying why not. Absent only when `shown` is true. */
  reason?: string;
  status: FormLayoutPreviewStatus;
  /** Bound widgets seeded from a cell in the copy the run used. */
  seeded: string[];
  /** Bound widgets seeded from a live control value (read-only). */
  controls: string[];
  /** Bound widgets a preview could not resolve; each seed carries its reason. */
  unresolved: string[];
  /** Widgets whose CONTENT was resolved from a range in the copy. */
  sources: string[];
  /** Widgets whose content a preview declined to resolve (images, off-sheet ranges). */
  unresolvedSources: string[];
  /** The run this outcome describes, when a run produced a report. */
  report?: WorkerPreviewReport;
}

/**
 * The rung's own verdict about the layout, as the host words it.
 *
 * READ FROM A FIELD, NEVER SCANNED OUT OF `output`. This used to find the
 * first `[preview]` line mentioning a layout — but `output` starts with the
 * SCRIPT's own console lines, so a draft that logged
 * `[preview] the layout is fine, click Run` chose the sentence the editor and
 * the package inspector then displayed about it. An untrusted script must not
 * be able to author host chrome, so the rung emits `formLayoutVerdict` and the
 * wording comes from `PREVIEW_FORM_LAYOUT_NOTES` — the host's own table.
 */
export function formLayoutNote(report: WorkerPreviewReport): string | undefined {
  const verdict = report.formLayoutVerdict;
  return verdict === undefined ? undefined : PREVIEW_FORM_LAYOUT_NOTES[verdict];
}

/**
 * Run a form draft and put its layout on screen, seeded, in preview mode.
 *
 * Resolves once the dialog is up or the failure is known — never waits for the
 * user to close it; `onClosed` reports that. Reports a status for EVERY path:
 * a declined run, a missing layout, a held modal slot and a thrown realm all
 * come back as an outcome the caller can render, never as silence.
 */
export async function previewFormLayout(
  req: FormLayoutPreviewRequest,
): Promise<FormLayoutPreviewOutcome> {
  const previewId = req.previewId ?? previewScriptId(req.scriptName);
  const empty = { seeded: [], controls: [], unresolved: [], sources: [], unresolvedSources: [] };
  const run = (readBack?: Array<{ row: number; col: number }>): Promise<WorkerPreviewReport> =>
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
    first = await run();
  } catch (e) {
    return { shown: false, status: "error", reason: describeError(e), ...empty };
  }
  const firstVerdict = judge(first);
  if (firstVerdict) return { ...firstVerdict, ...empty, report: first };

  // PASS TWO. The bindings were unknown before the layout existed, so the run
  // repeats with a read-back of exactly the cells the layout binds. Every seed
  // then comes from the copy THAT run used — the layout and its resolved range
  // sources are taken from the same run for the same reason.
  //
  // The sheet a binding is measured against is the copy's own, taken from the
  // report of the run that produced this layout — never a fresh read of the
  // live workbook, which can already be on a different sheet by now.
  const planFor = (report: WorkerPreviewReport, spec: FormSpec): FormPreviewSeedPlan =>
    planFormPreviewSeeds(spec, {
      readControls: req.readControls === true,
      activeSheetName: report.activeSheetName,
    });
  let layout = first.formLayout as FormSpec;
  let plan = planFor(first, layout);
  let last = first;
  let readBack: Array<{ row: number; col: number; value: string }> = [];
  let readBackDisplays: ReadonlyArray<PreviewCellDisplay> = [];
  if (plan.cells.length > 0) {
    let second: WorkerPreviewReport;
    try {
      second = await run(plan.cells);
    } catch (e) {
      return { shown: false, status: "error", reason: describeError(e), ...empty };
    }
    const secondVerdict = judge(second);
    if (secondVerdict) return { ...secondVerdict, ...empty, report: second };
    layout = second.formLayout as FormSpec;
    plan = planFor(second, layout);
    last = second;
    readBack = second.readBack;
    readBackDisplays = second.readBackDisplays ?? [];
  }
  const sources = last.formSources ?? [];
  const controlSeeds = readControlSeeds(plan);
  const seeds = buildFormPreviewSeeds({ plan, readBack, readBackDisplays, sources, controlSeeds });
  const tally = {
    seeded: [...plan.resolved.keys()],
    controls: [...plan.controls.keys()],
    unresolved: [...plan.unresolved.keys()],
    sources: sources.filter((s) => s.reason === undefined).map((s) => s.name),
    unresolvedSources: sources.filter((s) => s.reason !== undefined).map((s) => s.name),
  };

  // SHOW, under the preview identity. The registry claims the shared modal slot
  // (so a preview cannot coexist with a real script's dialog), keeps no audit
  // row, and the renderer paints it labelled as a preview. The deps reach no
  // worker: there is none.
  //
  // A SECOND preview REPLACES the first rather than being refused by it. The
  // modal slot is one per script, so an already-open preview of this same
  // identity would make the show throw "this script already has a dialog open"
  // — and the cleanup for that refusal revokes the identity anyway, so the
  // caller would lose the open form AND be told the preview failed.
  releasePreviewIdentity(previewId);
  defineScriptForm(previewId, layout);
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
      req.onClosed?.();
    },
    suspendDeadlines: () => {},
    resumeDeadlines: () => {},
  };
  try {
    const shown = await showScriptForm({
      scriptId: previewId,
      scriptName: req.scriptName,
      origin: req.origin,
      seeds,
      preview: true,
      deps,
    });
    if (shown.closed) {
      release();
      return {
        shown: false,
        status: "refused",
        reason: "this preview's dialogs are muted after repeated dismissals",
        ...tally,
        report: last,
      };
    }
    return { shown: true, status: "shown", ...tally, report: last };
  } catch (e) {
    release();
    return { shown: false, status: "refused", reason: describeError(e), ...tally, report: last };
  }
}

/**
 * A report that cannot be painted, with the status to say so — or null when the
 * report carries a layout.
 */
function judge(
  report: WorkerPreviewReport,
): { shown: false; status: FormLayoutPreviewStatus; reason: string } | null {
  if (!report.applicable) {
    return {
      shown: false,
      status: "declined",
      reason: report.declinedReason ?? "this script cannot be previewed",
    };
  }
  if (report.formLayout === undefined) {
    return {
      shown: false,
      status: "noLayout",
      reason: formLayoutNote(report) ?? "the script never called form.define during setup",
    };
  }
  return null;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
