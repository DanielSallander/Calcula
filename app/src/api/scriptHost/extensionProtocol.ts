//! FILENAME: app/src/api/scriptHost/extensionProtocol.ts
// PURPOSE: The host <-> worker RPC protocol for the DISTRIBUTED-EXTENSION realm
//          (Wave 3 / S8-C7 Phase B; contribution surface added by the
//          third-party add-in slice, docs/design/third-party-addin-authoring.md).
//          A worker-supported extension runs in a hardened worker with no ambient
//          authority. Two message families cross the boundary:
//            - REGISTRATIONS (commands / menu items / event subscriptions /
//              worksheet functions / ribbon buttons / keybindings / cell styles /
//              file formats / forms): the extension's handler stays IN the worker; the
//              host installs a proxy in the real registry that RPCs back via
//              `invokeHandler`. Everything that crosses is DATA — a descriptor
//              the TRUSTED host renders or registers. No component, no markup,
//              no closure.
//            - BROKER CALLS (capabilities, toast, executeCommand, emitEvent):
//              routed through the SAME tier broker object scripts use, so the
//              declared-capability ceiling, consent, and audit apply identically.
//          All payloads are structured-clone data; functions never cross.
//
// THE TWO CEILINGS. A sandboxed extension is bounded twice, and the two bounds
// answer different questions:
//   1. the CAPABILITY ceiling (capabilityIds.ts) answers "what of the world
//      outside this document may it touch?" — network, storage, BI, the user's
//      attention. Honored only for a signed sidecar manifest (ExtensionManager
//      zeroes it otherwise).
//   2. the CONTRIBUTION ceiling (`contributes`, below) answers "which host
//      surfaces may it appear in, and under which names?". It is a pure
//      restriction — declaring a contribution never grants reach, it only
//      permits a registration the code could otherwise make silently — so it is
//      honored from whichever manifest is authoritative. Its value is
//      TRANSPARENCY: the sidecar is read WITHOUT executing the bundle, so the
//      exact set of functions/menu items/shortcuts an add-in will install is
//      knowable (and consent-visible) before a single line of it runs.
//   A registration outside the declared set is REFUSED and reported — never
//   silently dropped.

import type { CapabilityId } from "./capabilityIds";
// The shared method policy table. Imported for ONE purpose — deriving which
// capabilities a sandboxed extension can actually reach (see
// extensionReachableCapabilities below) — so that set can never be a stale hand-
// written copy. allowlist.ts does not import this module, so there is no cycle.
import { ALLOWLIST } from "./allowlist";
// The declarative form tree (M4). A `form` contribution carries the SAME
// data-only spec an object script's `form.define` carries — one definition, so
// the add-in surface can never drift into a second widget vocabulary. Leaf
// import: scriptFormSpec.ts imports only scriptDialogSpec.ts and scriptOrigin.ts.
import type { FormSpec } from "./scriptFormSpec";

export const EXTENSION_PROTOCOL_VERSION = 2;

// ============================================================================
// Contribution declaration (the manifest-side ceiling)
// ============================================================================

/** Every declarative contribution kind a sandboxed extension may register. */
export const EXTENSION_CONTRIBUTION_KINDS = [
  "command",
  "menuItem",
  "formula",
  "ribbonButton",
  "keybinding",
  "cellStyle",
  "fileFormat",
  // M4 (docs/design/typescript-forms.md §14). A host-painted FORM: the add-in
  // declares the exact form names it may put on screen, so every panel it can
  // ever show is knowable — and consent-visible — before a line of the bundle
  // runs. The LAYOUT is validated at registration rather than at show, so an
  // author debugging "my form is refused" is told which rule it broke before
  // the user has ever seen a dialog.
  "form",
] as const;

export type ExtContributionKind = (typeof EXTENSION_CONTRIBUTION_KINDS)[number];

/**
 * What an extension declares it will contribute, by kind. Each entry is the
 * EXACT id the extension may register under (no wildcards — a wildcard would
 * make the pre-install disclosure meaningless).
 */
export interface ExtContributionDeclaration {
  /** Worksheet function names (matched case-insensitively). Needs formula.udf. */
  formulas?: string[];
  /** Extension-local command ids (namespaced to `ext:<extId>:<id>` host-side). */
  commands?: string[];
  /** Menu items as "<menuId>/<itemId>". */
  menuItems?: string[];
  /** Ribbon button ids. */
  ribbonButtons?: string[];
  /** Keybinding ids. */
  keybindings?: string[];
  /** Cell-style contributor ids. */
  cellStyles?: string[];
  /** File-format ids. */
  fileFormats?: string[];
  /** Form names the add-in may register and show. Needs ui.dialog. */
  forms?: string[];
}

