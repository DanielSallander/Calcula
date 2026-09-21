//! FILENAME: app/extensions/ScriptableObjects/index.ts
// PURPOSE: ScriptableObjects extension entry point.
// CONTEXT: Manages the lifecycle of all object scripts — loads them from the backend
//          on workbook open, mounts them, and persists changes back. Also registers
//          the "Edit Script" context menu and the Code Tab dialog.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ensureScriptsAllowed } from "@api/scriptSecurity";
import {
  AppEvents,
  DialogExtensions,
  ObjectScriptManager,
  resetObjectScriptManager,
  loadAllObjectScripts,
  saveObjectScript,
  getScaffoldTemplate,
  showToast,
  resolveCapabilityRequest,
  resolveScriptDialog,
  dismissScriptDialog,
  SCRIPT_DIALOG_REQUEST_EVENT,
  parseDeclaredCapabilities,
  applyConsentedCapabilities,
  syncSchedulerPump,
  stopSchedulerPump,
  scriptOriginForMount,
  originPackageName,
  IconScript,
  IconTemplate,
  IconMarketplace,
  PanelExtensions,
} from "@api";
import type {
  CapabilityRequestPayload,
  CapabilityDecision,
  CapabilityId,
  ScriptDialogAnswer,
  ScriptDialogRequestPayload,
} from "@api";
import { listTemplates, stampFromTemplate, loadTemplate } from "./lib/templateManager";
import { loadConsents, recordConsent, getChangedScripts } from "./lib/consentStore";
import type { CapabilityGrant, ConsentRecord } from "./lib/consentStore";
import {
  isPackageConsentCurrent,
  listMacrosByPackage,
  listPackageMacros,
  packageConsentPlan,
} from "./lib/packageConsentSet";
import type { ConsentArtifact, PackageMacro } from "./lib/packageConsentSet";
import { emitAppEvent, onAppEvent } from "@api/events";
import {
  SCRIPT_FORM_CLOSE_EVENT,
  SCRIPT_FORM_INPUT_EVENT,
  SCRIPT_FORM_REQUEST_EVENT,
} from "@api/scriptHost/scriptFormSpec";
import type {
  ScriptFormClosePayload,
  ScriptFormInputPayload,
  ScriptFormRequestPayload,
} from "@api/scriptHost/scriptFormSpec";
import { hostStopTransientDebugSessions } from "@api/scriptHost/host";
import type { ObjectScriptDefinition, ScriptableObjectType } from "@api/scriptableObjects";
import React, { Suspense } from "react";
import ObjectScriptManagerPane from "./components/ObjectScriptManagerPane";
import {
  MountedScriptsSection,
  PolicyTableSection,
  ActivitySection,
} from "./components/PermissionsPanel";
import { CodeInThisFileSection } from "./components/CodeInThisFilePanel";
import ScriptConsentDialog from "./components/ScriptConsentDialog";
import CapabilityRequestDialog from "./components/CapabilityRequestDialog";
import ScriptDialogPrompt, {
  SCRIPT_DIALOG_ANSWERED_EVENT,
} from "./components/ScriptDialogPrompt";
import { ScriptFormDialog } from "./components/scriptForm";
import TemplateManagerDialog from "./components/TemplateManagerDialog";
import ScriptMarketplace from "./components/ScriptMarketplace";
import { installObjectScriptDebugBridge, reloadPersistedBreakpoints } from "./lib/debugger";
import type { DialogProps } from "@api/uiTypes";
import { openObjectScriptEditor, openMacroInEditor } from "./lib/openObjectScriptWindow";
import { registerScriptEditorProvider } from "@api/scriptEditorService";
import { installScriptDraftReview, openRememberedDraft } from "./lib/scriptDrafts";
import { installAiEditBridge, replayAiEditResults } from "./lib/aiEditBridge";
import { installFormPreviewBridge, replayFormPreviewResults } from "./lib/formPreviewBridge";
import { installScriptPaneHost } from "./lib/scriptPaneHost";
import { installScriptEmbedHost } from "./lib/scriptEmbedHost";
import { installEmbeddedFormLayer } from "./lib/embeddedFormLayer";
import { registerEmbeddedFormUx } from "./lib/embeddedFormUx";
import { closeEmbeddedScriptForm, openEmbeddedScriptForm } from "@api/scriptHost/host";
import { getActiveSheet } from "@api/lib";
import { registerCellBehaviorUx } from "./lib/cellBehaviorUx";
import { createFormScript } from "./lib/createForm";
import {
  onSaveAndApply,
  onRegisterScript,
  onToggleAccess,
  onEditorClosed,
  onEditorReady,
  emitConsoleOutput,
  emitScriptError,
  emitScriptsChanged,
} from "./lib/crossWindowEvents";

// Lazy-load CodeEditorDialog — Monaco has heavy module-level side effects
// that must not block extension activation.
const LazyCodeEditorDialog = React.lazy(() => import("./components/CodeEditorDialog"));
function CodeEditorDialog(props: DialogProps): React.ReactElement {
  return React.createElement(Suspense, { fallback: null },
    React.createElement(LazyCodeEditorDialog, props));
}

// ============================================================================
// Manifest
// ============================================================================

const manifest = {
  id: "calcula.scriptable-objects",
  name: "Scriptable Objects",
  version: "1.0.0",
  description: "Enables user-scriptable objects with per-type lifecycle hooks and Monaco editor integration.",
};

// ============================================================================
// Module State
// ============================================================================

const cleanupFunctions: Array<() => void> = [];

// ============================================================================
// Script Permissions panel (transparency surface)
// ============================================================================

const PERMISSIONS_PANEL_ID = "scriptable-objects.permissions";
const CODE_IN_FILE_PANEL_ID = "scriptable-objects.codeInThisFile";

/** SVG shield icon for the Script Permissions panel */
const ShieldIcon = React.createElement(
  "svg",
  {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  },
  // Shield outline
  React.createElement("path", {
    d: "M12 3 L19 6 V11 C19 15.5 16 19.5 12 21 C8 19.5 5 15.5 5 11 V6 Z",
  }),
  // Checkmark
  React.createElement("path", { d: "M9 11.5 L11.2 13.7 L15 9.5" }),
);

// ============================================================================
// Custom Events
// ============================================================================

export const ScriptableObjectEvents = {
  /** Emitted when an object script is opened for editing. */
  EDIT_SCRIPT: "scriptable-objects:edit-script",
  /** Emitted when scripts have been loaded/reloaded. */
  SCRIPTS_LOADED: "scriptable-objects:scripts-loaded",
  /** Emitted when a script is saved. */
  SCRIPT_SAVED: "scriptable-objects:script-saved",
  /** Emitted when distributed scripts need user consent to run. */
  SCRIPT_CONSENT_NEEDED: "scriptable-objects:consent-needed",
} as const;

// ============================================================================
// Activation
// ============================================================================

/**
 * THE SET OF ARTIFACTS ONE CONSENT SCREEN PUT IN FRONT OF THE USER, held from
 * the moment the prompt is emitted until its Allow is answered.
 *
 * The prompt and the grant used to come from two INDEPENDENT listings: the load
 * path listed the workbook once to build `moduleScriptNames`/`moduleScriptIds`,
 * and the `consent-granted` handler — which received nothing but
 * `{ packageName }` — re-derived both sets from scratch. Anything that changed
 * the workbook between the prompt appearing and Allow being pressed wrote a
 * record for a set the screen never showed. That is not theoretical: the consent
 * dialog is non-modal, `AppEvents.PACKAGE_UPDATED` re-runs the whole load, and a
 * Distribution ▸ Update or a gateway pull fires it — so a publisher's refresh
 * landing while the user reads the screen made Allow approve the NEW code under
 * the OLD screen's authority. The transparency requirement is the exact
 * inverse: what is granted must be what was displayed.
 *
 * So the prompt now carries a `promptId`, the artifact set it enumerated is
 * held here, and Allow echoes the id back. The handler grants THIS set — never a
 * fresh listing.
 */
interface PendingConsentGrant {
  /** Identity of the screen. Allow must echo it or the grant is refused. */
  promptId: string;
  /** Exactly what the prompt enumerated, in the order it will be recorded. */
  artifacts: ConsentArtifact[];
  /** The capability union the prompt showed, over the OBJECT scripts alone. */
  granted: CapabilityGrant[];
}

/** One pending prompt per application; a re-prompt supersedes its predecessor. */
const pendingGrants = new Map<string, PendingConsentGrant>();

/** Monotonic prompt id source. Session-local; never persisted. */
let promptSequence = 0;

/**
 * How many times ONE application may be re-asked in a session because a grant
 * for it was REFUSED — the screen it answered was gone, or the workbook moved
 * on underneath it.
 *
 * The refusal path re-prompts so the user is never stranded with no way to
 * approve, but each re-prompt is a fresh screen, and a workbook that keeps
 * changing between screen and click (a source that re-fires
 * `AppEvents.PACKAGE_UPDATED` continuously — none is known, so this is a
 * bound on a loop nothing is known to drive) would re-ask on every click,
 * forever. After this many re-asks the loop stops and says so; the next
 * workbook open, or the next update's own load pass, asks afresh. Exported so
 * the test that pins the bound reads the same number the toast prints.
 */
export const MAX_REFUSAL_REPROMPTS_PER_SESSION = 3;

