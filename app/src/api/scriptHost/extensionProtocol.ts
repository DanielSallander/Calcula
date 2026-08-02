//! FILENAME: app/src/api/scriptHost/extensionProtocol.ts
// PURPOSE: The host <-> worker RPC protocol for the DISTRIBUTED-EXTENSION realm
//          (Wave 3 / S8-C7 Phase B; contribution surface added by the
//          third-party add-in slice, docs/design/third-party-addin-authoring.md).
//          A worker-supported extension runs in a hardened worker with no ambient
//          authority. Two message families cross the boundary:
//            - REGISTRATIONS (commands / menu items / event subscriptions /
//              worksheet functions / ribbon buttons / keybindings / cell styles /
//              file formats): the extension's handler stays IN the worker; the
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
};

/**
 * Contribution kinds that ALSO require a DECLARED capability — declared in the
 * authoritative (Ed25519-signed, when present) sidecar manifest, which the
 * ExtensionManager ZEROES for an unsigned or tampered bundle. Two kinds are
 * here, and they are exactly the two that receive WORKBOOK DATA:
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
 * A kind with no entry adds a host-rendered affordance whose handler can still
 * do nothing without a capability of its own — nothing extra to disclose.
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
};

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
  | { kind: "fileFormat"; regId: number; handlerId: number; format: ExtFileFormatData };

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
  | { t: "error"; message: string; stack?: string };

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
 * Today there is exactly one: the app-event forwarder in extensionWorkerHost.ts
 * hands a subscriber the payloads of APP_EVENTS_CARRYING_CELL_CONTENTS in full
 * when the extension declared `grid.read`, and redacted to coordinates when it
 * did not. An event SUBSCRIPTION is not in the contribution ceiling (it installs
 * a listener, not a surface), which is precisely why this third input exists —
 * without it, deleting the `cellStyle` row from CONTRIBUTION_REQUIRED_CAPABILITY
 * would silently drop grid.read out of the taxonomy while the event door stayed
 * wide open.
 */
export const EXTENSION_PUSHED_DATA_CAPABILITIES: readonly CapabilityId[] = ["grid.read"];

/**
 * The capabilities a SANDBOXED EXTENSION can actually exercise — derived, never
 * hand-maintained, from the three things that can require one:
 *
 *   1. a broker method it is allowed to call (EXTENSION_BROKER_METHODS ∩ the
 *      ALLOWLIST rows that name a capability),
 *   2. a contribution kind it is allowed to register
 *      (CONTRIBUTION_REQUIRED_CAPABILITY — `formula` -> `formula.udf` and
 *      `cellStyle` -> `grid.read`, both required by admitContribution and by NO
 *      broker method, so deriving from methods alone would wrongly strip
 *      worksheet functions and cell styling), and
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