/** Which `contributes` list governs each registration kind. */
export const CONTRIBUTION_DECLARATION_KEY: Record<
  ExtContributionKind,
  keyof ExtContributionDeclaration
> = {
  command: "commands",
  menuItem: "menuItems",
  formula: "formulas",
  ribbonButton: "ribbonButtons",
  keybinding: "keybindings",
  cellStyle: "cellStyles",
  fileFormat: "fileFormats",
  form: "forms",
};

/**
 * Contribution kinds that ALSO require a DECLARED capability — declared in the
 * authoritative (Ed25519-signed, when present) sidecar manifest, which the
 * ExtensionManager ZEROES for an unsigned or tampered bundle. Three kinds are
 * here, and they do NOT all answer the same question. Two receive WORKBOOK
 * DATA; the third takes a piece of the USER'S SCREEN:
 *
 *   - `formula` -> formula.udf : a worksheet function is code the sheet calls;
 *     its arguments are the user's cells and it re-runs on every recalculation.
 *
 *   - `cellStyle` -> grid.read : a styling contributor is asked about the cells
 *     on screen and is handed each one's DISPLAYED VALUE. It was disclosed in
 *     consent and in the transparency panel long before it was gated, which is
 *     better than nothing and still not enough: disclosure tells the user what
 *     happens, a capability lets them refuse it, lets the signature carry it,
 *     and lets it be revoked. An unsigned add-in now gets no cell contents at
 *     all, because an unsigned manifest declares nothing.
 *
 *   - `form` -> ui.dialog : a form takes the app-wide MODAL SLOT — the user
 *     must answer it or close it before doing anything else — which is exactly
 *     what `ui.dialog` already names and already gates for `cap.dialogForm`.
 *     It is here for the SURFACE, not for data: a form's bound fields are a
 *     separate, per-delivery `grid.read` question asked when the cells would
 *     actually cross (see EXTENSION_PUSHED_DATA_CAPABILITIES and
 *     `resolveExtensionFormBindings`). Two questions, two capabilities: "may
 *     it stop me and ask?" -> ui.dialog; "may it be shown my cells while it
 *     does?" -> grid.read. Collapsing them would force one sentence describing
 *     the union, which is the definition of dishonest consent text.
 *
 * Everything else installs a host-rendered affordance (a menu item, a button, a
 * shortcut) whose handler is invoked with no workbook data and can still do
 * nothing without a capability of its own, so gating them twice would only add
 * noise to consent. `fileFormat` is the deliberate near-miss: its importer IS
 * handed bytes, but they are the bytes of a FOREIGN file the user just chose to
 * open — not the workbook — so it is disclosed (CONTRIBUTION_REACH_NOTE) and
 * bounded by the same "the human picks the file" mechanism as file.picker,
 * rather than gated by grid.read, which would misname what it reads.
 *
 * NOTE FOR THE NEXT KIND ADDED HERE: `admitContribution` checks the DECLARED
 * ceiling, not the grant set, because that is what the signature covers and
 * what package consent enumerated. The host writes the grant down on acceptance
 * so the transparency panel reflects a capability that is genuinely in use.
 */
export const CONTRIBUTION_REQUIRED_CAPABILITY: Partial<
  Record<ExtContributionKind, CapabilityId>
> = {
  formula: "formula.udf",
  cellStyle: "grid.read",
  form: "ui.dialog",
};

/** Human-readable one-liners for the consent prompt + the manager UI. */
export const CONTRIBUTION_KIND_LABEL: Record<ExtContributionKind, string> = {
  command: "commands",
  menuItem: "menu items",
  formula: "worksheet functions",
  ribbonButton: "ribbon buttons",
  keybinding: "keyboard shortcuts",
  cellStyle: "cell styling",
  fileFormat: "file formats",
  form: "forms",
};