/** Re-asks issued per application, this session, by the refusal path alone. */
const refusalReprompts = new Map<string, number>();

/**
 * An order-insensitive fingerprint of an artifact set: id + source for every
 * artifact, sorted by id.
 *
 * ORDER IS DELIBERATELY NOT PART OF IT. The prompt's set comes from
 * `loadAllObjectScripts()` and the grant's from `ObjectScriptManager`, which are
 * two different iteration orders over the same data; comparing them positionally
 * would refuse grants for a difference the user cannot see and that means
 * nothing. What must match is WHICH artifacts, and WHAT CODE each one is.
 *
 * Every part is LENGTH-PREFIXED, so no separator can be forged out of an id or a
 * source body: a script with id `"a"` and source `"1:b"` must not fingerprint
 * the same as one with id `"a:1"` and source `"b"`.
 */
function artifactFingerprint(artifacts: ConsentArtifact[]): string {
  return [...artifacts]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((a) => `${a.id.length}:${a.id}:${a.source.length}:${a.source}`)
    .join("");
}

/** Short, user-facing phrase per capability for the consent prompt. */
const CAPABILITY_DESCRIPTION: Record<CapabilityId, string> = {
  "net.fetch": "Fetch data from the web (https only, no cookies)",
  "bi.query": "Run read-only, model-scoped queries on this workbook's BI connections",
  "bi.sql": "Run read-only RAW SQL against this workbook's BI database (any reachable table)",
  storage: "Store script-private data in this workbook",
  "ui.html": "Render sandboxed HTML inside its object",
  "ui.htmlInput":
    "Receive what you click and type inside the HTML it draws — where it claims your input, it reaches the script instead of Calcula: on the grid a click stops selecting a cell, and on a Controls-pane card the whole card is taken at once",
  "formula.udf": "Evaluate its functions in worksheet formulas",
  "bi.model": "Modify this workbook's BI model definitions (measures, relationships, ... — undoable; never security roles or connections)",
  "bi.connector": "Feed external data into this workbook's BI model as a data connector",
  "ui.dialog": "Interrupt you with a dialog box and read what you answer",
  "ui.pane": "Show a task pane you can keep open beside the grid while you work, and read what you enter in it",
  "distribution.writeback":
    "Fill in and send the input cells of a subscribed application — and, for an application this workbook can sign, read and approve everyone else's answers",
  schedule:
    "Run itself on a schedule while Calcula is open, saved in this workbook so it resumes after a reload",
  "file.picker":
    "Ask you to pick a file to save data into or to read — you choose the file every time, and it is never told where your files are",
  "ui.shortcut":
    "Take over one Ctrl+Shift+letter keyboard shortcut so pressing it runs its code — never a shortcut Calcula needs or something else already uses, and it never sees anything else you type",
  // Object scripts do not reach the grid through this capability — their grid
  // access is governed by the TIER (own sheet at restricted, any sheet at
  // unlocked). It is phrased here because this map must cover the whole
  // vocabulary, and because a package may carry a sandboxed add-in whose
  // cell-styling contribution and cell-change subscription DO need it.
  "grid.read":
    "Be shown the contents of your cells — the value of every cell on screen while it decides how to style them, the old value, new value and formula of every cell that changes, and what is in any cell a field of its form points at",
  // This map is rendered ONLY by the PACKAGE consent prompt (see
  // computePackageCapabilities below), and a script that arrived in a package
  // is forced to the restricted tier while every cap.pkg* row is unlocked-tier.
  // So these two can be REQUESTED here and never exercised. Saying only what
  // the capability means would overstate what allowing actually permits; say
  // what it asked for, then say that this surface refuses it. Same phrasing as
  // Distribution/components/SubscribeDialog.tsx, which reached this conclusion
  // first.
  "distribution.publish":
    "Publish this workbook to one of your workspaces, signed with YOUR publisher key, where everyone subscribed will receive it (a script that arrived in an application cannot actually do this — Calcula refuses it — but it asked)",
  "distribution.subscribe":
    "Bring somebody else's published applications into this workbook, and update the ones you subscribe to (a script that arrived in an application cannot actually do this — Calcula refuses it — but it asked)",
};

/**
 * The consent key a DISTRIBUTED OBJECT SCRIPT's application is recorded under —
 * ASKED OF `scriptOriginForMount`, never re-derived here.
 *
 * That function is what the MOUNT GATE uses: `requireDistributedMountConsent`
 * (app/src/api/scriptHost/host.ts) calls `check_distributed_mount_consent` with
 * `scriptOriginForMount(definition).name`, and Rust looks the record up under
 * exactly that string. So the key this path writes and the key that gate asks
 * for are now the same value by construction, including the placeholder for a
 * script with no name, and no future edit can drift one from the other.
 *
 * IT USED TO BE RE-DERIVED, AND IT DID NOT MATCH: this path spelled the
 * nameless case `"unknown"` while the origin's placeholder is
 * `UNKNOWN_PACKAGE_NAME` — `"(unknown package)"`. The prompt was shown, the user
 * approved, the record was written under `"unknown"`, and every mount was then
 * refused against a key nothing had ever written. That state is reachable: on
 * `ObjectScriptDef` (core/calcula-format/src/features/object_scripts.rs) both
 * `provenance` and `package_name` are `#[serde(default)]`, so a `.cala` carrying
 * `"provenance": "distributed"` with no `packageName` parses cleanly into it,
 * and `save_object_script` preserves the stored pair verbatim. (A `.calp` pull
 * always stamps a name — `pull.rs` sets both fields together — so the ingress is
 * the workbook file, not the subscription.)
 *
 * Returns `""` for a LOCAL script, which can never join a package group.
 */
function objectScriptPackageKey(script: { provenance?: string; packageName?: string }): string {
  return originPackageName(scriptOriginForMount(script)) ?? "";
}

/** Shape of one requested capability in the consent-needed event payload. */
interface RequestedCapability {
  capability: CapabilityId;
  description: string;
  origins: string[];
}

/**
 * The union of capabilities DECLARED across a package's scripts (each script's
 * `// @capability` pragmas). Returns both the rich list for the consent prompt
 * and the CapabilityGrant[] persisted as the package's consent.
 */
function computePackageCapabilities(
  scripts: Array<{ source: string }>,
): { requested: RequestedCapability[]; granted: CapabilityGrant[] } {
  const originsByCap = new Map<CapabilityId, Set<string>>();
  for (const script of scripts) {
    const declared = parseDeclaredCapabilities(script.source);
    for (const cap of declared.caps) {
      if (!originsByCap.has(cap)) originsByCap.set(cap, new Set());
    }
    // Origins only attach to net.fetch (parse already filtered to https origins).
    if (declared.origins.length > 0) {
      const set = originsByCap.get("net.fetch") ?? new Set<string>();
      for (const o of declared.origins) set.add(o);
      originsByCap.set("net.fetch", set);
    }
  }

  const requested: RequestedCapability[] = [];
  const granted: CapabilityGrant[] = [];
  for (const [capability, origins] of originsByCap) {
    const originList = [...origins];
    requested.push({
      capability,
      description: CAPABILITY_DESCRIPTION[capability] ?? capability,
      origins: originList,
    });
    granted.push(
      originList.length > 0 ? { capability, origins: originList } : { capability },
    );
  }
  return { requested, granted };
}

/**
 * Build ONE application's consent screen, remember exactly what it enumerated,
 * and emit it.
 *
 * This is the single emitter of SCRIPT_CONSENT_NEEDED, and the single writer of
 * `pendingGrants`, so the set the screen shows and the set Allow records are the
 * same object rather than two listings that agree by luck.
 */
async function emitPackageConsentPrompt(
  persistedConsents: ConsentRecord[],
  pkg: string,
  pkgScripts: ObjectScriptDefinition[],
  pkgMacros: PackageMacro[],
): Promise<void> {
  // The capability union stays over the OBJECT scripts alone. A macro's
  // `// @capability` pragmas are not folded in: nothing grants a macro
  // capabilities out of this record (see lib/packageConsentSet.ts), so adding
  // them would only put a capability the prompt never attributed to the
  // object-script realm into the application's grant.
  const { requested, granted } = computePackageCapabilities(pkgScripts);

  // WHAT THIS RECORD CAN AND CANNOT COVER. A macro whose id is already claimed
  // by an object script cannot go into a flat id-keyed record, so Allow will not
  // approve it and the prompt must not imply otherwise — it is named separately,
  // as something that stays refused.
  const plan = packageConsentPlan(pkgScripts, pkgMacros);
  const approvableMacros = plan.covered;

  // The DIFF spans both kinds — a macro whose source changed upstream is
  // exactly what a re-consent prompt must show, and it is why the grant is
  // re-asked at all. It is taken over the artifacts this grant COVERS: an
  // id-colliding macro shares an id with an object script's record entry, so
  // diffing it would compare the macro's source against the object script's
  // approved source and report a change that is really a collision.
  const changed = await getChangedScripts(persistedConsents, pkg, [
    ...pkgScripts,
    ...approvableMacros,
  ]);
  const changedScripts = changed.map((c) => ({
    id: c.id,
    name:
      pkgScripts.find((s) => s.id === c.id)?.name ??
      approvableMacros.find((m) => m.id === c.id)?.name ??
      c.id,
    oldSource: c.oldSource,
    newSource: c.newSource,
  }));

  promptSequence += 1;
  const promptId = `consent-${promptSequence}`;
  pendingGrants.set(pkg, { promptId, artifacts: plan.artifacts, granted });

  emitAppEvent(ScriptableObjectEvents.SCRIPT_CONSENT_NEEDED, {
    // THE SCREEN'S IDENTITY. Allow echoes it back, and a grant that does not
    // carry the id of a prompt still standing is refused rather than applied to
    // whatever the workbook holds by then.
    promptId,
    packageName: pkg,
    scriptCount: pkgScripts.length,
    scriptNames: pkgScripts.map((s) => s.name),
    scriptIds: pkgScripts.map((s) => s.id),
    // WHAT IS GRANTED IS WHAT IS SHOWN. The macros go into the record, so they
    // are named on the prompt that writes it — and the ids travel with the names
    // so the prompt's Inspect affordance can open one. An application that
    // shipped only macros has no object script to inspect, and a button that
    // silently does nothing on the last screen before a stranger's code runs is
    // worse than no button.
    moduleScriptNames: approvableMacros.map((m) => m.name),
    moduleScriptIds: approvableMacros.map((m) => m.id),
    // ...and what it CANNOT grant, said out loud. Pressing Allow will not make
    // these run, so the screen may not leave the user pressing it again.
    unapprovableMacroNames: plan.unapprovable.map((m) => m.name),
    requestedCapabilities: requested,
    changedScripts,
  });
}