/**
 * What each contribution kind ACTUALLY lets the add-in reach, in the user's
 * words. This is consent text, so it is held to the consent bar: it must name
 * the reach, not the feature.
 *
 * Two kinds hand a sandboxed extension WORKBOOK DATA without a capability, and
 * both are here because the kind label alone would hide that:
 *   - `formula`: a worksheet function is code the sheet calls; its arguments are
 *     the user's cells, and it re-runs on every recalculation.
 *   - `cellStyle`: a styling contributor is asked about the cells on screen and
 *     is handed each cell's DISPLAYED VALUE, because styling by content is the
 *     entire use case ("highlight negatives"). "Adds cell styling" reads as
 *     cosmetic; the reach is "reads the cells you are looking at". Saying so is
 *     the whole difference between consent and a consent-shaped click. It is
 *     now also GATED (grid.read, above) rather than only disclosed.
 *   - `form`: a field can be tied to one of the user's cells, and the host then
 *     puts that cell's contents in it. So a form is a THIRD way workbook data
 *     reaches an add-in, and the note has to say so — "adds a form" reads as
 *     chrome. It also has to say the limit, because the limit is the whole
 *     reason a bound field is safe to offer at all: an add-in form DISPLAYS a
 *     cell and never writes that cell back. That sentence is kept true
 *     structurally, not by promise — there is no write path from a binding to a
 *     cell in the code at all (`resolveExtensionFormBindings` seeds every cell
 *     binding `readOnly`, and no `writeBindings` dep is ever supplied), and the
 *     extension-surface validator refuses `writeOn` outright so an author
 *     cannot even ask for one.
 *
 *     THE CLAUSE THAT WAS TOO BROAD. This note used to end "nothing you do in
 *     one of its forms is ever written into your workbook". The binding half is
 *     true; the absolute half was not, and a consent sentence that is false in
 *     any reading is a defect here. A form's button relays into the add-in's
 *     own handler (`extensionFormDeps` in extensionWorkerHost.ts), and that
 *     handler can call `ext.executeCommand` — a door with NO capability
 *     (allowlist.ts) whose only gate is `CommandRegistry.isScriptSafe`, which
 *     is unconditionally true for CLEAR_CONTENTS, DELETE_ROW, FILL_DOWN and the
 *     rest of the grid-bridge set. Pressing a button in an add-in's form really
 *     can change cells. The note now claims only what the code keeps, and
 *     EXTENSION_BUILTIN_ACTION_REACH_NOTE below discloses that door.
 * A kind with no entry adds a host-rendered affordance that carries no reach of
 * its own beyond the one EVERY add-in has (below) — nothing extra per kind.
 */
export const CONTRIBUTION_REACH_NOTE: Partial<Record<ExtContributionKind, string>> = {
  formula:
    "Formulas in your sheets can call them, and its code runs against the values you pass in every time those cells recalculate.",
  cellStyle:
    "To decide how a cell should look it is shown that cell's contents — so it can read the cells you are currently looking at. It needs the 'grid.read' permission for that, and without it the styling is refused rather than run blind.",
  fileFormat:
    "When you open a file of that type, its code produces the cells that are put into your workbook.",
  keybinding:
    "It can only claim a shortcut nothing else uses; a combination already bound is refused.",
  form:
    "Calcula draws the form; the add-in supplies only a description of it — never pictures and never markup — and it never sees a keystroke, only what a field holds once you change it and everything you entered when you press its button. A field can be tied to one of your cells: Calcula then shows you that cell's contents in it and hands the value to the add-in, which needs the 'grid.read' permission, and without that permission the field is shown to you switched off with the reason rather than blank. A field tied to a cell is display only: the form never writes that cell back. Its buttons still run the add-in's own code, which can ask Calcula to run its built-in editing actions — so pressing a button in a form can change your workbook that way.",
};

/**
 * THE REACH EVERY ADD-IN HAS, whatever it declares. It is NOT a contribution,
 * which is exactly why it needs a sentence of its own: `CONTRIBUTION_REACH_NOTE`
 * is rendered per DECLARED kind, so an add-in that declares only `forms` would
 * otherwise be described entirely by sentences that never mention it.
 *
 * `ext.executeCommand` is in EXTENSION_BROKER_METHODS with no `capability` at
 * all (allowlist.ts, and its absence is pinned by extensionProtocol.test.ts), so
 * nothing in the consent flow asks about it: no sidecar declaration, no ceiling
 * entry, no JIT grant. Its only gate is `CommandRegistry.isScriptSafe`, which is
 * unconditionally true for the grid-bridge set (clear / fill / merge / insert /
 * delete, acting on whatever the user has selected) and for any command a
 * feature registered with `scriptSafe: true`.
 *
 * Stated ONCE here and rendered by BOTH consent surfaces — the mount prompt
 * (`ExtensionManager.processPendingConsents`) and the install screen
 * (`ExtensionsManager/InstallAddInDialog`) — because two hand-copied consent
 * sentences is how one of them ends up describing code that has since changed.
 */
export const EXTENSION_BUILTIN_ACTION_REACH_NOTE =
  "Whatever it adds, any add-in can also ask Calcula to run the actions Calcula marks as safe for add-ins. Some of those CHANGE your workbook — clearing, filling and merging cells, and inserting or deleting rows and columns in whatever is selected — and other features can mark their own actions that way too. This needs no permission and is listed nowhere above, so a button in one of its forms, menus or ribbon groups can change your cells through it.";

/**
 * Normalize an untrusted `contributes` bag into the declared ceiling: unknown
 * keys dropped, non-string entries dropped, trimmed, de-duplicated, and bounded.
 * Returns a frozen object; a kind with no surviving entries is absent (which
 * means "declares nothing" = deny-by-default for that kind).
 */
export const MAX_CONTRIBUTIONS_PER_KIND = 256;

export function normalizeContributionDeclaration(
  raw: unknown,
): ExtContributionDeclaration {
  const out: ExtContributionDeclaration = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const bag = raw as Record<string, unknown>;
  for (const kind of EXTENSION_CONTRIBUTION_KINDS) {
    const key = CONTRIBUTION_DECLARATION_KEY[kind];
    const list = bag[key];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (!trimmed || trimmed.length > 512) continue;
      seen.add(trimmed);
      if (seen.size >= MAX_CONTRIBUTIONS_PER_KIND) break;
    }
    if (seen.size > 0) out[key] = [...seen];
  }
  return out;
}

/** Is `id` inside the declared ceiling for `kind`? Formula names compare
 *  case-insensitively (the formula namespace is case-insensitive); every other
 *  kind compares exactly. */
export function isContributionDeclared(
  declared: ExtContributionDeclaration | undefined,
  kind: ExtContributionKind,
  id: string,
): boolean {
  const list = declared?.[CONTRIBUTION_DECLARATION_KEY[kind]];
  if (!list || list.length === 0) return false;
  if (kind === "formula") {
    const upper = id.toUpperCase();
    return list.some((d) => d.toUpperCase() === upper);
  }
  return list.includes(id);
}

/** Total declared contributions (for the consent text / manager summary). */
export function countContributions(declared: ExtContributionDeclaration | undefined): number {
  if (!declared) return 0;
  let n = 0;
  for (const kind of EXTENSION_CONTRIBUTION_KINDS) {
    n += declared[CONTRIBUTION_DECLARATION_KEY[kind]]?.length ?? 0;
  }
  return n;
}

// ============================================================================
// Manifest
// ============================================================================

/** The manifest an extension bundle reports from inside the worker. The host
 *  filters `capabilities` to the recognized set before it becomes the ceiling,
 *  and `contributes` through normalizeContributionDeclaration. */
export interface WorkerExtensionManifest {
  id: string;
  name: string;
  version: string;
  apiVersion?: string;
  capabilities?: string[];
  workerSupport?: boolean;
  /** The declarative contribution ceiling (see "THE TWO CEILINGS" above). */
  contributes?: ExtContributionDeclaration;
}

// ============================================================================
// Registration descriptors (worker -> host; DATA ONLY)
// ============================================================================

/** A menu item an extension registers (data only — no closure crosses). */
export interface ExtMenuItemData {
  id: string;
  label: string;
  icon?: string;
  order?: number;
  separator?: boolean;
}

/**
 * A worksheet function an extension registers. The IMPLEMENTATION never
 * crosses: `handlerId` addresses a worker-local slot the host RPCs back into
 * through the same relay a command click uses.
 */
export interface ExtFormulaDef {
  /** Uppercased host-side; must match EXT_FORMULA_NAME_RE after uppercasing. */
  name: string;
  description?: string;
  /** Positional parameter names — used to build the IntelliSense syntax string
   *  and, when minArgs/maxArgs are absent, the arity. */
  params?: string[];
  minArgs?: number;
  /** -1 for variadic. */
  maxArgs?: number;
  volatile?: boolean;
}

/** Function names an extension may register. Deliberately the same shape as a
 *  JS identifier (customFunctions.ts IDENT_RE): no dots, no spaces, no leading
 *  digit — a dotted name reads as a namespace the flat formula namespace does
 *  not have. */
export const EXT_FORMULA_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
/** Longest function name (Excel's own limit). */
export const MAX_EXT_FORMULA_NAME = 255;

/**
 * A ribbon button. Host-rendered from this descriptor: the extension supplies a
 * label, an icon TOKEN (never markup) and the id of one of ITS OWN commands.
 * There is no live click handler, so a hostile add-in cannot paint arbitrary
 * chrome or phish inside the app frame.
 */
export interface ExtRibbonButtonData {
  id: string;
  label: string;
  /** Group heading the button sits under (host-drawn). */
  group?: string;
  /** Icon token from the host's set; unknown tokens fall back to a generic glyph. */
  icon?: string;
  tooltip?: string;
  order?: number;
  /** Extension-local command id executed on click. */
  command: string;
}

/** A keyboard shortcut bound to one of the extension's OWN commands. */
export interface ExtKeybindingData {
  id: string;
  /** e.g. "Ctrl+Alt+K". */
  combo: string;
  /** Extension-local command id. */
  command: string;
  label: string;
  context?: "always" | "editing" | "not-editing";
}