/**
 * Re-ask for ONE application, from the workbook as it stands right now.
 *
 * Used when a grant arrives that cannot honestly be applied — the screen it came
 * from is gone, or the workbook moved on underneath it. Nothing is recorded and
 * nothing is mounted; the user is asked again about the code that is actually
 * there.
 */
async function repromptPackage(packageName: string): Promise<void> {
  pendingGrants.delete(packageName);

  // The STORE, for the same reason the grant handler reads it: the session
  // registry still holds scripts an update removed, and re-prompting from it
  // offers to approve code the application no longer ships.
  const scripts = (await loadAllObjectScripts()).filter(
    (s) => s.provenance === "distributed" && objectScriptPackageKey(s) === packageName,
  );
  let macros: PackageMacro[] = [];
  try {
    macros = await listPackageMacros(packageName);
  } catch (e) {
    console.warn("[ScriptableObjects] Module-script listing failed:", e);
  }
  // The application left the workbook entirely (an unsubscribe landed while the
  // prompt was open). There is nothing to approve, so there is nothing to ask.
  if (scripts.length === 0 && macros.length === 0) return;

  const persistedConsents = await loadConsents();
  await emitPackageConsentPrompt(persistedConsents, packageName, scripts, macros);
}

/**
 * Refuse a grant that cannot honestly be applied, tell the user why — with the
 * re-ask count — and re-ask, up to `MAX_REFUSAL_REPROMPTS_PER_SESSION` times
 * per application per session.
 *
 * `reason` is the clause after "Nothing was approved for X:", ending in a full
 * stop. The count is in the toast on purpose: a user who sees "re-ask 3 of 3"
 * knows the next refusal is the last one, rather than discovering it as a
 * prompt that silently stops coming back.
 */
async function refuseGrantAndReprompt(packageName: string, reason: string): Promise<void> {
  const asked = (refusalReprompts.get(packageName) ?? 0) + 1;
  refusalReprompts.set(packageName, asked);
  if (asked > MAX_REFUSAL_REPROMPTS_PER_SESSION) {
    // The bound. Nothing is recorded and no screen stands; the load pass on
    // the next open or update asks afresh, because that pass does not come
    // through here.
    pendingGrants.delete(packageName);
    showToast(
      `Nothing was approved for "${packageName}": ${reason} Calcula has already ` +
        `asked again ${MAX_REFUSAL_REPROMPTS_PER_SESSION} times this session and ` +
        "will not re-ask on its own again until the workbook is reopened or the " +
        "application is next updated.",
      { type: "error", duration: 0 },
    );
    return;
  }
  showToast(
    `Nothing was approved for "${packageName}": ${reason} Calcula will ask again ` +
      "about the code this workbook has now " +
      `(re-ask ${asked} of ${MAX_REFUSAL_REPROMPTS_PER_SESSION} this session).`,
    { type: "error", duration: 0 },
  );
  await repromptPackage(packageName);
}

/**
 * Load, register, and mount all scripts. For distributed scripts,
 * check if the user has consented to run them — either in this session or
 * via a persisted consent in the workbook (keyed by script source hash, so
 * upstream script changes re-prompt).
 */