/**
 * A file format the extension can IMPORT. The host does all I/O: it reads the
 * file and hands the extension the bytes; the extension returns cell data.
 * Export is deliberately absent — an exporter is handed a live workbook-reading
 * context, which is ambient authority the sandbox has no capability for.
 */
export interface ExtFileFormatData {
  id: string;
  name: string;
  /** Extensions without dots, e.g. ["mydata"]. */
  extensions: string[];
  priority?: number;
}

/** Worker -> host registration requests. Each carries a worker-local regId so
 *  the host can tear it down, and a handlerId when a callback must be relayed. */
export type ExtRegistration =
  | {
      kind: "command";
      regId: number;
      id: string;
      handlerId: number;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "menuItem";
      regId: number;
      menuId: string;
      item: ExtMenuItemData;
      /** Run a registered command id on click ... */
      commandId?: string;
      /** ... or relay to this worker handler. */
      handlerId?: number;
    }
  | { kind: "event"; regId: number; eventName: string; handlerId: number }
  | { kind: "formula"; regId: number; handlerId: number; def: ExtFormulaDef }
  | { kind: "ribbonButton"; regId: number; button: ExtRibbonButtonData }
  | { kind: "keybinding"; regId: number; binding: ExtKeybindingData }
  | { kind: "cellStyle"; regId: number; id: string; handlerId: number }
  | { kind: "fileFormat"; regId: number; handlerId: number; format: ExtFileFormatData }
  /**
   * A host-painted FORM (M4). `spec` is the same data-only widget tree an
   * object script's `form.define` supplies, validated here against the
   * EXTENSION surface's narrower rules (`checkFormSpec(spec, "extension")`).
   *
   * ONE handler, not four. Every hook the form has — a value changed, a button
   * clicked, the submit verdict, the final answer — is relayed into this single
   * worker slot as `{ hook, detail }`, and the submit verdict is simply what
   * the handler RETURNS (`invokeHandler` already carries a result back). Four
   * handler ids would have been four things to keep in step across a register,
   * an unregister and an unmount.
   */
  | {
      kind: "form";
      regId: number;
      /** Must appear in `contributes.forms`, or the registration is refused. */
      name: string;
      spec: FormSpec;
      handlerId: number;
    };

/**
 * THE HOOK NAMES AN ADD-IN IS ACTUALLY GIVEN, in the order one session
 * delivers them. This is the published vocabulary: it appears in the
 * `ui.forms` JSDoc every add-in author writes against
 * (worker/extensionWorkerContext.ts) and in the shipped example add-in.
 *
 * It is deliberately NOT the registry's spelling. `scriptForms.ts` calls its
 * session deps back with `onShow`/`onChange`/`onClick`/`onClose`, and relaying
 * those through verbatim handed every add-in a hook its documented
 * `event.hook === "change"` branch could never match: the example's live VAT
 * caption never updated, and nothing anywhere reported a fault.
 */
export const EXTENSION_FORM_HOOKS = ["show", "change", "click", "submit", "closed"] as const;

export type ExtensionFormHook = (typeof EXTENSION_FORM_HOOKS)[number];

/**
 * Registry hook -> published name; `null` means NOT DELIVERED. The single
 * translation table, so the difference above lives in one place rather than at
 * each relay call site.
 *
 * `onClose` is null on purpose. The registry announces a close TWICE — a
 * `forward("onClose", { reason, values })` immediately followed by
 * `deps.closed(showId, result)` (scriptForms.ts `endSession`) — while the
 * published contract names ONE teardown: "closed", the hook that carries the
 * answers. Delivering both would give an add-in two teardown events where its
 * own docs promise one, and an author counting closes would count double.
 *
 * A hook that is in neither column is a HOST bug, not an add-in's: the relay
 * refuses to guess a name for it rather than inventing vocabulary at runtime.
 */
export const EXTENSION_FORM_HOOK_RELAY: Readonly<Record<string, ExtensionFormHook | null>> = {
  onShow: "show",
  onChange: "change",
  onClick: "click",
  onClose: null,
};

/** Registration kinds that are CONTRIBUTIONS (ceiling-gated). `event` is not:
 *  it installs a listener, not a surface, and its reach is already bounded by
 *  SCRIPT_SUBSCRIBABLE_APP_EVENTS + thinAppEventForScripts. */
export const CONTRIBUTION_REGISTRATION_KINDS: ReadonlySet<string> = new Set(
  EXTENSION_CONTRIBUTION_KINDS,
);

export interface ExtRpcError {
  code:
    | "PermissionDenied"
    | "CapabilityRequired"
    | "ValidationError"
    | "Timeout"
    | "HostError"
    | "UnknownMethod";
  message: string;
  detail?: { capability?: string };
}

// ============================================================================
// Host -> Worker
// ============================================================================

/** Read-only provenance handed to a sandboxed extension as `context.package`.
 *  Built host-side from the AUTHORITATIVE (signed, when present) manifest. */
export interface ExtPackageInfo {
  name: string;
  version: string | null;
  provenance: "distributed";
}

export type HX2W =
  | { t: "init"; protocolVersion: number; source: string }
  | {
      t: "activate";
      ceiling: string[];
      package: ExtPackageInfo;
      /** Mirror of the authoritative contribution ceiling, so the extension can
       *  see what it is allowed to register. DISPLAY ONLY — enforcement is
       *  host-side in setupRegistration. */
      contributes: ExtContributionDeclaration;
    }
  | { t: "invokeHandler"; reqId: number; handlerId: number; args: unknown[] }
  | { t: "appEvent"; handlerId: number; payload: unknown }
  | { t: "callResult"; callId: number; ok: boolean; value?: unknown; error?: ExtRpcError }
  | { t: "deactivate" };

// ============================================================================
// Worker -> Host
// ============================================================================

export type WX2H =
  | { t: "manifest"; manifest: WorkerExtensionManifest }
  | { t: "manifestError"; message: string }
  | { t: "activated"; ok: boolean; error?: string }
  | { t: "register"; reg: ExtRegistration }
  | { t: "unregister"; regId: number }
  | { t: "call"; callId: number; method: string; args: unknown[] }
  | { t: "handlerResult"; reqId: number; ok: boolean; value?: unknown; error?: ExtRpcError }
  | { t: "console"; level: "log" | "warn" | "error"; args: unknown[] }
  | { t: "error"; message: string; stack?: string }
  /** Deactivation ran to completion (async teardown awaited, failures already
   *  reported as {t:"error"}). The host holds terminate() for this ack, bounded
   *  by EXTENSION_DEACTIVATE_GRACE_MS — otherwise an async deactivate's last
   *  write (and its failure report) races the realm's destruction. */
  | { t: "deactivated" };

/** Methods a worker extension may route through the broker, mapped to ALLOWLIST
 *  policy rows.
 *
 *  THIS SET IS ENFORCED, not documentation: handleBrokerCall in
 *  extensionWorkerHost.ts rejects anything absent from it with UnknownMethod
 *  BEFORE the broker sees it. That matters because the ALLOWLIST is shared with
 *  object scripts and contains restricted-tier rows (base.*, sheet.*) a
 *  sandboxed extension must never reach; without this gate the only thing
 *  stopping them was the executor's `default:` arm — a fail-closed accident
 *  rather than a policy. This bug class has bitten twice (base.unexpose,
 *  cap.cube.*), so allowlistCoverage.test.ts derives all four layers from
 *  source. */