async function loadAndMountScripts(cause?: "open"): Promise<void> {
  // Honor the global Script Security setting: object scripts (button/shape/
  // slicer behaviors) are user-authored code, so a "disabled" — or an
  // unconfirmed "prompt" — setting must keep them inert. This is the primary
  // automation surface; it previously consulted nothing.
  const allowed = await ensureScriptsAllowed(
    "This workbook contains object scripts (e.g. button and shape behaviors). Allow them to run?",
  );
  if (!allowed) {
    return;
  }

  const scripts = await loadAllObjectScripts();
  const localScripts = scripts.filter((s) => !s.provenance || s.provenance === "local");
  const distributedScripts = scripts.filter((s) => s.provenance === "distributed");

  // Register and mount all local scripts immediately
  for (const script of localScripts) {
    ObjectScriptManager.registerScript(script);
  }
  // mountScript THROWS now. One broken script must not stop the other twenty
  // from starting — but it must not vanish either, so the failures are
  // collected and reported together at the end. (Each one also emits
  // `objectscript:error`, which this extension routes to its own toast; the
  // summary below is what tells the user HOW MANY of their scripts are dead.)
  const mountFailures: string[] = [];
  for (const script of localScripts) {
    try {
      await ObjectScriptManager.mountScript(script.id, { cause });
    } catch (e) {
      mountFailures.push(
        `${script.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (mountFailures.length > 0) {
    showToast(
      `${mountFailures.length} of this workbook's ${localScripts.length} object ` +
        `script(s) could not start, so the objects they drive will not respond: ` +
        mountFailures.join(" | "),
      { type: "error", duration: 0 },
    );
  }

  // ---- Distributed code: group by application, then decide consent ----
  //
  // The MACROS these applications shipped, grouped once. They are listed on the
  // subscribe review as "Module scripts — executable code", and the Rust module
  // gate asks this workbook's consent record for them by id + source hash — so
  // they belong in the same grant as the object scripts. Before this they were in
  // no consent record the app could write, and every one of them was refused
  // forever with an error naming an approval nothing could give.
  //
  // THE LISTING IS TAKEN UNCONDITIONALLY, not only when an object script happens
  // to exist to trigger it. `core/calp/src/pull.rs` materializes `modules/*.json`
  // independently of `object_scripts/*.json`, so a `.calp` may ship macros and NO
  // object scripts at all. While this whole block was gated on
  // `distributedScripts.length > 0`, such an application emitted no
  // SCRIPT_CONSENT_NEEDED (this is its single emitter), wrote no bare-name
  // consent record, and every one of its macros stayed refused forever — the
  // same dead end, still open for that one shape. It costs one listing on a
  // workbook that carries no distributed code at all; the alternative is a
  // publisher's macros being unapprovable, which is not a trade.
  let macrosByPackage = new Map<string, PackageMacro[]>();
  try {
    macrosByPackage = await listMacrosByPackage();
  } catch (e) {
    // The listing failed, so this pass cannot honestly cover the macros. The
    // object scripts still get their normal decision below; a macro run is
    // refused by Rust with its own message, which the user sees at Run.
    console.warn("[ScriptableObjects] Module-script listing failed:", e);
  }

  const byPackage = new Map<string, typeof distributedScripts>();
  for (const script of distributedScripts) {
    const pkg = objectScriptPackageKey(script);
    if (!byPackage.has(pkg)) byPackage.set(pkg, []);
    byPackage.get(pkg)!.push(script);
  }

  // THE UNION OF BOTH STORES drives the pass. An application contributes a
  // package here if it shipped object scripts, or macros, or both — and each is
  // evaluated with whatever the other store holds for the same key, which is
  // also what `packageConsentArtifacts` will write into the record.
  const packageNames = [...new Set([...byPackage.keys(), ...macrosByPackage.keys()])];

  if (packageNames.length > 0) {
    const persistedConsents = await loadConsents();

    for (const pkg of packageNames) {
      const pkgScripts = byPackage.get(pkg) ?? [];
      const pkgMacros = macrosByPackage.get(pkg) ?? [];

      // Register all distributed scripts (so they appear in the UI)
      for (const script of pkgScripts) {
        ObjectScriptManager.registerScript(script);
      }

      // FRESHNESS IS EVALUATED ON EVERY PASS, AND IT MAY REVOKE. THERE IS NO
      // SESSION CACHE OF THE ANSWER.
      //
      // `isPackageConsentCurrent` is the ONLY place a macro's presence and hash
      // are ever checked, and it used to run only when a session set
      // (`consentedPackages`) did not already hold the package. That set was
      // cleared on AFTER_OPEN but NOT by AppEvents.PACKAGE_UPDATED, which
      // re-runs this whole load — so for an application approved earlier in
      // the session (or hydrated as current when the workbook opened), a
      // Distribution ▸ Update that brought a NEW or CHANGED macro was never
      // looked at: nothing was recorded, the macro was then refused by Rust,
      // and no prompt would ever appear to fix it. Once the check ran on every
      // pass the set had no reader left, and a write-only cache of a security
      // decision is a cache waiting for someone to read it again — so it is
      // gone, and the persisted record is the only memory of an approval.
      //
      // A package that no longer matches its record is prompted again.
      // Already-mounted object scripts are deliberately left running — they
      // are individually still hash-consented (a stale macro alone can fail
      // this check), and Allow re-records and re-mounts.
      let current = false;
      try {
        current = await isPackageConsentCurrent(persistedConsents, pkg, pkgScripts, pkgMacros);
      } catch (e) {
        // FAILS CLOSED. "I could not find out whether you approved this
        // application's code" is not approval, because the thing that threw is
        // the only thing that can tell us the record still covers what is
        // about to run.
        console.warn("[ScriptableObjects] Consent check failed:", e);
        current = false;
      }

      if (current) {
        // Hydrate path: consent == "all declared" in 4.2a, so re-derive each
        // script's declared caps/origins from its own source and GRANT them
        // into the live set BEFORE mounting, so buildHandleFromDefinition sees
        // them when it builds the handle.
        for (const script of pkgScripts) {
          const declared = parseDeclaredCapabilities(script.source);
          await applyConsentedCapabilities(script.id, declared.caps, declared.origins);
          try {
            await ObjectScriptManager.mountScript(script.id, { cause });
          } catch (e) {
            // Keep mounting the package's other scripts; the failure is already
            // travelling as `objectscript:error` -> toast.
            console.error(
              `[ScriptableObjects] "${script.name}" from "${pkg}" failed to mount:`,
              e,
            );
          }
        }
      } else {
        // Ask. The screen is built — and REMEMBERED — by the one emitter, so
        // the artifact set the user reads is the artifact set Allow records.
        await emitPackageConsentPrompt(persistedConsents, pkg, pkgScripts, pkgMacros);
      }
    }
  }

  emitAppEvent(ScriptableObjectEvents.SCRIPTS_LOADED, { count: scripts.length });

  // Start the scheduler's clock if this workbook carries any job.
  //
  // Rust restores the schedule during `open_file` and is the authority on what
  // may fire, but it cannot call into a worker realm — the renderer has to tick
  // it. This is the ONLY place that knows "this workbook's scripts are now
  // loaded", so it is where the pump is started; without it a job restored from
  // the .cala would sit correctly in the registry and simply never run.
  //
  // Deliberately AFTER the early return above: when Script Security refuses the
  // workbook's scripts, no pump starts at all (Rust's `due` would also return
  // nothing, so this is belt-and-braces, not the gate). The pump itself is a
  // no-op when the registry is empty, and each tick re-derives mount + grant, so
  // starting it before a pending consent prompt is answered runs nothing.
  await syncSchedulerPump();
}

async function activate(context: ExtensionContext): Promise<void> {
  // ---- Consent dialog + listeners FIRST ----
  // loadAndMountScripts emits SCRIPT_CONSENT_NEEDED synchronously; if the
  // dialog/listeners register after the initial load, a workbook that
  // already contains distributed scripts at activation loses its consent
  // prompt for the whole session.
  // No width/height here. DialogContainer renders the component with isOpen /
  // onClose / data and never reads either field, and the prompt now sizes
  // itself from its payload — one column at 460px for a light application, two
  // at 860px once the disclosure would otherwise run off the bottom. A dead
  // 460x400 sitting here was a second source of truth that could only drift.
  context.ui.dialogs.register({
    id: "scriptable-objects.consent",
    title: "Script Security",
    component: ScriptConsentDialog,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister("scriptable-objects.consent"));

  // Consent prompts are shown one at a time: dialog state is keyed by dialog
  // id, so showing a second package's prompt while one is open would
  // overwrite the first before React ever renders it.
  const consentQueue: Array<Record<string, unknown>> = [];
  let activeConsentPackage: string | null = null;

  const showNextConsent = (): void => {
    if (activeConsentPackage !== null) return;
    const next = consentQueue.shift();
    if (!next) return;
    activeConsentPackage = next.packageName as string;
    context.ui.dialogs.show("scriptable-objects.consent", next);
  };

  cleanupFunctions.push(
    onAppEvent(ScriptableObjectEvents.SCRIPT_CONSENT_NEEDED, (detail) => {
      const request = detail as Record<string, unknown>;
      const pkg = request.packageName as string;
      // De-dupe: this package is already being prompted or is queued
      if (activeConsentPackage === pkg || consentQueue.some((r) => r.packageName === pkg)) {
        return;
      }
      consentQueue.push(request);
      showNextConsent();
    }),
  );

  // Advance the queue when the consent dialog closes — covers Allow, Block,
  // and Escape (the dialog container closes on Escape without firing any
  // consent event, so the granted/denied handlers alone would stall the queue).
  cleanupFunctions.push(
    DialogExtensions.onChange(() => {
      if (activeConsentPackage === null) return;
      const stillOpen = DialogExtensions.getVisibleDialogs()
        .some((d) => d.definition.id === "scriptable-objects.consent");
      if (!stillOpen) {
        activeConsentPackage = null;
        showNextConsent();
      }
    }),
  );

  // ---- JIT capability-grant dialog + listeners ----
  // When a LOCAL script first calls an ungranted capability, the host emits
  // "scriptable-objects:capability-request" and AWAITS the user's decision via
  // resolveCapabilityRequest(requestId, decision). The dialog (Task 1) signals
  // the choice back through "scriptable-objects:capability-decided"; any close
  // WITHOUT a decision (Escape / overlay / dismiss) must fail closed = "deny".
  const CAPABILITY_DIALOG_ID = "scriptable-objects.capability";
  context.ui.dialogs.register({
    id: CAPABILITY_DIALOG_ID,
    title: "Permission request",
    component: CapabilityRequestDialog,
    width: 460,
    height: 340,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister(CAPABILITY_DIALOG_ID));

  // One-at-a-time queue: dialog state is keyed by dialog id, so showing a
  // second request while one is open would overwrite the first.
  const capabilityQueue: CapabilityRequestPayload[] = [];
  let activeCapabilityRequest: CapabilityRequestPayload | null = null;
  // Tracks whether the active request was answered with an explicit decision.
  // When the dialog closes and this is still false (Escape/overlay/dismiss),
  // the request is resolved "deny".
  let activeCapabilityDecided = false;

  const showNextCapability = (): void => {
    if (activeCapabilityRequest !== null) return;
    const next = capabilityQueue.shift();
    if (!next) return;
    activeCapabilityRequest = next;
    activeCapabilityDecided = false;
    context.ui.dialogs.show(CAPABILITY_DIALOG_ID, next as unknown as Record<string, unknown>);
  };

  cleanupFunctions.push(
    onAppEvent("scriptable-objects:capability-request", (detail) => {
      const request = detail as CapabilityRequestPayload;
      // De-dupe by requestId: each request is unique, but guard re-emits.
      if (
        activeCapabilityRequest?.requestId === request.requestId ||
        capabilityQueue.some((r) => r.requestId === request.requestId)
      ) {
        return;
      }
      capabilityQueue.push(request);
      showNextCapability();
    }),
  );

  // The dialog emits the user's choice; record it and resolve the host request.
  cleanupFunctions.push(
    onAppEvent("scriptable-objects:capability-decided", (detail) => {
      const { requestId, decision } = detail as {
        requestId: string;
        decision: CapabilityDecision;
      };
      if (activeCapabilityRequest?.requestId === requestId) {
        activeCapabilityDecided = true;
      }
      resolveCapabilityRequest(requestId, decision);
    }),
  );

  // Advance the queue when the capability dialog closes — covers Allow once,
  // Allow always, Deny, and Escape. If the dialog closed without a decision
  // (Escape/overlay/dismiss), fail closed by resolving "deny".
  cleanupFunctions.push(
    DialogExtensions.onChange(() => {
      if (activeCapabilityRequest === null) return;
      const stillOpen = DialogExtensions.getVisibleDialogs()
        .some((d) => d.definition.id === CAPABILITY_DIALOG_ID);
      if (!stillOpen) {
        const closed = activeCapabilityRequest;
        const decided = activeCapabilityDecided;
        activeCapabilityRequest = null;
        activeCapabilityDecided = false;
        if (!decided) {
          // No explicit answer — dismissed prompts fail closed.
          resolveCapabilityRequest(closed.requestId, "deny");
        }
        showNextCapability();
      }
    }),
  );

  // ---- ui.dialog: the script-asks-the-user modal ----
  // The host (scriptHost/scriptDialogs.ts) emits SCRIPT_DIALOG_REQUEST_EVENT and
  // awaits an answer. The abuse guards (one dialog per script, one app-wide, the
  // dismissal-streak mute) are enforced host-side BEFORE the event is emitted, so
  // there is deliberately no queue here: at most one request can ever be live,
  // and a request that arrives while one is showing was already rejected.
  //
  // The invariant this wiring exists to keep: EVERY close resolves. The dialog
  // emits an explicit answer for OK/Cancel/Escape; if it closes having emitted
  // nothing (the dialog manager closed it, the window went away), the close
  // watcher below resolves the request as dismissed. A script awaiting a dialog
  // must never be left hanging.
  const SCRIPT_DIALOG_ID = "scriptable-objects.scriptDialog";
  context.ui.dialogs.register({
    id: SCRIPT_DIALOG_ID,
    title: "Script dialog",
    component: ScriptDialogPrompt,
    width: 460,
    height: 300,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister(SCRIPT_DIALOG_ID));

  let activeScriptDialog: ScriptDialogRequestPayload | null = null;
  let activeScriptDialogAnswered = false;

  cleanupFunctions.push(
    onAppEvent(SCRIPT_DIALOG_REQUEST_EVENT, (detail) => {
      const request = detail as ScriptDialogRequestPayload;
      if (activeScriptDialog !== null) {
        // Should be unreachable (the host's one-at-a-time guard runs first);
        // if it ever happens, refuse rather than silently drop the request —
        // dropping it would hang the awaiting script.
        dismissScriptDialog(request.requestId);
        return;
      }
      activeScriptDialog = request;
      activeScriptDialogAnswered = false;
      context.ui.dialogs.show(SCRIPT_DIALOG_ID, request as unknown as Record<string, unknown>);
    }),
  );

  cleanupFunctions.push(
    onAppEvent(SCRIPT_DIALOG_ANSWERED_EVENT, (detail) => {
      const { requestId, answer } = detail as { requestId: string; answer: ScriptDialogAnswer };
      if (activeScriptDialog?.requestId === requestId) {
        activeScriptDialogAnswered = true;
      }
      resolveScriptDialog(requestId, answer);
    }),
  );

  cleanupFunctions.push(
    DialogExtensions.onChange(() => {
      if (activeScriptDialog === null) return;
      const stillOpen = DialogExtensions.getVisibleDialogs()
        .some((d) => d.definition.id === SCRIPT_DIALOG_ID);
      if (stillOpen) return;
      const closed = activeScriptDialog;
      const answered = activeScriptDialogAnswered;
      activeScriptDialog = null;
      activeScriptDialogAnswered = false;
      if (!answered) {
        // Closed without an answer — dismissal is the only safe reading, and
        // resolving is mandatory (a hung await is worse than a "no").
        dismissScriptDialog(closed.requestId);
      }
    }),
  );

  // ---- TypeScript Forms: the script-defined form modal ----
  // The host registry (scriptHost/scriptForms.ts) emits SCRIPT_FORM_REQUEST_EVENT
  // and then listens for SCRIPT_FORM_INPUT_EVENT; it owns the guards (one form
  // per script, one app-wide, the deadlines) and closes the form by emitting
  // SCRIPT_FORM_CLOSE_EVENT. As with ui.dialog there is no queue here: a second
  // request while one shows was already refused host-side, and if one ever
  // arrives anyway it is answered "cancel" rather than dropped — dropping it
  // would hang the awaiting script.
  //
  // The invariant this wiring keeps: EVERY close reaches the host. The
  // component emits submit/cancel itself; if the dialog closes having emitted
  // neither (the dialog manager closed it, the window went away), the close
  // watcher emits the cancel. A host that has already CLOSED the form ignores
  // a late cancel for a showId it no longer tracks.
  const SCRIPT_FORM_DIALOG_ID = "scriptable-objects.scriptForm";
  context.ui.dialogs.register({
    id: SCRIPT_FORM_DIALOG_ID,
    title: "Script form",
    component: ScriptFormDialog,
    width: 460,
    height: 360,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister(SCRIPT_FORM_DIALOG_ID));

  // The session the dialog on screen belongs to, or null when the HOST has
  // settled it. Nothing else is tracked here: whether the renderer has sent a
  // terminal event is the host's business, and this extension guessing at it
  // is what left a session open after an Escape during a pending submit.
  let activeScriptForm: ScriptFormRequestPayload | null = null;

  cleanupFunctions.push(
    onAppEvent(SCRIPT_FORM_REQUEST_EVENT, (detail) => {
      const request = detail as ScriptFormRequestPayload;
      if (activeScriptForm !== null) {
        // Unreachable while the host's one-at-a-time guard runs first; if it
        // ever happens, refuse by name rather than silently drop the request.
        const refusal: ScriptFormInputPayload = { showId: request.showId, kind: "cancel", values: {} };
        emitAppEvent(SCRIPT_FORM_INPUT_EVENT, refusal);
        return;
      }
      activeScriptForm = request;
      context.ui.dialogs.show(SCRIPT_FORM_DIALOG_ID, request as unknown as Record<string, unknown>);
    }),
  );

  cleanupFunctions.push(
    onAppEvent(SCRIPT_FORM_CLOSE_EVENT, (detail) => {
      const close = detail as ScriptFormClosePayload;
      if (activeScriptForm?.showId !== close.showId) return;
      // The HOST closed the session, so nothing is owed back to it. Forgetting
      // the form here is also what stops the close watcher below sending a
      // cancel for a session that is already settled.
      activeScriptForm = null;
      // Take the dialog down from HERE as well as in the component. The
      // component closes itself on this event, but only if it is mounted and
      // subscribed: a show that is closed immediately (a deadline, a revoke,
      // an unmount landing in the same tick) would otherwise leave an empty
      // modal on screen belonging to a session that no longer exists. Hiding a
      // dialog that has already closed itself is a no-op.
      context.ui.dialogs.hide(SCRIPT_FORM_DIALOG_ID);
    }),
  );

  cleanupFunctions.push(
    DialogExtensions.onChange(() => {
      if (activeScriptForm === null) return;
      const stillOpen = DialogExtensions.getVisibleDialogs()
        .some((d) => d.definition.id === SCRIPT_FORM_DIALOG_ID);
      if (stillOpen) return;
      const closedForm = activeScriptForm;
      activeScriptForm = null;
      // THE DIALOG IS GONE AND THE HOST STILL HAS THE SESSION OPEN, so it is
      // told — unconditionally. A form the host has already closed cleared
      // `activeScriptForm` on SCRIPT_FORM_CLOSE_EVENT above, so this cannot
      // fire for a settled session; anything still tracked here is a session
      // waiting for an answer that can no longer arrive from a dialog nobody
      // can see. Cancel is the only safe reading of that.
      //
      // This used to be skipped whenever a terminal event had left the
      // renderer, which was exactly wrong for the one case that mattered:
      // Submit sends "submit", the host is awaiting the script's onSubmit
      // verdict, the user presses Escape, and the dialog manager takes the
      // dialog down. Nothing was sent, the session stayed open holding the
      // app-wide modal slot until the 30-minute idle deadline, and every other
      // script dialog was refused for that whole time.
      const cancelled: ScriptFormInputPayload = { showId: closedForm.showId, kind: "cancel", values: {} };
      emitAppEvent(SCRIPT_FORM_INPUT_EVENT, cancelled);
    }),
  );

  // ---- TypeScript Forms, M2: script task panes (modeless) ----
  // The host registry (scriptHost/scriptPanes.ts) emits SCRIPT_PANE_REQUEST_EVENT
  // and listens for SCRIPT_PANE_INPUT_EVENT; it owns the guards (the per-script
  // cap, the dock and update buckets, ownership) and takes a pane down by
  // emitting SCRIPT_PANE_CLOSE_EVENT. Unlike the form there is no modal slot and
  // no one-at-a-time rule: several panes can be up, so the wiring is a LIST of
  // panels keyed by the host-minted pane id, each rendered by the same trusted
  // widget tree the form paints, hosted through the panel seam so the user
  // decides where it lives. The user's close reaches the registry first; the
  // panel comes down on the CLOSE it answers with (lib/scriptPaneHost.ts).
  cleanupFunctions.push(
    installScriptPaneHost({
      panels: context.ui.panels,
      setBadge: (panelId, text) => PanelExtensions.setBadge(panelId, text),
    }),
  );

  // ---- TypeScript Forms, M3c: forms EMBEDDED on a sheet ----
  // The SAME registry answers (scriptPanes.ts) — an embedded surface is a pane
  // session with `placement: "embedded"` — so the wire is the same four events,
  // filtered to requests that name a placement. What differs is who opens one:
  // nothing a script can call. The user PLACES a form on a sheet
  // (`@api/scriptHost/embeddedFormPlacements`), the layer paints a DOM host over
  // the canvas where that placement sits, and the wiring asks the host to run
  // the form. Two modules because two concerns: `embeddedFormLayer` owns pixels
  // and the structural-edit shift, `scriptEmbedHost` owns sessions and stores
  // and is testable without a canvas.
  const embeddedFormLayer = installEmbeddedFormLayer({
    openSession: (placementId) => openEmbeddedScriptForm(placementId),
    closeSession: (placementId, reason) => closeEmbeddedScriptForm(placementId, reason),
    activeSheetIndex: () => getActiveSheet(),
  });
  const embeddedFormWiring = installScriptEmbedHost(embeddedFormLayer.deps);
  cleanupFunctions.push(embeddedFormWiring);
  cleanupFunctions.push(embeddedFormLayer.dispose);
  // The USER's half: nothing a script can call creates a placement, so the grid
  // context menu is where every embedded form begins and ends. `retry` is handed
  // over because putting an orphan back is the one gesture that makes a
  // remembered refusal untrue (lib/scriptEmbedHost.ts).
  cleanupFunctions.push(registerEmbeddedFormUx((placementId) => embeddedFormWiring.retry(placementId)));

  // ---- Load object scripts from backend on startup ----
  // The startup load IS a workbook open (the app just loaded whatever workbook
  // it starts with — including a .cala launched by double-click), so it carries
  // the same "open" cause as the AFTER_OPEN reload below: a workbook.onOpen
  // hook fires for the open that mounted it, however the workbook arrived.
  try {
    await loadAndMountScripts("open");
  } catch (e) {
    console.warn("[ScriptableObjects] Failed to load object scripts:", e);
  }

  // ---- Re-load scripts when a workbook is opened ----
  cleanupFunctions.push(
    onAppEvent(AppEvents.AFTER_OPEN, async () => {
      // The outgoing workbook's schedule is gone (Rust replaced the registry
      // during open_file); stop ticking for it until the new one is loaded.
      stopSchedulerPump();
      resetObjectScriptManager();
      // The remembered screens belong to the previous workbook too. A grant
      // arriving after the swap must not be able to record the OLD workbook's
      // artifacts into the NEW one.
      pendingGrants.clear();
      // ...and so do the re-ask counts: the bound is per application per
      // WORKBOOK session, not a lifetime ban on a name.
      refusalReprompts.clear();
      consentQueue.length = 0; // queued prompts belong to the previous workbook
      capabilityQueue.length = 0; // pending JIT prompts belong to the previous workbook
      try {
        // cause "open": these mounts happen FROM the AFTER_OPEN handler, after
        // the broadcast — the host replays the one onOpen delivery they missed.
        await loadAndMountScripts("open");
      } catch (e) {
        console.warn("[ScriptableObjects] Failed to reload object scripts:", e);
      }
    }),
  );

  // ---- Re-load scripts when a .calp pull materializes new ones ----
  // Without this, freshly pulled distributed scripts would not appear (or
  // prompt for consent) until the workbook is saved and reopened.
  cleanupFunctions.push(
    onAppEvent(AppEvents.PACKAGE_UPDATED, async () => {
      try {
        await loadAndMountScripts();
      } catch (e) {
        console.warn("[ScriptableObjects] Failed to load pulled scripts:", e);
      }
    }),
  );

  // ---- Handle consent responses ----
  cleanupFunctions.push(
    onAppEvent("scriptable-objects:consent-granted", async (detail) => {
      const { packageName, promptId } = detail as {
        packageName: string;
        promptId?: string;
      };

      // ---- THE GRANT BELONGS TO A SCREEN, AND ONLY TO THAT SCREEN ----
      //
      // Without this the handler re-derived the artifact set from scratch, so
      // Allow recorded whatever the workbook happened to hold at that instant —
      // which a Distribution ▸ Update or a gateway pull landing while the prompt
      // was open had already changed. The user's yes then covered code they were
      // never shown.
      const pending = pendingGrants.get(packageName);
      if (!pending || pending.promptId !== promptId) {
        // Superseded (a re-prompt replaced this screen) or unsolicited. REFUSE
        // and re-ask rather than guess: granting a stale set would approve code
        // the user never saw, and granting a fresh listing would approve code
        // the user never saw either. Asking again is the only answer that keeps
        // "what is granted is what was displayed" true.
        console.warn(
          `[ScriptableObjects] Consent for "${packageName}" arrived for a prompt ` +
            "that is no longer standing; nothing was approved.",
        );
        await refuseGrantAndReprompt(
          packageName,
          "the approval screen was replaced before you answered it.",
        );
        return;
      }
      pendingGrants.delete(packageName);

      // ---- ...AND THE WORKBOOK MUST NOT HAVE MOVED ON UNDER IT ----
      //
      // The prompt is non-modal and PACKAGE_UPDATED re-runs the load, so the
      // screen can be answered after its artifacts changed underneath it without
      // any re-prompt having replaced it (a pull that changes a macro this
      // package owns, for instance, while the object scripts are untouched).
      // Matched through the SAME key the prompt was emitted under — provenance
      // first (that is the authority on "is this a package's code at all"), then
      // the normalized name. A raw `s.packageName === packageName` comparison
      // disagreed with the grouping the moment either side was blank or carried
      // whitespace, and the disagreement is silent.
      // READ THE STORE, NOT THE SESSION REGISTRY. The prompt's set came from
      // `loadAllObjectScripts()`; `ObjectScriptManager` is cumulative for the
      // session and never drops a script an update REMOVED from the application.
      // Comparing against it made Allow refuse a grant nothing had changed
      // about, and then — on the re-prompt — offer to approve and re-mount a
      // script the application no longer ships.
      const scripts = (await loadAllObjectScripts()).filter(
        (s) => s.provenance === "distributed" && objectScriptPackageKey(s) === packageName,
      );
      let liveArtifacts: ConsentArtifact[] | null = null;
      try {
        const macros = await listPackageMacros(packageName);
        liveArtifacts = packageConsentPlan(scripts, macros).artifacts;
      } catch (e) {
        // FAILS CLOSED. "I cannot tell you whether this is still the code you
        // read" is not a yes.
        console.warn("[ScriptableObjects] Module-script listing failed:", e);
        liveArtifacts = null;
      }
      if (liveArtifacts === null) {
        // A LISTING FAILURE IS NOT A CHANGE, AND MUST NOT RE-PROMPT.
        // The load path degrades this same failure to "no macros" and prompts
        // anyway, so re-prompting here walks straight back into it: the user
        // presses Allow, the listing throws again, and the screen returns
        // forever with no press that can ever satisfy it. Say it once and leave
        // the application unapproved until the listing recovers.
        showToast(
          `Calcula could not read this workbook's macros, so nothing from ` +
            `"${packageName}" was approved. Try again in a moment.`,
          { type: "error", duration: 0 },
        );
        return;
      }
      if (artifactFingerprint(liveArtifacts) !== artifactFingerprint(pending.artifacts)) {
        await refuseGrantAndReprompt(
          packageName,
          "the application changed while its approval screen was open.",
        );
        return;
      }

      // A grant that went through ends the refusal loop for this application;
      // the bound counts consecutive refusals, not a lifetime.
      refusalReprompts.delete(packageName);

      // PERSIST THE APPROVAL BEFORE MOUNTING ANYTHING.
      //
      // The mount boundary asks the backend whether this workbook has approved
      // the application, and that question is answered from the consent STORE.
      // Mounting first therefore asks about an approval that has not been
      // written yet: every mount in the loop below is refused, the refusals are
      // swallowed as per-script errors, and the user is told their scripts are
      // enabled while nothing runs until the workbook is reopened.
      //
      // Keyed by source hash + the granted capability union, so changed scripts
      // OR a capability expansion re-prompt.
      //
      // THE RECORD COVERS THE APPLICATION'S MACROS TOO. A `.calp` may ship
      // module scripts; they are disclosed on the subscribe review and named on
      // the prompt this handler answers, and the Rust module gate looks for them
      // in THIS record by id + source hash. Recording only the object scripts is
      // what refused every distributed macro forever.
      //
      // BOTH ARGUMENTS COME FROM THE PROMPT, not from a second listing:
      // `granted` is the capability union the screen enumerated (over the OBJECT
      // scripts — no path grants a macro capabilities from this record at all),
      // and `artifacts` is the artifact list it named.
      try {
        await recordConsent(packageName, pending.artifacts, pending.granted);
      } catch (e) {
        console.warn("[ScriptableObjects] Failed to persist consent:", e);
      }

      // Mount the distributed scripts for this package. Allowing grants ALL
      // declared capabilities (4.2a). For each script, GRANT its declared
      // caps/origins into the live set BEFORE mounting it, so the broker's
      // handle (built at mount) already carries the consented grants.
      //
      // EVERY SCRIPT IS RE-MOUNTED, INCLUDING ONE THAT IS ALREADY RUNNING.
      // PACKAGE_UPDATED re-runs the load WITHOUT `resetObjectScriptManager`, so
      // a realm mounted from the OLD source stays live while `registerScript`
      // swaps the definition underneath it and the hash check revokes the
      // package. This loop used to skip anything `isScriptMounted` reported —
      // so the user approved the new code and the OLD code kept running, under
      // whatever capability set it had already been granted, possibly narrower
      // than the one the new source declares. Approving changed code has to
      // START that code.
      let failedToMount = 0;
      for (const script of scripts) {
        const declared = parseDeclaredCapabilities(script.source);
        await applyConsentedCapabilities(script.id, declared.caps, declared.origins);
        if (ObjectScriptManager.isScriptMounted(script.id)) {
          ObjectScriptManager.unmountScript(script.id);
        }
        try {
          await ObjectScriptManager.mountScript(script.id);
        } catch (e) {
          // One failure must not strand the rest of a just-consented package.
          failedToMount += 1;
          console.error(
            `[ScriptableObjects] "${script.name}" failed to mount after consent:`,
            e,
          );
        }
      }
      // Never announce a success the mounts did not deliver.
      if (failedToMount > 0) {
        showToast(
          `Scripts from "${packageName}" approved, but ${failedToMount} did not start.`,
          { type: "error" },
        );
      } else {
        showToast(`Scripts from "${packageName}" enabled.`, { type: "success" });
      }
    }),
  );

  cleanupFunctions.push(
    onAppEvent("scriptable-objects:consent-denied", (detail) => {
      const { packageName } = detail as { packageName: string };
      // The screen is answered; nothing may grant against it afterwards.
      pendingGrants.delete(packageName);
      showToast(`Scripts from "${packageName}" blocked. Objects will use default behavior.`, { type: "info" });
    }),
  );

  // ---- Script-aware workbook close: warn if scripts have unsaved changes ----
  cleanupFunctions.push(
    onAppEvent(AppEvents.BEFORE_CLOSE, () => {
      // Check for any mounted scripts (they'll lose state on close)
      const allScripts = ObjectScriptManager.getAllScripts();
      const mountedCount = allScripts.filter((s) => ObjectScriptManager.isScriptMounted(s.id)).length;
      // Nothing may tick for a workbook that is going away.
      stopSchedulerPump();
      if (mountedCount > 0) {
        // Scripts are persisted in the workbook, so close is safe.
        // Unmount all running scripts cleanly before the workbook goes away.
        resetObjectScriptManager();
      }
    }),
  );
  cleanupFunctions.push(
    onAppEvent(AppEvents.AFTER_NEW, () => {
      // A blank workbook schedules nothing (Rust's new_file resets the
      // registry); stop the clock rather than paying for an empty tick.
      stopSchedulerPump();
      resetObjectScriptManager();
      // The previous workbook's screens go with it — see AFTER_OPEN.
      pendingGrants.clear();
      refusalReprompts.clear();
    }),
  );

  // ---- Register the Code Tab dialog ----
  context.ui.dialogs.register({
    id: "scriptable-objects.code-editor",
    title: "Object Script Editor",
    component: CodeEditorDialog,
    width: 800,
    height: 600,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister("scriptable-objects.code-editor"));

  // ---- Register the Template Manager dialog ----
  context.ui.dialogs.register({
    id: "scriptable-objects.template-manager",
    title: "Script Templates",
    component: TemplateManagerDialog,
    width: 600,
    height: 450,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister("scriptable-objects.template-manager"));

  // ---- Register the Marketplace dialog ----
  context.ui.dialogs.register({
    id: "scriptable-objects.marketplace",
    title: "Script Libraries",
    component: ScriptMarketplace,
    width: 550,
    height: 500,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister("scriptable-objects.marketplace"));

  // ---- Register Developer menu items ----
  context.ui.menus.registerItem("developer", {
    id: "scriptable-objects.manage",
    label: "Object Scripts...",
    icon: IconScript,
    action: () => {
      openObjectScriptEditor();
    },
  });
  context.ui.menus.registerItem("developer", {
    id: "scriptable-objects.templates",
    label: "Script Templates...",
    icon: IconTemplate,
    action: () => {
      context.ui.dialogs.show("scriptable-objects.template-manager");
    },
  });
  context.ui.menus.registerItem("developer", {
    id: "scriptable-objects.marketplace",
    label: "Script Libraries...",
    icon: IconMarketplace,
    action: () => {
      context.ui.dialogs.show("scriptable-objects.marketplace");
    },
  });

  // ---- Insert > Form... : a new host-painted form script ----
  // The identity (a minted instanceId) and the auto-numbered name come from
  // ONE helper shared with the manager pane, so no second path can mint a form
  // differently. The editor opens through the same EDIT_SCRIPT route every
  // other script uses, targeted by scriptId so it never scaffolds a second one.
  context.ui.menus.registerItem("insert", {
    id: "insert.form",
    label: "Form...",
    icon: IconScript,
    action: async () => {
      try {
        const script = await createFormScript();
        emitAppEvent(ScriptableObjectEvents.EDIT_SCRIPT, {
          objectType: script.objectType,
          instanceId: script.instanceId,
          objectName: script.name,
          scriptId: script.id,
        });
      } catch (e) {
        showToast(`Could not create the form: ${e instanceof Error ? e.message : String(e)}`, {
          type: "error",
        });
      }
    },
  });

  // ---- Register task pane for script management ----
  context.ui.taskPanes.register({
    id: "scriptable-objects.manager",
    title: "Object Scripts",
    component: ObjectScriptManagerPane,
    icon: "code",
    contextKeys: ["always"],
    closable: true,
  });
  cleanupFunctions.push(() => context.ui.taskPanes.unregister("scriptable-objects.manager"));

  // ---- Register the Script Permissions transparency panel ----
  // Sections-based panel API (design §8): mounted scripts, the tier/method
  // policy table rendered directly from ALLOWLIST, and the broker audit tail.
  context.ui.panels.register({
    id: PERMISSIONS_PANEL_ID,
    title: "Script Permissions",
    icon: ShieldIcon,
    sections: [
      {
        id: `${PERMISSIONS_PANEL_ID}.mounted`,
        label: "Mounted scripts",
        component: MountedScriptsSection,
      },
      {
        id: `${PERMISSIONS_PANEL_ID}.policy`,
        label: "What scripts can do",
        component: PolicyTableSection,
      },
      {
        id: `${PERMISSIONS_PANEL_ID}.activity`,
        label: "Activity",
        component: ActivitySection,
      },
    ],
    defaultPlacement: "sidebar",
    priority: 8,
  });
  cleanupFunctions.push(() => context.ui.panels.unregister(PERMISSIONS_PANEL_ID));

  // ---- Register the "Code in This File" transparency inspector (T1) ----
  // A per-workbook inventory of EVERY code unit (object scripts, module scripts,
  // notebooks): where it resides, where it came from, what it can touch, and its
  // source inline. Complements the (runtime-focused) Script Permissions panel by
  // answering the vision's question about the FILE rather than the live session.
  context.ui.panels.register({
    id: CODE_IN_FILE_PANEL_ID,
    title: "Code in This File",
    // Use the "script/code" icon here (a page with code brackets) so the file
    // code-inventory panel is visually distinct from the runtime Script
    // Permissions panel, which keeps the shield-with-checkmark security icon.
    icon: IconScript,
    sections: [
      {
        id: `${CODE_IN_FILE_PANEL_ID}.inventory`,
        label: "Code in This File",
        component: CodeInThisFileSection,
      },
    ],
    defaultPlacement: "sidebar",
    priority: 9,
  });
  cleanupFunctions.push(() => context.ui.panels.unregister(CODE_IN_FILE_PANEL_ID));

  // ---- Cross-window event bridge: Object Script Editor separate window ----

  // Debug sessions live in the MAIN window (that is where the script's worker is
  // mounted), so the standalone editor window drives them through this relay.
  // Without it, F5/F9/F10/F11 work in the in-window dialog and silently do
  // nothing in the separate window — the worst kind of half-shipped feature.
  // The bridge is an authority-free relay: every command names a scriptId the
  // host resolves against its own mount table, and it can only ask for what the
  // host already exposes to trusted UI.
  cleanupFunctions.push(installObjectScriptDebugBridge());

  // ---- Transient debug mounts do not outlive the window that opened them ----
  // Debugging a recorded macro mounts it TRANSIENTLY (it is a module script and
  // has no standing mount). Stop tears that down — but the user can also just
  // close the editor window, and until now that left an unlocked realm running
  // in this window with no UI left that knew it existed. The editor announces
  // its own close; this is what makes that announcement mean something.
  void onEditorClosed(() => {
    void hostStopTransientDebugSessions().catch((e) => {
      console.error("[ScriptableObjects] could not release debug mounts on editor close:", e);
    });
  }).then((unlisten) => {
    cleanupFunctions.push(unlisten);
  });
  cleanupFunctions.push(() => {
    // Extension teardown is also a reason for a debugger-owned mount to go.
    void hostStopTransientDebugSessions().catch(() => undefined);
  });

  // ---- Editor-open seam (@api/scriptEditorService) ----
  // The Macro Recorder sends the user here to edit a recorded macro ("double-
  // click a macro", "Edit in Object Script Editor") WITHOUT importing this
  // extension's internals. We are the only place that can drive the editor
  // window, so we register the provider; the seam throws for the Macro Recorder
  // to surface if this extension is disabled, never a menu action that no-ops.
  // `openDraftInEditor` is the AI Chat's route BACK to a draft after its
  // auto-opened window has been closed — the chat renders an "Open in editor"
  // button beside the call that produced it, and may not import this extension.
  cleanupFunctions.push(
    registerScriptEditorProvider({
      openMacroInEditor: (macroId: string) => openMacroInEditor(macroId),
      openDraftInEditor: (draftId: string) => openRememberedDraft(draftId),
    }),
  );

  // ---- AI script-draft review queue (MCP `draft_object_script`) ----
  // The backend emits `mcp:script-draft` and tells the agent the draft "is
  // queued for the user to review in the Object Script Editor". This is the
  // listener that makes that sentence true. It notifies and opens the editor on
  // the draft; it never saves, registers or mounts it.
  cleanupFunctions.push(installScriptDraftReview());

  // ---- "Edit with AI" (the editor window asks; this window answers) ----
  // The editor activates no extensions and its AI backend commands are
  // window-guarded to the MAIN window, so the run has to happen here. It is the
  // whole of that: hear the request, drive the @api seam, send the proposal
  // back. It never applies anything — the user accepts or rejects a diff.
  cleanupFunctions.push(installAiEditBridge());

  // An editor that was closed mid-run missed its result; re-send on READY, the
  // same rule the initial open payload follows.
  cleanupFunctions.push(
    (() => {
      let off: (() => void) | null = null;
      void onEditorReady(() => replayAiEditResults()).then((fn) => { off = fn; });
      return () => { off?.(); };
    })(),
  );

  // ---- "Preview form" (the editor window asks; this window paints) ----
  // BEGIN form-preview bridge. A FORM script's layout is captured by running
  // the code on screen in the preview realm against a COPY of the active
  // sheet, then painted in the labelled preview dialog registered above. Both
  // halves belong to this window: the preview snapshots the live workbook
  // here, and the modal slot a form claims is this window's. Nothing is saved,
  // mounted, written or audited — see lib/formPreviewBridge.ts. Results are
  // replayed on READY exactly as AI-edit results are.
  cleanupFunctions.push(installFormPreviewBridge());
  cleanupFunctions.push(
    (() => {
      let off: (() => void) | null = null;
      void onEditorReady(() => replayFormPreviewResults()).then((fn) => { off = fn; });
      return () => { off?.(); };
    })(),
  );
  // END form-preview bridge.

  // Breakpoints are workbook state (extension-data key calcula.objectScripts.debug).
  // Load this workbook's set now, and re-load whenever the open workbook changes,
  // so a new file never inherits the previous one's gutter.
  void reloadPersistedBreakpoints();
  cleanupFunctions.push(
    onAppEvent(AppEvents.AFTER_OPEN, () => {
      void reloadPersistedBreakpoints();
    }),
  );

  // Handle save-and-apply requests from the editor window
  onSaveAndApply(async (payload) => {
    const script = payload.script;
    ObjectScriptManager.registerScript(script);

    // Remount to apply changes. A mount failure must not be reported as
    // "Script saved and applied." — it was saved, it was NOT applied.
    if (ObjectScriptManager.isScriptMounted(script.id)) {
      ObjectScriptManager.unmountScript(script.id);
    }
    try {
      await ObjectScriptManager.mountScript(script.id);
    } catch (e) {
      showToast(
        `"${script.name}" was saved, but it is not running: ` +
          `${e instanceof Error ? e.message : String(e)}`,
        { type: "error", duration: 0 },
      );
      return;
    }

    // The payload carries the AUTHOR'S source, never an instrumented copy: since
    // the step debugger landed, instrumentation happens only inside the worker at
    // a debug mount, so what is stored, hashed and distributed is always the real
    // script. (Before that, breakpoints were injected `context.log` calls and the
    // instrumented text reached this handler — hence the old restore step here.)
    showToast("Script saved and applied.", { type: "success" });
  }).then((fn) => cleanupFunctions.push(fn));

  // Handle register-script requests from the editor window
  onRegisterScript((payload) => {
    ObjectScriptManager.registerScript(payload.script);
  }).then((fn) => cleanupFunctions.push(fn));

  // Handle toggle-access requests from the editor window
  onToggleAccess((payload) => {
    ObjectScriptManager.registerScript(payload.script);
  }).then((fn) => cleanupFunctions.push(fn));

  // Forward console output to the editor window
  cleanupFunctions.push(
    onAppEvent("objectscript:console", (detail) => {
      const d = detail as { scriptId: string; level: string; args: unknown[] };
      emitConsoleOutput({ scriptId: d.scriptId, level: d.level, args: d.args });
    }),
  );

  cleanupFunctions.push(
    onAppEvent("objectscript:error", (detail) => {
      const d = detail as {
        scriptId: string;
        scriptName: string;
        error: string;
        stack?: string;
        phase?: string;
      };
      emitScriptError({ scriptId: d.scriptId, scriptName: d.scriptName, error: d.error, stack: d.stack });
      // ALSO in front of the user. `emitScriptError` reaches the code-editor
      // WINDOW, which is closed in every situation that matters: a button whose
      // script failed to mount produced a console line and an event nobody was
      // listening to, and then a click that did nothing. A script that cannot
      // start is a fact about the document, not a detail of the editor.
      showToast(
        d.phase === "snapshot"
          ? `Object script "${d.scriptName}" started with incomplete data: ${d.error}`
          : `Object script "${d.scriptName}" failed to start: ${d.error}`,
        { type: "error" },
      );
    }),
  );

  // Notify editor window when scripts change externally
  cleanupFunctions.push(
    ObjectScriptManager.onScriptChange(() => {
      const scripts = ObjectScriptManager.getAllScripts();
      emitScriptsChanged(scripts);
    }),
  );

  // ---- Cell-behavior bindings (granular bricks phase 2) ----
  // Context-menu attach/edit/remove for per-range behavior scripts + the
  // design-mode cell badge. The binding store lives in @api/cellBehaviors.
  cleanupFunctions.push(registerCellBehaviorUx(context));

  // ---- Listen for edit-script requests (from context menus or property panels) ----
  cleanupFunctions.push(
    onAppEvent(ScriptableObjectEvents.EDIT_SCRIPT, async (detail) => {
      const { objectType, instanceId, objectName, scriptId } = detail as {
        objectType: ScriptableObjectType;
        instanceId?: string | null;
        objectName?: string;
        scriptId?: string;
      };

      // An explicit scriptId targets an existing script (e.g. inspecting a
      // package's distributed scripts from the consent prompt) — never scaffold.
      let script = scriptId
        ? (ObjectScriptManager.getAllScripts().find((s) => s.id === scriptId) ?? null)
        : ObjectScriptManager.getScript(objectType, instanceId);

      if (scriptId && !script) {
        console.warn(`[ScriptableObjects] Script not found: ${scriptId}`);
        return;
      }

      if (!script) {
        // Create a new script with the scaffold template
        const id = crypto.randomUUID();
        const name = objectName || `${objectType} Script`;
        script = {
          id,
          name,
          objectType,
          instanceId: instanceId || null,
          source: getScaffoldTemplate(objectType, objectName),
          accessLevel: "restricted",
        };
        ObjectScriptManager.registerScript(script);
        // Persist to backend before opening editor (so loadAllObjectScripts finds it)
        try {
          await saveObjectScript(script);
        } catch (e) {
          console.warn("[ScriptableObjects] Failed to save new script:", e);
        }
      }

      // Open the code editor in a separate window with this script
      await openObjectScriptEditor(script.id);

      // Re-emit scripts list so the editor window picks up any newly created scripts
      // (the SCRIPTS_CHANGED event from registerScript may have fired before the window existed)
      const allScripts = ObjectScriptManager.getAllScripts();
      emitScriptsChanged(allScripts);
    }),
  );

  // ---- Auto-mount on component creation ----
  // When a slicer, chart, or pivot is created, check if a matching template exists
  // and offer to apply it.
  const componentCreationEvents = [
    "slicer:created",
    "chart:created",
    "pivot:created",
  ];
  for (const eventName of componentCreationEvents) {
    cleanupFunctions.push(
      onAppEvent(eventName, async (detail) => {
        const d = detail as { id?: string; slicerId?: string; chartId?: string; pivotId?: string; name?: string };
        const instanceId = String(d.id ?? d.slicerId ?? d.chartId ?? d.pivotId ?? "");
        const objectType = eventName.split(":")[0] as ScriptableObjectType;
        const objectName = d.name || `${objectType} ${instanceId}`;

        // Check if there are any templates for this object type
        try {
          const templates = await listTemplates();
          const matching = templates.filter((t) => t.objectType === objectType);
          if (matching.length === 1) {
            // Single matching template — auto-apply
            const template = await loadTemplate(matching[0].id);
            if (template) {
              const stamped = stampFromTemplate(template, instanceId, objectName);
              ObjectScriptManager.registerScript(stamped);
              await saveObjectScript(stamped);
              try {
                await ObjectScriptManager.mountScript(stamped.id);
                showToast(`Applied template "${template.name}" to ${objectName}`, { type: "info" });
              } catch (e) {
                showToast(
                  `Template "${template.name}" was stored on ${objectName} but is not ` +
                    `running: ${e instanceof Error ? e.message : String(e)}`,
                  { type: "error" },
                );
              }
            }
          } else if (matching.length > 1) {
            // Multiple templates — notify the user they can edit the script
            showToast(`${matching.length} script templates available for ${objectType}s. Right-click to edit script.`, { type: "info" });
          }
        } catch (e) {
          // Template ENUMERATION failed (the store is not ready, or the file is
          // unreadable). Not fatal to the object that was just created, but it
          // silently skipped auto-applying a template the user configured.
          console.warn("[ScriptableObjects] Template auto-apply skipped:", e);
        }
      }),
    );
  }
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  // Nothing may fire once the surface that mounts (and audits) scripts is gone.
  stopSchedulerPump();

  // Unmount all scripts
  resetObjectScriptManager();

  // A held consent screen outliving the extension that issued it would let a
  // later grant record artifacts against a session that no longer exists.
  pendingGrants.clear();
  refusalReprompts.clear();

  // Clean up all registrations
  for (let i = cleanupFunctions.length - 1; i >= 0; i--) {
    try {
      cleanupFunctions[i]();
    } catch (error) {
      console.error("[ScriptableObjects] Cleanup error:", error);
    }
  }
  cleanupFunctions.length = 0;
}

// ============================================================================
// Export
// ============================================================================

const extension: ExtensionModule = {
  manifest,
  activate,
  deactivate,
};

export default extension;