export const EXTENSION_BROKER_METHODS: ReadonlySet<string> = new Set([
  "ext.notify",
  "ext.log",
  "ext.executeCommand",
  "ext.emitEvent",
  // Contribution upkeep: drop the cached styles this extension's cellStyle
  // contributor produced, so its next paint re-asks. No reach of its own — it
  // can only clear ITS OWN cache (the host supplies the scriptId).
  "ext.invalidateCellStyles",
  "cap.fetch",
  "cap.storageGet",
  "cap.storageSet",
  "cap.biQuery",
  "cap.biListConnections",
  "cap.biSql",
  // CUBE convenience over the bi.query capability (same trust class, same
  // backend commands as cap.biQuery) — exposed as capabilities.cube.* in
  // extensionWorkerContext.ts.
  "cap.cubeValue",
  "cap.cubeKpi",
  "cap.cubeMembers",
  "cap.biModelInfo",
  "cap.biModelUpsert",
  "cap.biModelDelete",
  // bi.model diagnostics + atomic batching (same capability, separate Rust
  // rate buckets; reads are sanitized field-by-field before they cross).
  "cap.biModelValidate",
  "cap.biModelLineage",
  "cap.biModelBatch",
  // distribution.writeback: a distributed extension IS the natural author of a
  // data-collection workflow, so the .calp writeback loop is reachable here.
  // The two publisher-side rows are additionally gated on Ed25519 key
  // possession in Rust — the capability alone never buys them.
  "cap.writebackListRegions",
  "cap.writebackGetLayer",
  "cap.writebackSaveDraft",
  "cap.writebackSubmit",
  "cap.writebackPreview",
  "cap.writebackListSubmissions",
  "cap.writebackReview",
  // schedule: persistent recurring jobs. A sandboxed extension's code lives in
  // %APPDATA%, but the SCHEDULE it registers lives in the workbook — so the
  // user sees and cancels it in the same transparency panel as everything else.
  "cap.scheduleEvery",
  "cap.scheduleAt",
  "cap.scheduleList",
  "cap.scheduleCancel",
  // ui.dialog: the ONE way a sandboxed extension can reach the user with a
  // QUESTION. The dialog itself is painted by trusted host code from a
  // data-only spec (scriptDialogSpec.ts).
  "cap.dialogAlert",
  "cap.dialogConfirm",
  "cap.dialogPrompt",
  "cap.dialogForm",
  // ui.dialog again, for the RICH form (M4): the same modal slot, the same
  // capability, the same trusted painter — a bigger tree. `ext.formShow` names
  // a form the add-in already REGISTERED (and the sidecar already declared), so
  // the worker cannot hand a layout straight to the screen; the layout was
  // validated, ceiling-checked and listed in the transparency panel before
  // anything could be shown. Update and close name that same session.
  //
  // WHAT IS DELIBERATELY NOT HERE, and why the absence is the design:
  //   * NO CELL READ. A bound field's value is a HOST PUSH — the host resolves
  //     the binding and reads the cell under this extension's own handle (an
  //     audited `sheet.getCellData` row) while the form is being seeded. The
  //     worker never names a cell in any call it makes, so there is nothing to
  //     list here, and `sheet.*` stays unreachable from this realm.
  //   * NO CELL WRITE, and no `writeBindings` dep behind one either. An add-in
  //     lives outside the workbook and runs against every document the user
  //     opens; its form can be SHOWN a cell and can never change one. Adding a
  //     write door here would falsify CONTRIBUTION_REACH_NOTE.form, the
  //     `grid.read` sentence's "It cannot change your cells with this", and the
  //     `ext.formShow` desc — all at once, and all in front of users.
  //   * NO `form.define` / `form.show` / `cap.formsShow` / `form.readControl`.
  //     Those rows are the OBJECT-SCRIPT doors and their consent sentences
  //     promise cell writeback, a Controls-pane read, and opening another
  //     script's form by name — none of which is true of, or available to, an
  //     add-in. One surface, one set of rows, one set of sentences.
  //   * NO `pane.*`. A pane stays on screen for hours beside the grid; that is
  //     `ui.pane`, a different agreement, and M4 does not make it.
  "ext.formShow",
  "ext.formUpdate",
  "ext.formClose",
  // file.picker: "export this as CSV" is one of the commonest reasons an add-in
  // exists, and until now a sandboxed one had no route to it at all. Safe here
  // for the same reason it is safe for an object script: the extension names a
  // FILE NAME and hands over CONTENT, the host opens a native picker, and the
  // human chooses the file. No path crosses in either direction.
  //
  // The workbook-lifecycle rows (api.workbookSave etc.) are deliberately NOT
  // here: they are unlocked-tier and a sandboxed extension mounts restricted,
  // so listing them would only add rows that fail closed.
  "cap.fileExportText",
  "cap.fileImportText",
  // cap.fileImportMedia is deliberately NOT here, and the reason is that it
  // would be DEAD CONSENT TEXT rather than that it would be unsafe — it is in
  // fact the safest row of the family (the host reads, validates and stores the
  // file; the caller gets an inert handle). But a handle is only good for two
  // things, api.createPicture and a picture's `src` property, and a sandboxed
  // extension mounts RESTRICTED so it can reach neither: createPicture is
  // unlocked-tier and object.setState is pinned to an object an extension does
  // not have. Offering it would put a line in a consent dialog for reach the
  // extension cannot use. Add it the day an extension can place a picture.
  // "export this report as a PDF" is the other half of the same reason an
  // add-in exists, and it is safe here for a STRONGER reason than the two rows
  // above: the extension does not even supply the bytes. It names a file; the
  // host renders the document from the workbook's own page setup and opens the
  // picker. There is nothing in the arguments that can name a location or a
  // payload.
  "cap.filePrintPdf",
  // The ui.shortcut family (cap.shortcutBind/Unbind/List) is deliberately NOT
  // here. A sandboxed extension already has a keyboard path — the declarative
  // `keybinding` CONTRIBUTION above, which is disclosed in the sidecar manifest
  // before the bundle runs and binds to one of the extension's own commands.
  // Adding the imperative capability would give the same surface a second,
  // undeclared door, and the two would inevitably drift apart on the question
  // that matters (which combinations may be taken). One surface, one policy:
  // both paths are gated by the same scriptComboRefusal in keybindings.ts.
]);

/**
 * Capabilities an extension can hold through a HOST-PUSH path: reach that is
 * neither a broker method it calls nor a contribution it registers, so neither
 * of the two derivations below can see it.
 *
 * ONE capability, TWO paths that neither derivation can see (a third, cell
 * styling, IS visible to them because it is a contribution):
 *
 *   1. the app-event forwarder in extensionWorkerHost.ts hands a subscriber the
 *      payloads of APP_EVENTS_CARRYING_CELL_CONTENTS in full when the extension
 *      declared `grid.read`, and redacted to coordinates when it did not. An
 *      event SUBSCRIPTION is not in the contribution ceiling (it installs a
 *      listener, not a surface), which is precisely why this third input exists
 *      — without it, deleting the `cellStyle` row from
 *      CONTRIBUTION_REQUIRED_CAPABILITY would silently drop grid.read out of
 *      the taxonomy while the event door stayed wide open.
 *
 *   2. a FORM BINDING (M4): `resolveExtensionFormBindings` reads the cell a
 *      widget's `bind` names and puts its contents in the field. The `form`
 *      contribution requires `ui.dialog` (the modal slot it takes), NOT
 *      grid.read — the data question is asked separately, per delivery, at the
 *      moment the cells would cross — so deriving from the contribution table
 *      cannot see this path either.
 *
 * THE ARRAY IS UNCHANGED BY (2), AND THAT IS THE POINT. A form binding is the
 * same reach under the same name: the host pushes cell contents into code the
 * user did not write. What changes is the CONSENT TEXT, because all four
 * shipped grid.read sentences ENUMERATE the paths — a path added without a
 * clause makes every one of them stale by omission, which is why
 * `grid.read` names three paths now and `extensionContributions.test.ts`
 * asserts the count rather than the keywords.
 */
export const EXTENSION_PUSHED_DATA_CAPABILITIES: readonly CapabilityId[] = ["grid.read"];

/**
 * The capabilities a SANDBOXED EXTENSION can actually exercise — derived, never
 * hand-maintained, from the three things that can require one:
 *
 *   1. a broker method it is allowed to call (EXTENSION_BROKER_METHODS ∩ the
 *      ALLOWLIST rows that name a capability),
 *   2. a contribution kind it is allowed to register
 *      (CONTRIBUTION_REQUIRED_CAPABILITY — `formula` -> `formula.udf`,
 *      `cellStyle` -> `grid.read` and `form` -> `ui.dialog`; the first two are
 *      required by admitContribution and by NO broker method, so deriving from
 *      methods alone would wrongly strip worksheet functions and cell styling),
 *      and
 *   3. a host-push path (EXTENSION_PUSHED_DATA_CAPABILITIES), where the host
 *      sends workbook data INTO the sandbox and the capability decides how much
 *      of it crosses.
 *
 * This is deliberately NOT the whole capability vocabulary. `EXTENSION_BROKER_METHODS`
 * is a strict subset of the shared ALLOWLIST, so ids like `ui.html`,
 * `bi.connector` and `ui.shortcut` have no door on this surface at all. Anything
 * outside this set that reaches an extension's ceiling is reach the consent
 * prompt would name and the broker would then refuse — a promise nothing keeps.
 *
 * Computed on demand (not a module-level const) because both inputs are module
 * constants that must be fully initialized first; the result is tiny and this
 * runs once per extension mount.
 */
export function extensionReachableCapabilities(): ReadonlySet<CapabilityId> {
  const reachable = new Set<CapabilityId>();
  for (const method of EXTENSION_BROKER_METHODS) {
    const capability = ALLOWLIST[method]?.capability;
    if (capability) reachable.add(capability);
  }
  for (const capability of Object.values(CONTRIBUTION_REQUIRED_CAPABILITY)) {
    if (capability) reachable.add(capability);
  }
  for (const capability of EXTENSION_PUSHED_DATA_CAPABILITIES) {
    reachable.add(capability);
  }
  return reachable;
}

/** Host deadline (ms) for a relayed handler invocation before it is abandoned.
 *  This is ALSO the budget for an extension-registered worksheet function: a UDF
 *  that exceeds it rejects, and the UDF path turns that into a cell error. */
export const EXTENSION_HANDLER_TIMEOUT_MS = 5_000;
/** Worker-side deadline (ms) for a pending broker call. */
export const EXTENSION_CALL_TIMEOUT_MS = 30_000;
/** How long unmount waits for the worker's {t:"deactivated"} ack before
 *  terminating anyway. Long enough for a final storage write; short enough
 *  that a wedged teardown cannot hold a workbook close hostage. */
export const EXTENSION_DEACTIVATE_GRACE_MS = 2_000;
