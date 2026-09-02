// FILENAME: app/src/api/distribution.ts
// PURPOSE: API facade for the .calp distribution system.
// CONTEXT: Extensions import from here — never directly from @tauri-apps/api.

import { invokeBackend } from "./backend";
import type { CellData } from "./types";
import { AppEvents, emitAppEvent } from "./events";
import { announceBackendStateReplaced } from "../core/lib/file-api";
import { setActiveSheet } from "../core/lib/tauri-api";
import type {
  WritebackSubmissionNotice,
  WritebackSubmissionReceivedPayload,
} from "./events";
import {
  collectDistributableObjects,
  materializePulledObjects,
  type DistributableObjectPayload,
  type PulledDistributableObject,
} from "./distributableObjects";

// ============================================================================
// Types
// ============================================================================

export interface PublishParams {
  registryPath: string;
  packageName: string;
  version: string;
  kind: string;
  sheetIndices: number[];
  publishedBy: string;
  /** Custom objects contributed by distributable-object providers (brick 4).
   *  publishApplication fills this automatically from registered providers. */
  customObjects?: DistributableObjectPayload[];
  /** Opt-in for carrying threaded comments (Wave B). Comments are internal
   * discussion, so they stay private unless this is explicitly true
   * (default false). Scenarios and outlines always publish. */
  includeComments?: boolean;
  /**
   * What this publish IS. `"update"` pushes the next version of an application this
   * workbook is a working copy of and REQUIRES {@link expectedBaseVersion};
   * `"createNew"` creates an application under a name that must not exist yet.
   *
   * Omitted means `"createNew"`. It is never a fallback for a failed update —
   * an update whose base has moved is refused, not quietly turned into a
   * different operation.
   */
  mode?: "createNew" | "update";
  /**
   * For `"update"`: the version the author worked from, read from the
   * workbook's working-copy link. The backend compares it against the workspace
   * head under the workspace lock; if someone else pushed in the meantime the
   * push is refused rather than silently burying their version.
   */
  expectedBaseVersion?: string;
  /** What changed, in the author's words. Required for `"update"`. */
  changeSummary?: string;
}

export interface PublishResponse {
  packageName: string;
  version: string;
  sheetsPublished: number;
  tablesPublished: number;
  namedRangesPublished: number;
  scriptsPublished: number;
  modulesPublished: number;
  notebooksPublished: number;
  /** Transparency report: everything that shipped and everything present in
   * the workbook that applications cannot carry yet (no silent drops). */
  report: PublishReport;
  /** Publish-time disclosure warnings — e.g. a dropdown pane control whose
   * CellRange item source references a sheet outside the published selection
   * (the artifact is unchanged; these only warn). */
  warnings: string[];
}

/** One line of the publish transparency report. */
export interface PublishReportItem {
  category: string;
  count: number;
  detail: string;
}

/** What a publish did (or, for the preview, would) carry — and what stays
 * behind, with a reason per line. */
export interface PublishReport {
  included: PublishReportItem[];
  excluded: PublishReportItem[];
}

export interface PublishPreviewResponse {
  /** Names of the sheets the preview covered, in application order. */
  sheetNames: string[];
  report: PublishReport;
  /** The SAME disclosure warnings a real publish of this selection would emit
   * — e.g. a dropdown pane control whose CellRange item source references a
   * sheet outside the selection. Non-blocking. */
  warnings: string[];
  /** Where a push to the previewed target stands against each gate. Present
   * only when the preview was given a target application. */
  gates?: PushGateStatus;
  /**
   * Every sheet the author may choose from, with its TRUE workbook index.
   *
   * `sheetNames` above answers a different question — what the PREVIEWED
   * selection covered. A dialog building its checkbox list from that cannot name
   * a sheet the default withheld, and can only map a checkbox back to a workbook
   * index by position, which stops being true the moment the default excludes
   * anything.
   */
  sheets?: PublishPreviewSheet[];
  /**
   * The indices an empty selection resolves to. Send these EXPLICITLY rather
   * than `[]`, so "everything ticked" can never silently mean "everything minus
   * the subscribed ones".
   */
  defaultSheetIndices?: number[];
}

/** One row of the publish dialog's sheet list. */
export interface PublishPreviewSheet {
  /** TRUE workbook index — the value to send back in `sheetIndices`. */
  index: number;
  /**
   * The workbook's stable sheet uuid, directly comparable with
   * `WorkingCopySheetInfo.sheetId` — a working copy's ids ARE the
   * application's.
   *
   * Use THIS to decide "was this sheet in the base version", never the name.
   */
  sheetId: string;
  name: string;
  /** The application this sheet came from; empty when it is the author's own. */
  subscribedTo: string;
  /** Whether a DEFAULT publish would include it. */
  defaultSelected: boolean;
}

/** Suggested next versions, computed from the workspace head. */
export interface SuggestedVersions {
  major: string;
  minor: string;
  patch: string;
}

/**
 * Where a prospective push stands against each gate.
 *
 * ADVISORY. The authoritative evaluation runs inside the publish itself, under
 * the workspace lock — anything checked here and acted on later is a race on a
 * share two people publish to. What this buys is a dialog that can be honest
 * BEFORE the user writes a change summary, not a way around the gate.
 */
export interface PushGateStatus {
  /** `"linked"` — this workbook is a working copy of the target.
   *  `"notLinked"` — it is not a working copy of anything.
   *  `"wrongTarget"` — it is a working copy of a DIFFERENT application.
   *  `"subscriber"` — it SUBSCRIBES to the target, which may never push to it. */
  linkStatus: "linked" | "notLinked" | "wrongTarget" | "subscriber";
  /** The base version this workbook would declare. */
  expectedBase: string;
  /** The workspace's current head. Empty when unreachable. */
  registryLatest: string;
  latestPublishedBy: string;
  /** True when the head moved past the base — a push would be refused. */
  baseStale: boolean;
  /** True when this machine holds the key that signed the head. */
  keyContinuityOk: boolean;
  /** False for an HTTP workspace, which can only be read from. */
  registryWritable: boolean;
  suggestedNext?: SuggestedVersions;
  /** Why the workspace could not be consulted, when it could not be. */
  registryError: string;
}

/** One published version, as the version-history UI renders it. */
export interface WorkingCopyVersionInfo {
  version: string;
  publishedAt: string;
  publishedBy: string;
  /** The version this one was pushed from. Empty for an application's first. */
  baseVersion: string;
  /** What the author said changed. */
  changeSummary: string;
}

export interface WorkingCopySheetInfo {
  sheetId: string;
  name: string;
}

/**
 * What application this workbook is a working copy of, and where it stands.
 *
 * Every workspace-derived field degrades rather than throwing: a developer with
 * the share offline still gets the link's own contents, and
 * {@link registryReachable} says which half they are looking at.
 */
export interface WorkingCopyStatus {
  registryUrl: string;
  packageName: string;
  kind: string;
  /** The version this working copy is based on. */
  baseVersion: string;
  checkedOutAt: string;
  lastPushedVersion: string;
  lastPushedAt: string;
  /** Sheets the base version carried — the push dialog's default selection. */
  baseSheets: WorkingCopySheetInfo[];
  registryReachable: boolean;
  headVersion: string;
  /** True when the head has moved past this working copy. */
  isStale: boolean;
  /** Published history, oldest first (the order the manifest stores). */
  versions: WorkingCopyVersionInfo[];
  suggestedNext?: SuggestedVersions;
  /** Whether this machine holds the key that signed the head. */
  holdsPublisherKey: boolean;
  registryError: string;
}

// ============================================================================
// Version diffs
// ============================================================================

/** The artifact-level picture: which files differ. */
export interface ArtifactDiffSummary {
  added: string[];
  removed: string[];
  /** Paths whose hash differs AND whose parsed content differs. */
  changed: string[];
  /** Hash differed, content did not. Nonzero means application serialization has
   *  become order-dependent again — see the determinism test in core/calp. */
  spuriousHashChanges: number;
  unchangedCount: number;
}

/** One changed thing, named the way a person would name it. */
export interface ObjectChange {
  domain: string;
  id: string;
  name: string;
  sheetName?: string;
  change: "added" | "removed" | "modified";
  detail: string;
  artifactPath?: string;
  before?: string;
  after?: string;
  beforeTruncated?: boolean;
  afterTruncated?: boolean;
  /** Capabilities a script gained — the one script change a consumer must see. */
  addedCapabilities?: string[];
  removedCapabilities?: string[];
}

export interface CellSnapshot {
  display: string;
  formula?: string;
  cellType: string;
}

export interface CellDiff {
  a1: string;
  row: number;
  col: number;
  change: "added" | "removed" | "modified";
  before?: CellSnapshot;
  after?: CellSnapshot;
}

export interface SheetDiffSummary {
  /** The APPLICATION sheet id. */
  sheetId: string;
  name: string;
  change: "added" | "removed" | "modified" | "renamed";
  renamedFrom?: string;
  cellsAdded: number;
  cellsRemoved: number;
  cellsModified: number;
  /** The subset where the FORMULA differs, not just the value. */
  formulaChanges: number;
  /** False when a budget capped the parse — the counts are then floors. */
  countsExact: boolean;
  styleChangedCells: number;
  stylesTableChanged: boolean;
  layoutChanged: boolean;
  metadataChanged: boolean;
  sample: CellDiff[];
  sampleTruncated: boolean;
}

export interface ManifestFieldChange {
  field: string;
  before: string;
  after: string;
}

export interface DiffTotals {
  objectsAdded: number;
  objectsRemoved: number;
  objectsModified: number;
  sheetsChanged: number;
  cellsChanged: number;
  cellsChangedExact: boolean;
}

export interface VersionDiff {
  packageName: string;
  fromVersion: string;
  /** "working copy" when the right-hand side is the open workbook. */
  toVersion: string;
  artifacts: ArtifactDiffSummary;
  sheets: SheetDiffSummary[];
  objects: ObjectChange[];
  manifestChanges: ManifestFieldChange[];
  totals: DiffTotals;
}

/** Every changed cell of one sheet, up to a cap. */
export interface SheetCellDiff {
  sheetId: string;
  name: string;
  changes: CellDiff[];
  /** The truth, even when `changes` was capped. */
  totalChanges: number;
  truncated: boolean;
  cellsAdded: number;
  cellsRemoved: number;
  cellsModified: number;
  formulaChanges: number;
}

export interface WorkingCopyDiff {
  packageName: string;
  baseVersion: string;
  diff: VersionDiff;
}

// ============================================================================
// Merge — the three-outcome push
// ============================================================================

/**
 * One addressable piece of an application.
 *
 * The grain of a collision: a cell of a sheet, a sheet's structure, an object
 * with a stable id, or an application-level setting. Two developers who touched
 * different pieces have not conflicted.
 */
export type PieceKey =
  | { kind: "cell"; sheetId: string; a1: string }
  | { kind: "sheetStructure"; sheetId: string }
  | { kind: "object"; domain: string; id: string }
  | { kind: "manifestField"; field: string };

export interface Collision {
  piece: PieceKey;
  /** A sentence naming what collided. */
  description: string;
  sheetName?: string;
}

/**
 * - `fastForward` — nothing landed since your base; publish straight away.
 * - `canMerge` — something landed, it touched different pieces, and this build
 *   can bring it across.
 * - `conflict` — the same piece changed on both sides. There is no automatic
 *   merge inside a piece, and last-writer-wins is the failure this replaces.
 * - `cannotApply` — disjoint work, but the intervening change is of a kind this
 *   build cannot bring into a working copy yet. Not a conflict.
 */
export type MergeVerdict = "fastForward" | "canMerge" | "conflict" | "cannotApply";

export interface MergeAnalysis {
  verdict: MergeVerdict;
  /** Populated only for `conflict`. */
  collisions: Collision[];
  /** What landed while you were working. */
  theirSummary: string[];
  /** What you changed. */
  yourSummary: string[];
  /** What blocked a `cannotApply`. */
  unmergeable: string[];
}

export interface MergeAnalysisResponse {
  packageName: string;
  baseVersion: string;
  headVersion: string;
  headPublishedBy: string;
  headChangeSummary: string;
  analysis: MergeAnalysis;
}

export interface MergeApplyResponse {
  mergedFromVersion: string;
  cellsApplied: number;
  sheetsTouched: string[];
}

// ============================================================================
// Co-publishing
// ============================================================================

export interface CoPublisherInfo {
  /** Lowercase hex of the Ed25519 public key — what actually authorizes. */
  key: string;
  /** Display only. */
  name: string;
  addedAt: string;
  /** Whether THIS computer holds this key. */
  isYou: boolean;
}

export interface CoPublishersResponse {
  packageName: string;
  /** The key that published version 1 — the anchor, and the only key that can
   *  change the list. Empty for an application with no signed versions. */
  rootKey: string;
  youAreTheRoot: boolean;
  /** Root or an authorized delegate. */
  youMayPublish: boolean;
  coPublishers: CoPublisherInfo[];
  /** Set when a list exists but could not be trusted. Reported rather than
   *  treated as "no delegates" — those two must not look alike. */
  problem: string;
}

export interface CheckoutParams {
  registryPath: string;
  packageName: string;
  /** A concrete version, or omitted for the workspace head. */
  version?: string;
}

export interface CheckoutResponse {
  packageName: string;
  version: string;
  sheetsMaterialized: number;
  scriptsMaterialized: number;
  publisherName: string;
  /** The trust outcome REPORTED, never recorded: a checkout verifies the
   *  signature but never creates a TOFU pin (a working copy has no refresh
   *  loop for a pin to protect). */
  trustStatus: CalpTrustStatus;
  /** The freshly materialized workbook's active sheet, in the shape
   *  `openFileAtPath` returns — the frontend refreshes through one path. */
  cells: CellData[];
  /** Custom objects of kinds handled by frontend providers (brick 4);
   *  {@link checkoutApplication} dispatches these automatically. */
  customObjects?: PulledDistributableObject[];
  /**
   * TRUE state-vector index of the application's first sheet, so the caller can
   * land the user on it. `null` for an application that brings no sheets.
   *
   * The index the BACKEND reported, never `sheets.length - materialized`: the
   * sheet list omits object-backed sheets, so that arithmetic names the wrong
   * sheet whenever a floating range is present.
   */
  firstSheetIndex?: number | null;
}

/**
 * TOFU trust outcome for a `.calp` application, mirrored EXACTLY from the Rust
 * `calp::integrity::TrustStatus`.
 *
 * A pin is scoped to `(workspace, application name)`, not to the name alone.
 * Keying on the name alone meant whoever made first contact with a name owned it
 * on the whole machine: an application `acme.finance` served once from
 * `\\evil\share` wrote
 * the pin the GENUINE `acme.finance` was later measured against, so the real
 * publisher's first release read as "publisher changed" — an accusation pointed
 * at the victim. Three of the seven states below exist because scoping alone
 * would have traded that loud false alarm for a quiet true miss.
 *
 * - `"verified"` — signed by the key this machine pinned for THIS workspace when
 *   the user deliberately trusted this publisher (Subscribe).
 * - `"trustedDelegate"` — signed by a CO-PUBLISHER the pinned publisher
 *   authorized: not the pinned key, but a key listed in a `publishers.json` the
 *   pinned key signed. Trusted, and worth SAYING — the user agreed to trust one
 *   publisher and is now transitively trusting someone that publisher vouched
 *   for.
 * - `"firstUse"` — the key was pinned by THIS operation, and this name was not
 *   pinned anywhere else. Only a commit point (Subscribe) can produce it.
 * - `"firstUseKnownPublisher"` — pinned by this operation for a new workspace,
 *   and the SAME key is already trusted for this name elsewhere: a migration, a
 *   mirror, or a second spelling of one location. Reassurance, not alarm.
 * - `"firstUseAcceptedNameConflict"` — pinned by this operation even though a
 *   DIFFERENT key holds this name from another workspace, because the user was
 *   shown both and accepted. Never present this as an ordinary first use.
 * - `"notPinned"` — the signature is cryptographically valid, but nobody on
 *   this computer has ever agreed to trust that signer for this application name
 *   from this workspace. AUTHENTIC IS NOT TRUSTED: anyone can generate an Ed25519
 *   key and sign an application, so a valid signature proves only that the bytes are
 *   unaltered. Passive surfaces (inspect, review, the Application Inspector) return
 *   this instead of quietly creating a pin.
 * - `"notPinnedNameConflict"` — passive first contact AND a different key is
 *   pinned for this same name from another workspace. Two workspaces claiming one
 *   name is what a hijack looks like: show BOTH workspaces and BOTH key
 *   fingerprints, in a danger tone.
 *
 * EVERY UI that switches on one of these MUST have a row for all seven. A trust
 * state that renders as no badge (reads as benign) or falls through to a green
 * "verified" pill is a security-UX defect, not a cosmetic one. This list said
 * "all six" and omitted `trustedDelegate` while the union already carried it —
 * so the paragraph demanding completeness was itself incomplete, which is
 * exactly how a state ends up rendering as nothing.
 */
export type CalpTrustStatus =
  | "verified"
  /** Signed by a CO-PUBLISHER the pinned publisher authorized: the signer is
   *  not the pinned key, but appears in a `publishers.json` that the pinned key
   *  signed. Trusted, and worth SAYING — the user agreed to trust one
   *  publisher and is now transitively trusting somebody that publisher
   *  vouched for. */
  | "trustedDelegate"
  | "firstUse"
  | "firstUseKnownPublisher"
  | "firstUseAcceptedNameConflict"
  | "notPinned"
  | "notPinnedNameConflict";

/** The statuses that mean "this machine has deliberately agreed to trust this
 *  publisher for this application name, from this workspace". Both `notPinned` states
 *  are deliberately absent, exactly as `notInstalled` is absent from the
 *  library/extension equivalents. */
export function calpTrustIsPinned(status: string): boolean {
  return (
    status === "verified" ||
    // A delegate's signature traces to the key this machine DID pin, so the
    // deliberate trust decision is present — it was simply made about the
    // publisher who vouched for them.
    status === "trustedDelegate" ||
    status === "firstUse" ||
    status === "firstUseKnownPublisher" ||
    status === "firstUseAcceptedNameConflict"
  );
}

/** The two conflict states, which must always render in a danger tone: another
 *  workspace holds this application name under a DIFFERENT publisher key. */
export function calpTrustIsNameConflict(status: string): boolean {
  return status === "notPinnedNameConflict" || status === "firstUseAcceptedNameConflict";
}

/**
 * A pin held for the SAME application name in a DIFFERENT workspace.
 *
 * `scopeLabel` is the other workspace EXACTLY as the user configured it — the
 * backend never exposes the normalized scope id, which is key material and not a
 * string anyone typed.
 */
export interface OtherScopePin {
  scopeLabel: string;
  publisherKey: string;
  /** RFC3339, or "" for a pin carried over from the pre-scoping store. */
  pinnedAt: string;
  /** Whether that key is the one being offered here (migration/mirror) or a
   *  different one (name conflict). */
  sameKey: boolean;
}

/**
 * One publisher pin held by THIS COMPUTER.
 *
 * `scopeLabel` is the workspace exactly as the user configured it, and is empty
 * for the `ext` namespace: an extension pin is machine-global by decision (there
 * is no workspace, and the only candidate scope — the source folder — is the
 * attacker's own choice, so scoping by it would hand a dropped bundle a free
 * first use on an id it does not own).
 */
export interface TrustedPublisherPin {
  /** "calp" | "ext". */
  namespace: string;
  name: string;
  scopeLabel: string;
  publisherKey: string;
  /** RFC3339, or "" for a pin carried over from the pre-scoping store. */
  pinnedAt: string;
}

export interface TrustedPublisherName {
  namespace: string;
  name: string;
  pins: TrustedPublisherPin[];
  /** More than one DISTINCT publisher key holds this name on this machine. */
  hasKeyConflict: boolean;
}

export interface TrustedPublisherReport {
  names: TrustedPublisherName[];
  totalPins: number;
  conflictCount: number;
  /** Non-empty when the pin store exists but could not be read. NOT the same as
   *  "nothing is trusted" — render it as a failure, never as an empty list. */
  error: string;
}

/**
 * What does this computer trust, and from where?
 *
 * Read-only and passive: it opens no workspace, verifies nothing, and can neither
 * create nor remove a pin.
 */
export async function listTrustedPublishers(): Promise<TrustedPublisherReport> {
  return invokeBackend<TrustedPublisherReport>("calp_list_trusted_publishers");
}

export interface PullParams {
  registryPath: string;
  packageName: string;
  versionPin: string;
  /** The user was shown a cross-workspace NAME CONFLICT and accepted it in a
   *  second, differently-worded confirmation. Omitting it makes a conflicting
   *  subscribe FAIL with an explanation rather than pin — fail closed. */
  acceptNameConflict?: boolean;
}

export interface PullResponse {
  packageName: string;
  resolvedVersion: string;
  sheetsPulled: number;
  tablesPulled: number;
  /** Number of object scripts materialized (restricted, consent-gated). */
  scriptsPulled: number;
  /** Publisher display name from the verified manifest (S5 phase 2). */
  publisherName: string;
  /** A `CalpTrustStatus`. Subscribe is a commit point, so this is one of the
   *  pinning states ("verified", "firstUse", "firstUseKnownPublisher" or
   *  "firstUseAcceptedNameConflict"); neither "notPinned" state occurs here. */
  trustStatus: CalpTrustStatus;
  /** Pins for this same application name in OTHER workspaces. */
  otherScopePins: OtherScopePin[];
  /** Custom objects of kinds NOT handled Rust-side (brick 4), for frontend
   *  provider materialization. subscribeToApplication dispatches these automatically. */
  customObjects?: PulledDistributableObject[];
  /**
   * The TRUE state-vector index of the first user-visible sheet this pull
   * created, for the caller to activate. Null when the application brought no user
   * sheet (a dataset or library application).
   *
   * Use THIS rather than deriving a position from `getSheets()`. That list
   * omits object-backed sheets — a floating range's backing sheet — so list
   * arithmetic names the wrong sheet as soon as one exists, and activating the
   * wrong sheet leaves the pulled report's content out of the active-sheet
   * mirror, where the next recalculation overwrites it.
   */
  firstPulledSheetIndex?: number | null;
}

/** Contents of an application version, for pre-pull review. */
export interface ApplicationInspection {
  packageName: string;
  resolvedVersion: string;
  sheets: SheetInfo[];
  scripts: InspectedScript[];
  /**
   * Standalone module scripts bundled with the application (C8).
   *
   * `calp_commands.rs` has returned these since C8; this interface did not
   * declare them, so the Subscribe review rendered `inspection.scripts` alone
   * and an application's module scripts — including the reserved
   * `__calcula_custom_functions__` module, whose functions run whenever a cell
   * calls them — arrived undisclosed. They land INERT (a separate consent gates
   * execution: `require_distributed_module_consent`), so this was a disclosure
   * gap rather than unconsented execution; disclosure before a commit point is
   * the whole job of this type.
   */
  moduleScripts: InspectedModuleScript[];
  /** Standalone notebooks bundled with the application (C8). Inert until the user
   *  opens and runs them — but, like moduleScripts, they were arriving with no
   *  mention in the pre-pull review. */
  notebooks: InspectedNotebook[];
  dataSources: InspectedDataSource[];
  writebackRegionCount: number;
  tableCount: number;
  namedRangeCount: number;
  /** Names of the tables the application carries (per-object transparency). */
  tableNames: string[];
  /** Names of the named ranges the application carries. */
  namedRangeNames: string[];
  chartCount: number;
  sparklineCount: number;
  pivotCount: number;
  /** Sheets carrying cell-anchored controls (buttons/checkboxes). */
  controlSheetCount: number;
  /** Pane controls (Controls pane widgets) the application carries. */
  paneControlCount: number;
  /** Names of the pane controls the application carries. */
  paneControlNames: string[];
  /** Slicers on the published sheets (Wave A). */
  slicerCount: number;
  /** Ribbon filters the application carries (workbook-scoped, BI-only; Wave A). */
  ribbonFilterCount: number;
  /** Saved pivot layouts the application carries (Wave A). */
  pivotLayoutCount: number;
  /** Whether the application carries a document theme (applied only if the
   * subscriber's theme is still the default). */
  hasDocumentTheme: boolean;
  /** Extension-data keys the application carries (merged additively; keys the
   * subscriber already has are never overwritten). */
  extensionDataCount: number;
  /** Their key names (per-object transparency, like namedRangeNames). */
  extensionDataKeys: string[];
  /** Sheets carrying threaded comments (Wave B). Non-zero only when the
   * publisher explicitly opted in via "Include comments" at publish. */
  commentSheetCount: number;
  /** Verified publisher display name (S5 phase 2). */
  publisherName: string;
  /** The verified publisher's Ed25519 public key (hex). Reviewing an application
   *  deliberately does NOT pin it, so this key is the thing the user compares
   *  against what the publisher told them out of band before subscribing. */
  publisherKey: string;
  /** Pins for this same application name in OTHER workspaces. Shown in the Review
   *  step, because Review must never say nothing and then have Subscribe fail on
   *  a conflict it never mentioned. */
  otherScopePins: OtherScopePin[];
  /** A `CalpTrustStatus`. Review/inspect is PASSIVE, so first contact reports
   *  "notPinned" and writes nothing to the pin store — inspecting an application is
   *  not a decision to trust its publisher. A failed signature check returns an
   *  error instead of a status. */
  trustStatus: CalpTrustStatus;
}

export interface InspectedScript {
  name: string;
  objectType: string;
  description: string | null;
  /** Capability ids the application's manifest declares this script needs (R19). */
  requestedCapabilities: string[];
}

/** Mirrors `InspectedModuleScript` in app/src-tauri/src/calp_commands.rs. */
export interface InspectedModuleScript {
  /**
   * Stable module-script id, assigned by Calcula (not by the publisher).
   *
   * The pre-pull review uses it to recognise the reserved
   * `__calcula_custom_functions__` library, whose functions run on every
   * recalculation of a cell that calls them. Matching on `name` instead would
   * let any publisher wear that label, and would miss the real library if it
   * were renamed.
   */
  id: string;
  name: string;
  /** "workbook", or the name of the sheet the module is scoped to. */
  scope: string;
  description: string | null;
}

/** Mirrors `InspectedNotebook` in app/src-tauri/src/calp_commands.rs. */
export interface InspectedNotebook {
  name: string;
  cellCount: number;
}

export interface InspectedDataSource {
  name: string;
  connectionType: string;
  server: string;
  database: string;
}

export interface ApplicationInfo {
  name: string;
  description: string;
  kind: string;
  author: string;
  versions: VersionInfo[];
}

export interface VersionInfo {
  version: string;
  publishedAt: string;
  publishedBy: string;
  sheets: SheetInfo[];
}

export interface SheetInfo {
  name: string;
  description: string;
}

export interface SubscriptionManifest {
  formatVersion: number;
  subscriptions: Subscription[];
}

export interface Subscription {
  packageName: string;
  registryUrl: string;
  versionPin: string;
  resolvedVersion: string;
  resolvedAt: string;
  sheets: SubscribedSheet[];
  /** Provenance ledger: every object this subscription materialized
   * (written at pull, updated at refresh). May be absent on subscriptions
   * created before the ledger existed. */
  objects?: SubscribedObject[];
}

/** One object a subscription materialized into the local workbook. */
export interface SubscribedObject {
  /** "table" | "chart" | "pivot" | "namedRange" | "objectScript" |
   * "moduleScript" | "notebook" | "dataSource" | "controlSheet" |
   * "paneControl" | "slicer" | "ribbonFilter" | "pivotLayout" */
  kind: string;
  id: string;
  /** Display name at materialization time; ABSENT when unknown (charts,
   * pivots) — the backend omits empty names from the JSON. */
  name?: string;
}

export interface SubscribedSheet {
  packageSheetId: string;
  localSheetId: string;
  localName: string;
}

// Override types
export interface OverrideLayer {
  formatVersion: number;
  overrides: CellOverride[];
}

export interface CellOverride {
  sheetId: string;
  cellId: string;
  position: [number, number];
  baseline: OverrideValue;
  current: OverrideValue;
  createdAt: string;
  modifiedAt: string;
  author: string;
  conflict: boolean;
  upstreamNew: OverrideValue | null;
}

export type OverrideValue =
  | { type: "value"; display: string }
  | { type: "formula"; formula: string }
  | { type: "empty" };

export interface OverridePatch {
  formatVersion: number;
  packageName: string;
  baselineVersion: string;
  overrides: CellOverride[];
  exportedAt: string;
}

// Refresh types
export interface RefreshPreview {
  subscriptionPreviews: SubscriptionPreview[];
  totalCellsChanged: number;
  totalSheetsAdded: number;
  totalSheetsRemoved: number;
  totalOverridesConflicted: number;
  totalOverridesAutoCleared: number;
  /**
   * False when a cell count was capped by the diff budget. The dialog must then
   * say "at least N" rather than "N".
   */
  totalCellsChangedExact: boolean;
  /**
   * True when every override-bearing sheet was examined, so the conflict list is
   * the whole truth. False must BLOCK Apply: a resolver may not present a
   * partial list as a complete set of decisions.
   */
  conflictsExact: boolean;
}

export interface SubscriptionPreview {
  packageName: string;
  /**
   * The workspace this subscription reads, in the user's spelling.
   *
   * Part of the subscription's IDENTITY: the merged preview puts every
   * workspace's rows in one list, and two teams may each publish `sales` to
   * their own share.
   */
  registryUrl: string;
  currentVersion: string;
  newVersion: string;
  sheetsAdded: SheetChangeInfo[];
  sheetsRemoved: SheetChangeInfo[];
  sheetsUpdated: SheetChangeInfo[];
  cellsChanged: number;
  /** Whether `cellsChanged` is the whole truth or a bounded floor. */
  cellsChangedExact: boolean;
  /** How many sheets had a changed data artifact, even when the count was capped. */
  sheetsWithDataChanges: number;
  overridesConflicted: number;
  overridesAutoCleared: number;
  /**
   * Every conflict this refresh would create, one row per cell.
   *
   * Computed with the SAME predicate the apply uses, from the same artifact —
   * `overridesConflicted` is `conflicts.length`. It used to be "every override
   * on a sheet whose artifact changed", so a sheet where the publisher edited
   * one cell and you had edited twenty others reported twenty conflicts and
   * produced one.
   */
  conflicts: ConflictPreviewCell[];
  /** Sheets whose artifacts could not be read, so their conflicts are unknown. */
  unexaminedSheets: UnexaminedSheet[];
}

/** One conflicted cell: base, mine, theirs. */
export interface ConflictPreviewCell {
  /** LOCAL sheet id — the key the resolution takes, and the one this workbook holds. */
  localSheetId: string;
  cellId: string;
  /** The LIVE local name: a subscriber may rename a subscribed sheet. */
  sheetName: string;
  /** (row, col) — a JSON array, mirroring Rust's `(u32, u32)`. */
  position: [number, number];
  /** A1 of `position`, so the dialog does not re-implement the conversion. */
  a1: string;
  /** base — what upstream held when you made the edit. */
  baseline: OverrideValue;
  /** mine — what you typed. */
  current: OverrideValue;
  /** theirs — what upstream holds now. */
  upstreamNew: OverrideValue;
}

/** A sheet the preview could not read, and why. */
export interface UnexaminedSheet {
  packageSheetId: string;
  sheetName: string;
  /** `"unreadable"` — missing, too large to parse, or the workspace went away. */
  reason: string;
}

/** What to do with one conflicted cell. */
export type ResolutionChoice = "keepMine" | "takeTheirs";

/**
 * One resolved cell, keyed the way the override layer is keyed: (sheet, cell)
 * ids, never a position. Positions move under a refresh; the layer is
 * id-anchored precisely so an override survives a structural shift.
 */
export interface CellResolution {
  sheetId: string;
  cellId: string;
  choice: ResolutionChoice;
}

/** One row of what a preview showed, echoed back so the apply can verify it. */
export interface PreviewedSubscriptionVersion {
  registryUrl: string;
  packageName: string;
  newVersion: string;
}

export interface RefreshApplyParams {
  /**
   * Only the cells the user actually decided on. Anything unlisted keeps the
   * local value and stays flagged — which is exactly what a refresh did before
   * there was anything to decide.
   */
  resolutions?: CellResolution[];
  /**
   * EXACTLY the refresh the preview described, so the apply can refuse to be a
   * different one.
   *
   * The dialog computes its preview once and is non-modal by design, and the
   * two halves resolve the version pin independently. A subscriber who reads
   * `base=100 / mine=999 / theirs=150` and thinks for two minutes while the
   * publisher pushes a version where that cell is `7` used to get `7` — their
   * 999 discarded for a value the dialog never displayed, under a confirm strip
   * saying the decision is not undoable. Now the apply refuses and says the
   * workspace moved.
   *
   * Omit it only when the caller showed the user nothing. An EMPTY ARRAY is not
   * the same thing: it says "the preview found no update", and a refresh that
   * now has one is refused.
   */
  previewedVersions?: PreviewedSubscriptionVersion[];
}

export interface SheetChangeInfo {
  sheetId: string;
  name: string;
  overrideCount: number;
}

export interface RefreshResult {
  subscriptionsRefreshed: number;
  sheetsAdded: number;
  sheetsRemoved: number;
  sheetsUpdated: number;
  conflictsCreated: number;
  overridesAutoCleared: number;
  structuralConflicts: StructuralConflict[];
}

export interface StructuralConflict {
  sheetId: string;
  sheetName: string;
  overrideCount: number;
}

// ============================================================================
// Backend Wrappers
// ============================================================================

export async function publishApplication(params: PublishParams): Promise<PublishResponse> {
  // Fill custom objects from registered distributable-object providers (brick 4)
  // unless the caller already supplied them. Built-in cell types are collected
  // Rust-side and merged there — these are the third-party providers' objects.
  const customObjects = params.customObjects ?? (await collectDistributableObjects());
  return invokeBackend("calp_publish", { params: { ...params, customObjects } });
}

/**
 * The manifest `kind` that makes a .calp usable as a SCRIPT LIBRARY — the same
 * string `library_commands.rs` (`LIBRARY_KIND`) and `@api/scriptLibraries`
 * (`LIBRARY_PACKAGE_KIND`) compare against. Re-stated here because this is the
 * publishing side: until now the package manager could CONSUME libraries and no
 * publish path could EMIT one, so a library author had no way to ship.
 */
export const LIBRARY_PACKAGE_KIND = "library";

export interface PublishLibraryParams {
  registryPath: string;
  packageName: string;
  version: string;
  publishedBy: string;
  /** Sheets to ship ALONGSIDE the modules (docs, examples). Omit for the normal
   *  case: a library is code, so it ships zero sheets. */
  sheetIndices?: number[];
}

/**
 * Publish this workbook's standalone module scripts as a `kind: "library"`
 * application — the authoring half of the script package manager.
 *
 * A library's payload is `modules/{id}.json`, not sheets, so this deliberately
 * defaults `sheetIndices` to `[]`. The backend honours that literally for the
 * library kind (`calp_publish`): every other kind reads an empty selection as
 * "all sheets", which for a library would ship the author's entire workbook —
 * data and all — to a shared workspace as a side effect of publishing a function
 * library.
 *
 * Everything else is the ordinary publish path: same Ed25519 signature, same
 * TOFU identity, same version manifest, same artifact checksums. A library is
 * an ordinary application with a different `kind`, which is exactly why consuming
 * one needs no second trust root.
 */
export function publishLibrary(params: PublishLibraryParams): Promise<PublishResponse> {
  return publishApplication({
    registryPath: params.registryPath,
    packageName: params.packageName,
    version: params.version,
    kind: LIBRARY_PACKAGE_KIND,
    sheetIndices: params.sheetIndices ?? [],
    publishedBy: params.publishedBy,
  });
}

/**
 * Dry-run of publishApplication: assemble the exact carrier a publish would use
 * and report what would ship vs stay behind — without writing anything.
 * Omit sheetIndices (or pass []) to preview publishing every sheet.
 * Pass includeComments to mirror the real publish's comment opt-in, so the
 * preview report shows comments exactly where the publish would put them.
 */
export function publishPreview(
  sheetIndices?: number[],
  includeComments?: boolean,
  /** Supply both to have the response carry {@link PushGateStatus}. */
  target?: { registryPath: string; packageName: string },
  /**
   * The application's kind, so the dry run resolves the SAME sheets a publish
   * would. Only `"library"` changes the answer (zero sheets by default) — and a
   * library preview that omitted it described every sheet for a publish that
   * ships none.
   */
  kind?: string,
): Promise<PublishPreviewResponse> {
  return invokeBackend("calp_publish_preview", {
    params: {
      sheetIndices: sheetIndices ?? null,
      includeComments: includeComments ?? false,
      kind: kind ?? "",
      registryPath: target?.registryPath ?? null,
      packageName: target?.packageName ?? null,
    },
  });
}

/**
 * Open a published application version as a WORKING COPY.
 *
 * ADDS the application's sheets to the open workbook — it used to REPLACE the
 * document, which meant the price of opening an application for editing was
 * whatever you had on screen. The added sheets carry the application's own sheet
 * ids, which is what lets a later push continue its identity instead of forking
 * it, and a push defaults to the application's sheets alone so your own work is
 * not swept into somebody else's application.
 */
export async function checkoutApplication(params: CheckoutParams): Promise<CheckoutResponse> {
  const response = await invokeBackend<CheckoutResponse>("calp_checkout", { params });
  // Frontend-provider objects (brick 4) land the same way a pull's do.
  if (response.customObjects?.length) {
    await materializePulledObjects(response.customObjects);
  }
  // AFTER_OPEN, because the application brought SCRIPTS, cell types and custom
  // functions with it, and those listeners re-read on exactly this. `path` stays
  // empty: nothing was opened from disk.
  emitAppEvent(AppEvents.AFTER_OPEN, { path: "", source: "checkout" });
  // AND the four backend-state caches plus the SHEET LIST, through the one
  // helper `open_file`/`new_file` use. Emitting AFTER_OPEN alone is not enough
  // and this is not a theory: the tab strip does not listen for AFTER_OPEN, so
  // it kept the PREVIOUS sheet list, and clicking a tab asked the backend for a
  // sheet index that no longer existed — "Sheet index 1 out of range". The
  // identical bug was found and fixed for File > New in 2026-08-07; checkout
  // re-created it by writing its own sequence instead of calling this.
  //
  // Still the right call now that checkout APPENDS rather than replaces: the
  // application's sheets arrive with their own outline, hyperlinks, validations,
  // annotations and display flags, so every one of those caches is stale.
  announceBackendStateReplaced();
  emitAppEvent(AppEvents.DIRTY_STATE_CHANGED, { isDirty: true });

  // Land on the application, using the index the BACKEND reported — the same
  // contract subscribe uses, and for the same reason: the sheet list omits
  // object-backed sheets, so any arithmetic over its length names the wrong one.
  // Must run AFTER the announce above, whose SHEET_CHANGED carries index 0.
  const first = response.firstSheetIndex;
  if (first !== undefined && first !== null) {
    try {
      const sheetsResult = await setActiveSheet(first);
      emitAppEvent(AppEvents.SHEET_CHANGED, {
        sheetIndex: first,
        sheetName: sheetsResult.sheets.find((s) => s.index === first)?.name ?? "",
      });
    } catch (err) {
      // Costs the landing, not the checkout: the sheets are already in.
      console.warn("[Checkout] Could not activate the application's first sheet:", err);
    }
  }
  return response;
}

/**
 * What application is this workbook a working copy of, and where does it stand
 * relative to the workspace? `null` for a standalone workbook.
 *
 * Never throws for an unreachable workspace: the answer degrades to the link's
 * own contents with `registryReachable: false`.
 */
export function workingCopyStatus(): Promise<WorkingCopyStatus | null> {
  return invokeBackend("calp_working_copy_status", {});
}

/**
 * What changed between two published versions of an application.
 *
 * Both sides are verified first — signature, trust status and the full
 * per-artifact checksum walk — so nothing here is backed by unverified bytes.
 */
export function diffVersions(params: {
  registryPath: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
}): Promise<VersionDiff> {
  return invokeBackend("calp_diff_versions", { params });
}

/** Every changed cell of one sheet, for the drill-down. */
export function diffSheetCells(params: {
  registryPath: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  sheetId: string;
  maxCells?: number;
}): Promise<SheetCellDiff> {
  return invokeBackend("calp_diff_sheet_cells", { params });
}

/** Who may publish this application — the root, plus any delegates it authorized. */
export function listCoPublishers(params: {
  registryPath: string;
  packageName: string;
}): Promise<CoPublishersResponse> {
  return invokeBackend("calp_list_co_publishers", { params });
}

/**
 * Replace the co-publisher list. Only the root publisher can.
 *
 * The whole list is sent, not a delta: the artifact IS the whole list, and
 * doing the read-modify-write in the UI would put a second copy of that logic
 * where it can drift.
 */
export function setCoPublishers(params: {
  registryPath: string;
  packageName: string;
  coPublishers: Array<{ key: string; name?: string }>;
}): Promise<CoPublishersResponse> {
  return invokeBackend("calp_set_co_publishers", { params });
}

/**
 * This computer's own publisher key, to send to whoever owns an application you want
 * to push to. A public key identifies; it does not authorize.
 */
export function myPublisherKey(): Promise<CoPublisherInfo> {
  return invokeBackend("calp_my_publisher_key", {});
}

/**
 * Where a push stands against what landed while its author was working.
 *
 * Read-only. Compares the workspace head against this working copy's base, and
 * this working copy against that same base, then asks whether the two touched
 * any piece in common.
 */
export function pushMergeAnalyze(): Promise<MergeAnalysisResponse> {
  return invokeBackend("calp_push_merge_analyze", {});
}

/**
 * Bring the intervening changes into the open working copy as one undoable
 * step, recalculate, and move the base forward.
 *
 * Re-runs the analysis server-side rather than trusting a verdict from here —
 * the workspace can move between a dialog rendering and a user confirming.
 */
export function pushMergeApply(): Promise<MergeApplyResponse> {
  return invokeBackend("calp_push_merge_apply", {});
}

/**
 * What this workbook's next push would change.
 *
 * With no arguments it reads the target and base from the workbook's own
 * working-copy link, which is what the push dialog wants.
 */
export function diffWorkingCopy(params?: {
  registryPath?: string;
  packageName?: string;
  baseVersion?: string;
  /**
   * Sheets the comparison covers. Omitted means "the publish default".
   *
   * FOR A SUBSCRIBER THIS IS REQUIRED and the backend refuses without it: the
   * publish default for a subscribing workbook is every sheet you own EXCEPT
   * the subscribed ones, which is the inverse of "compare my subscribed sheets
   * against the published version".
   */
  sheetIndices?: number[];
  /**
   * Pass TRUE whenever the diff is shown as a preview of something that does not
   * touch comments. The publish assembly writes `comments.json` only when this
   * is set, so against a base version published WITH comments the working side
   * has none and every comment reads as removed — a change the previewed act
   * will not make.
   */
  includeComments?: boolean;
  /**
   * Keep only these APPLICATION sheet ids and recompute the totals.
   *
   * A subscriber diff otherwise reports a DETACHED sheet as removed (gone from
   * the ledger, still in the published manifest) and a locally-added floating
   * range's backing sheet as added — neither of which a reset touches.
   */
  scopeSheetIds?: string[];
}): Promise<WorkingCopyDiff> {
  return invokeBackend("calp_diff_working_copy", { params: params ?? {} });
}

export interface PublishModelParams {
  registryPath: string;
  packageName: string;
  version: string;
  publishedBy: string;
  /** The BI connection whose model to publish (connection id). */
  connectionId: string;
}

/**
 * Publish a single BI model as a MODEL-ONLY application (kind "dataset", zero
 * sheets): the .calp becomes the distribution unit for models — signed,
 * versioned, min-app-gated — instead of hand-carried .json files. Subscribing
 * materializes a live connection (schema only; the subscriber supplies their
 * own credentials, so row-level security is preserved).
 */
export function publishModel(params: PublishModelParams): Promise<PublishResponse> {
  return invokeBackend("calp_publish_model", { params });
}

/** One object connected to an application, resolved against the live workbook. */
export interface ApplicationObjectInfo {
  kind: string;
  id: string;
  name: string;
  /** Whether the object still exists in the workbook. */
  present: boolean;
  /** The sheet the object lives on, when resolvable. */
  sheetName: string;
}

export interface ApplicationSheetObjectInfo {
  localName: string;
  localSheetIndex: number | null;
}

export interface ApplicationObjectsResponse {
  packageName: string;
  resolvedVersion: string;
  registryUrl: string;
  sheets: ApplicationSheetObjectInfo[];
  objects: ApplicationObjectInfo[];
}

/** Which sheets and objects are connected to a subscribed application, and
 * whether each still exists in the live workbook (Application Explorer data). */
export function getApplicationObjects(packageName: string): Promise<ApplicationObjectsResponse> {
  return invokeBackend("calp_get_application_objects", { packageName });
}

/**
 * Dispatch a pull's custom objects of non-built-in kinds to their frontend
 * providers (brick 4). Built-in kinds (cell types) were already materialized
 * Rust-side.
 *
 * Exported because there are now TWO callers: `subscribeToApplication` (the Subscribe
 * dialog's path) and the script broker's `cap.pkgPull` handler, which receives
 * the very same `PullResponse` from the Rust distribution gateway. One
 * implementation on purpose — a second copy is how a scripted pull would start
 * quietly dropping the objects an interactive pull materializes.
 */
export async function applyPulledCustomObjects(response: PullResponse): Promise<void> {
  if (response.customObjects && response.customObjects.length > 0) {
    await materializePulledObjects(response.customObjects);
  }
}

export async function subscribeToApplication(params: PullParams): Promise<PullResponse> {
  const response = await invokeBackend<PullResponse>("calp_pull", { params });
  await applyPulledCustomObjects(response);
  return response;
}

export function listApplicationsInWorkspace(registryPath: string): Promise<ApplicationInfo[]> {
  return invokeBackend("calp_browse_workspace", { registryPath });
}

/** Inspect an application version's contents without materializing anything. */
export function inspectApplication(
  registryPath: string,
  packageName: string,
  versionPin: string,
): Promise<ApplicationInspection> {
  return invokeBackend("calp_inspect_application", { registryPath, packageName, versionPin });
}

/**
 * Whether this machine trusts each subscription's publisher.
 *
 * A `.cala` restores its subscription list on open WITHOUT pulling, so a
 * workbook received from a colleague can name applications this computer has never
 * subscribed to. Writeback regions, GATHER and model-writeback columns from such
 * an application are deliberately INERT — the paths that read their declarations
 * require an existing TOFU pin rather than creating one, because a workbook that
 * arrives by email must not be able to squat a publisher identity.
 *
 * This call makes that state visible so the UI can say "subscribe to activate"
 * instead of showing a report that silently does nothing. It is PASSIVE: asking
 * about trust never creates it.
 */
export interface SubscriptionTrustInfo {
  packageName: string;
  registryUrl: string;
  resolvedVersion: string;
  /** A `CalpTrustStatus`, or "unavailable" when the workspace/manifest could not
   *  be read or verified at all (see `error`). */
  trustStatus: CalpTrustStatus | "unavailable";
  /** Pins for this same application name in OTHER workspaces. */
  otherScopePins: OtherScopePin[];
  publisherName: string;
  publisherKey: string;
  /** Whether this application declares writeback regions or model-writeback columns
   *  — i.e. whether "not pinned" actually costs the user working features. */
  declaresWriteback: boolean;
  /** Failure text when `trustStatus` is "unavailable". */
  error: string;
}

export function getSubscriptionTrust(): Promise<SubscriptionTrustInfo[]> {
  return invokeBackend<SubscriptionTrustInfo[]>("calp_subscription_trust");
}

export function getSubscriptions(): Promise<SubscriptionManifest> {
  return invokeBackend("calp_get_subscriptions");
}

export function getOverrides(): Promise<OverrideLayer> {
  return invokeBackend("calp_get_overrides");
}

export function revertOverride(sheetId: string, cellId: string): Promise<boolean> {
  return invokeBackend("calp_revert_override", { sheetId, cellId });
}

export function acceptUpstream(sheetId: string, cellId: string): Promise<boolean> {
  return invokeBackend("calp_accept_upstream", { sheetId, cellId });
}

export function keepOverride(sheetId: string, cellId: string): Promise<boolean> {
  return invokeBackend("calp_keep_override", { sheetId, cellId });
}

export function exportOverrides(packageName: string): Promise<OverridePatch> {
  return invokeBackend("calp_export_overrides", { packageName });
}

export function importOverrides(patchJson: string): Promise<number> {
  return invokeBackend("calp_import_overrides", { patchJson });
}

export function refreshPreview(): Promise<RefreshPreview> {
  return invokeBackend("calp_refresh_preview");
}

/**
 * Apply a refresh the user has previewed.
 *
 * Omitting `params` — or passing no resolutions — keeps every local value and
 * leaves every conflict flagged, which is what this did before it could be told
 * otherwise. The script gateway relies on that default: a script may take an
 * update, never adjudicate one.
 */
export function refreshApply(params?: RefreshApplyParams): Promise<RefreshResult> {
  return invokeBackend("calp_refresh_apply", { params: params ?? null });
}

export function detach(): Promise<void> {
  return invokeBackend("calp_detach");
}

/** Where one sheet came from, when it did not come from you. */
export interface SheetProvenanceInfo {
  /**
   * TRUE workbook index. Shifts on insert/delete/move, so a consumer caching it
   * must re-read when the sheet list changes.
   */
  sheetIndex: number;
  /**
   * The workbook's stable sheet uuid. Both keys come from ONE snapshot, so a
   * consumer never has to join two round trips that can tear.
   */
  sheetId: string;
  /**
   * The PUBLISHER's id for this sheet. On a subscriber this is a DIFFERENT uuid
   * from `sheetId` — pull mints fresh local ids — and it is the one every
   * published artifact and every diff row is keyed by, so anything lining local
   * sheets up against published content needs this one. On a working copy the
   * two coincide.
   */
  packageSheetId: string;
  /** The LIVE name — renaming a subscribed sheet is allowed. */
  sheetName: string;
  packageName: string;
  registryUrl: string;
  resolvedVersion: string;
  /**
   * Which role this sheet holds toward that application. The two look identical
   * on a tab and behave oppositely: a `"subscribed"` sheet is refreshed from the
   * workspace and stays out of your publishes; a `"workingCopy"` sheet IS the
   * application, and a push carries it.
   *
   * Reported per SHEET because checkout is additive — the application's sheets
   * sit beside your own in one workbook, so the status-bar chip alone can no
   * longer answer it.
   */
  role: SheetProvenanceRole;
}

/** @see SheetProvenanceInfo.role */
export type SheetProvenanceRole = "subscribed" | "workingCopy";

export interface DetachSheetResponse {
  packageName: string;
  /** Override LEDGER entries dropped. The cells are untouched. */
  overridesDropped: number;
  /** True when this was the subscription's last remaining holding. */
  subscriptionRemoved: boolean;
}

/**
 * Which sheets came from a subscribed application.
 *
 * The ONE answer for the tab badge, the sheet context menu and the publish
 * dialog — `getSubscriptions()` returns the raw ledger with no workbook indices.
 */
export function getSheetProvenance(): Promise<SheetProvenanceInfo[]> {
  return invokeBackend("calp_get_sheet_provenance");
}

/**
 * Detach ONE sheet from the application that provided it: keep the sheet, stop
 * tracking it.
 *
 * The cells are NOT touched — the override layer is a ledger, and the grid
 * already holds your values. What you lose is the ability to revert to upstream,
 * which is what detaching means. Irreversible without a refresh.
 */
export function detachSheet(sheetIndex: number): Promise<DetachSheetResponse> {
  return invokeBackend("calp_detach_sheet", { params: { sheetIndex } });
}

export interface ResetSubscriptionResponse {
  sheetsReset: number;
  overridesCleared: number;
  pivotsReset: number;
  resolvedVersion: string;
}

/**
 * Reset a subscription's sheets to the pristine published content of the
 * currently resolved version, discarding local edits (cells, formatting,
 * sizes, merges, overrides) on those sheets AND restoring the application's
 * published pivot definitions (layout changes revert). One undo step.
 */
/** One cell the author unticked in the PUSH diff. */
export interface HoldBackCellRef {
  /** The diff row's sheet id. A working copy's ids ARE the application's. */
  sheetId: string;
  row: number;
  col: number;
}

export interface HoldBackCellsResponse {
  cellsHeldBack: number;
  /**
   * True when a write happened and an undo entry therefore exists.
   *
   * The caller MUST call `undo()` exactly once when this is true and MUST NOT
   * when it is false — a bare undo with nothing to reverse takes back the
   * author's own last edit.
   */
  undoRecorded: boolean;
  /**
   * The id of the undo entry this write left, to hand back to `undo()`.
   *
   * A BARE UNDO IS NOT SAFE HERE, and it is why this shipped disabled. The
   * window is: hold back → publish → un-revert, and the publish is long and
   * IO-heavy. It records nothing itself, but an MCP tool or a sandboxed script
   * CAN record an entry during it — and a bare undo then takes back that entry
   * and leaves the author's own changes rolled back, silently.
   */
  undoSeq?: number | null;
}

/**
 * Put the base version's value back into the cells the author unticked, so the
 * push that follows publishes a workbook without those changes.
 *
 * HALF OF A PAIR, and the caller owns the other half:
 *
 * ```ts
 * const { undoSeq } = await holdBackCells(...);
 * try { await publishApplication(...); }
 * finally { if (undoSeq != null) await undo(undoSeq); }
 * ```
 *
 * `undo(undoSeq)`, never a bare `undo()`. The publish records nothing on the
 * undo stack itself, but it is long and IO-heavy, and an MCP tool or a
 * sandboxed script can record an entry while it runs — a bare undo then takes
 * that back instead and leaves the author's own changes rolled back. The scoped
 * form refuses and returns a `refusal` sentence to show them.
 *
 * The `finally` is the entire safety property. Substituting values as the
 * artifact is written would be simpler and is wrong: nothing on the receiving
 * side ever recalculates — neither pull, nor checkout, nor opening the file
 * evaluates a cell — so a formula whose inputs did not ship would show a number
 * that was never true, on every subscriber's screen, forever. And invisibly,
 * because the diff hides formula cells whose formula did not change, so the
 * corrupted dependents never appear as rows to untick.
 *
 * Reverting in the live document instead means the publish serializes a real,
 * recalculated workbook state. The cost is that the author's sheet holds the
 * reverted values for the duration of the publish. If the app dies in between,
 * the write is in the undo stack and the document is dirty, so Ctrl+Z and
 * AutoRecover both recover it.
 */
export function holdBackCells(params: {
  registryPath: string;
  packageName: string;
  /** The version this push is based on — where the held-back values come from. */
  baseVersion: string;
  cells: HoldBackCellRef[];
}): Promise<HoldBackCellsResponse> {
  return invokeBackend("calp_hold_back_cells", { params });
}

/** One cell to LEAVE ALONE during a reset, named the way a diff row names it. */
export interface ResetCellRef {
  /** The PUBLISHER's sheet id — what a diff row carries. */
  packageSheetId: string;
  row: number;
  col: number;
}

export function resetSubscription(
  registryUrl: string,
  packageName: string,
  /**
   * Cells the author unticked in the diff. An EXCLUSION set, never an inclusion
   * set: the diff list is a bounded sample, so a cell with no row must default
   * to being restored — which makes omitting this bit-identical to the
   * whole-sheet reset this has always been.
   */
  excludedCells?: ResetCellRef[],
): Promise<ResetSubscriptionResponse> {
  return invokeBackend("calp_reset_subscription", {
    params: { registryUrl, packageName, excludedCells: excludedCells ?? [] },
  });
}

// ============================================================================
// Phase 6: Author Workflow
// ============================================================================

export interface DevSubscribeParams {
  /** Absolute path to a local .cala file. */
  sourcePath: string;
  /** Sheet names to pull; empty array means all sheets. */
  sheetNames: string[];
}

/**
 * Subscribe to a local .cala file in dev mode.
 * Sheets are materialized into the workbook like a normal pull but resolve
 * against the file directly instead of a version published in a workspace.
 */
export function devSubscribe(params: DevSubscribeParams): Promise<PullResponse> {
  return invokeBackend("calp_dev_subscribe", { params });
}

/**
 * Re-pull from the dev source, refreshing HEAD sheets in place.
 * Finds the dev subscription automatically from the current workbook state.
 */
export function devRefresh(): Promise<PullResponse> {
  return invokeBackend("calp_dev_refresh");
}

/**
 * Rename a stable CellId (author-facing).
 * Returns false if the old ID was not found.
 * Currently deferred pending full IdRegistry integration into AppState.
 */
export function renameCellId(
  sheetId: string,
  oldCellId: string,
  newCellId: string,
): Promise<boolean> {
  return invokeBackend("calp_rename_cell_id", { sheetId, oldCellId, newCellId });
}

/**
 * Merge two stable CellIds (author-facing).
 * The absorbed ID is consumed by the survivor.
 * Currently deferred pending full IdRegistry integration into AppState.
 */
export function mergeCellIds(
  sheetId: string,
  survivorCellId: string,
  absorbedCellId: string,
): Promise<boolean> {
  return invokeBackend("calp_merge_cell_ids", { sheetId, survivorCellId, absorbedCellId });
}

/**
 * Suggest the next version string for an application given a bump level.
 * @param registryPath - Absolute path to the local workspace directory.
 * @param packageName  - Application name inside the workspace.
 * @param bump         - One of "major", "minor", or "patch".
 * @returns The suggested next version string, e.g. "1.3.0".
 */
export function nextVersion(
  registryPath: string,
  packageName: string,
  bump: "major" | "minor" | "patch",
): Promise<string> {
  return invokeBackend("calp_next_version", { registryPath, packageName, bump });
}

// ============================================================================
// Phase 7: Audit Log
// ============================================================================

export interface AuditEntry {
  timestamp: string;
  event: string;
  description: string;
  user: string;
}

export interface AuditLog {
  formatVersion: number;
  enabled: boolean;
  maxEntries: number;
  entries: AuditEntry[];
}

/** Return the full audit log for the current workbook. */
export function getAuditLog(): Promise<AuditLog> {
  return invokeBackend("calp_get_audit_log");
}

/**
 * Enable or disable audit logging and configure the rolling window.
 * @param enabled    - Whether to enable audit logging.
 * @param maxEntries - Maximum entries to keep (0 = unlimited).
 */
export function setAuditEnabled(enabled: boolean, maxEntries: number): Promise<void> {
  return invokeBackend("calp_set_audit_enabled", { enabled, maxEntries });
}

/** Discard all audit log entries. */
export function clearAuditLog(): Promise<void> {
  return invokeBackend("calp_clear_audit_log");
}

// ============================================================================
// Phase 9: Writeback Readiness
// ============================================================================

/**
 * App event fired whenever the writeback region index is re-read (subscribe,
 * refresh, detach, region designation). Anything holding a cached copy of the
 * index listens for it — notably the script host, which uses its own copy to
 * route a script's grid write into the same validated draft path a human
 * keystroke takes without paying one IPC per cell.
 */
export const WRITEBACK_INDEX_CHANGED_EVENT = "distribution:writeback-index-changed";

/** A writeback region entry from the backend index (flat format). */
export interface WritebackRegionEntry {
  sheetId: string;
  sheetIndex: number;
  regionId: string;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
  /** Declared value type, so the commit guard coerces input to the right type
   * instead of sniffing it from the string shape. */
  valueType?: "number" | "integer" | "text" | "date" | "boolean" | "enum";
  /** Whether the region's schema marks values required. */
  required?: boolean;
  /** Submission deadline (ISO 8601) for an until_deadline region. */
  deadline?: string;
  /** Name of a publisher-declared custom validator (advisory, subscriber-side;
   *  distribution brick 3). Run against typed input as an as-you-type check on
   *  top of the authoritative built-in schema. */
  customValidator?: string;
}

/** Fetch the current writeback regions from the backend. */
export function getWritebackRegions(): Promise<WritebackRegionEntry[]> {
  return invokeBackend("calp_get_writeback_regions");
}

/**
 * Why one subscription's writeback regions are NOT installed in the index.
 *
 * Mirrors `WritebackRebuildSkip` in app/src-tauri/src/calp_commands.rs.
 *
 * Before this existed, "this application declares no writeback" and "this application's
 * writeback regions are UNKNOWN" were the same observable state — an empty
 * index — so a subscriber whose form protections were silently inactive saw
 * exactly what a subscriber with no form sees. An empty list here means every
 * subscription's regions are live.
 */
export interface WritebackRebuildSkip {
  packageName: string;
  registryUrl: string;
  /**
   * `"unreachable"` | `"notPinned"` | `"publisherChanged"` | `"badManifest"`
   * | `"appTooOld"` | `"deferred"` | `"unknown"`.
   *
   * `"deferred"` is not a failure: the workbook-open rebuild walks local
   * workspaces inline and hands HTTP ones to a worker, so a subscription reads
   * `deferred` until that worker lands and fires
   * {@link WRITEBACK_INDEX_CHANGED_EVENT}.
   */
  reason: string;
  /** Underlying error text, for the pane's details line. */
  detail: string;
}

/** Reasons the last writeback-index rebuild could not install a subscription's
 *  regions. Re-read on {@link WRITEBACK_INDEX_CHANGED_EVENT}. */
export function getWritebackRebuildSkips(): Promise<WritebackRebuildSkip[]> {
  return invokeBackend("calp_get_writeback_rebuild_skips");
}

/**
 * Why opening this workbook could NOT re-materialize a subscribed application's BI
 * connections.
 *
 * Mirrors `ApplicationConnectionRestoreSkip` in app/src-tauri/src/calp_commands.rs.
 *
 * An application's BI connection is not stored in the subscriber's `.cala` — the
 * model belongs to the publisher and travels in the `.calp` — so it is rebuilt
 * on open from the subscription ledger plus the local application cache, under the
 * same signature + pin + checksum gates a pull runs. When that cannot be done
 * the report keeps its cells but has no live model, and without this list
 * "this application has no data source" and "this application's model could not be
 * verified here" look identical: a pivot that says it has no connection.
 *
 * An empty list means every subscribed application's model is live (or it declares
 * no data source).
 */
export interface ApplicationConnectionRestoreSkip {
  packageName: string;
  registryUrl: string;
  /**
   * `"unreachable"` | `"notPinned"` | `"publisherChanged"` | `"badManifest"`
   * | `"appTooOld"` | `"unsupportedTransport"` | `"unknown"`.
   *
   * `"unsupportedTransport"` is an HTTP workspace: it exposes no local model
   * artifact, so an application connection cannot be built from it — true of the
   * pull path too, not a regression of the restore.
   */
  reason: string;
  /** Underlying error text, for the pane's details line. */
  detail: string;
}

/** Reasons opening this workbook could not restore a subscribed application's BI
 *  connections. Re-read whenever the subscription list is re-read. */
export function getApplicationConnectionSkips(): Promise<ApplicationConnectionRestoreSkip[]> {
  return invokeBackend("calp_get_application_connection_skips");
}

/** Subscriber identity attached to writeback submissions. */
export interface SubmitterIdentity {
  displayName: string;
  id: string;
}

/** Get the current subscriber identity (creates one on first call). */
export function getSubscriberIdentity(): Promise<SubmitterIdentity> {
  return invokeBackend("calp_get_subscriber_identity");
}

// ============================================================================
// Phase 12: Author UI — Writeback Region Designation
// ============================================================================

/** A writeback region declaration (author-side draft or published). */
export interface WritebackRegionDeclaration {
  id: string;
  selector: RegionSelector;
  mode?: "per_subscriber" | "list_object";
  schema?: ValueSchemaConfig;
  visibility?: "own_only" | "own_plus_aggregate" | "transparent";
  submissionPolicy?: "immediate" | "on_submit" | "on_approval";
  versionBinding?: "strict" | "lenient";
  lifecycle?: LifecyclePolicyConfig;
  aggregationHint?: string;
  /** Identifiers the publisher expects to respond (completion tracking). */
  expectedRespondents?: string[];
}

export interface RegionSelector {
  sheetId: string;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

export interface ValueSchemaConfig {
  valueType: "number" | "integer" | "text" | "date" | "boolean" | "enum";
  required?: boolean;
  min?: number;
  max?: number;
  enumValues?: string[];
  maxLength?: number;
  pattern?: string;
  /** Name of a custom validator (distribution brick 3). Rides the schema's
   *  forward-compatible `extra` map on the Rust side — advisory, subscriber-side
   *  UX check layered on the authoritative built-in constraints. */
  customValidator?: string;
  /** The validator's JS function-expression BODY, published alongside the name.
   *  Required whenever `customValidator` is set: the subscriber's machine has
   *  no catalogue of the publisher's validators, so the name alone cannot be
   *  run — and the Rust submit gate FAILS CLOSED on a name without a body
   *  ("declares the custom validator '…' but ships no validator code"). Always
   *  set both together via `writebackValidatorSchemaExtra(name)`. */
  customValidatorSource?: string;
}

export interface LifecyclePolicyConfig {
  policy: "always" | "until_deadline" | "never" | "requires_unlock";
  deadline?: string;
}

/** Get all draft writeback regions for the current workbook (author mode). */
export function getWritebackDraftRegions(): Promise<WritebackRegionDeclaration[]> {
  return invokeBackend("calp_get_writeback_draft_regions");
}

/** Add a new draft writeback region. */
export function addWritebackRegion(region: WritebackRegionDeclaration): Promise<void> {
  return invokeBackend("calp_add_writeback_region", { region });
}

/** Remove a draft writeback region by ID. */
export function removeWritebackRegion(regionId: string): Promise<boolean> {
  return invokeBackend("calp_remove_writeback_region", { regionId });
}

/** Update an existing draft writeback region (replace by ID). */
export function updateWritebackRegion(region: WritebackRegionDeclaration): Promise<void> {
  return invokeBackend("calp_update_writeback_region", { region });
}

/** Look up the CellId at a position without minting. */
export function getCellId(sheetId: string, row: number, col: number): Promise<string | null> {
  return invokeBackend("calp_get_cell_id", { sheetId, row, col });
}

/** Resolve the stable SheetId for a workbook sheet index. */
export function getSheetIdForIndex(sheetIndex: number): Promise<string> {
  return invokeBackend("calp_get_sheet_id", { sheetIndex });
}

// ============================================================================
// Phase 14: Writeback Submission
// ============================================================================

export type SubmissionState = "draft" | "submitted" | "approved" | "rejected";

export interface SubmissionValue {
  type: "number" | "text" | "boolean" | "empty";
  value?: number | string | boolean;
}

export interface WritebackSubmission {
  id: string;
  regionId: string;
  cellRow: number;
  cellCol: number;
  cellId?: string;
  submitter: SubmitterIdentity;
  value: SubmissionValue;
  state: SubmissionState;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  /** Publisher's approve/reject reason, adopted on reconcile (read-back). */
  reviewReason?: string | null;
  /** Publisher who decided, adopted on reconcile. */
  reviewedBy?: string | null;
}

export interface WritebackLayer {
  formatVersion: number;
  drafts: WritebackSubmission[];
}

/** Save a writeback draft for a cell. */
export function saveWritebackDraft(
  regionId: string,
  sheetId: string,
  row: number,
  col: number,
  value: SubmissionValue,
): Promise<void> {
  return invokeBackend("calp_save_writeback_draft", { regionId, sheetId, row, col, value });
}

/** Get the current writeback layer (all drafts). */
export function getWritebackLayer(): Promise<WritebackLayer> {
  return invokeBackend("calp_get_writeback_layer");
}

/** Reconcile local submission states from the workspace (the approved/rejected
 * read-back — the return leg of the writeback loop) and return the updated
 * layer. Submitted entries adopt their current workspace state; unsent drafts
 * are untouched. This is how a subscriber learns the fate of what they sent. */
export function reconcileWriteback(): Promise<WritebackLayer> {
  return invokeBackend("calp_reconcile_writeback");
}

/** Submit all drafts for a region to the workspace of the subscription that
 * declares the region. Returns count submitted. */
export function submitRegion(regionId: string): Promise<number> {
  return invokeBackend("calp_submit_region", { regionId });
}

/** Submit the drafts of EVERY writeback region that has any ("submit all").
 * Returns the total values submitted; surfaces the first region's error. */
export function submitAllRegions(): Promise<number> {
  return invokeBackend("calp_submit_all_regions");
}

/** One value that would leave the machine on submit. */
export interface OutboundValue {
  cellRow: number;
  cellCol: number;
  valueDisplay: string;
  valueKind: "number" | "text" | "boolean" | "empty";
}

/** A read-only preview of exactly what submitRegion would send — destination
 * application + workspace, the submitter identity, and each draft value — so the
 * user can review what leaves the machine before it leaves. */
export interface OutboundSubmissionPreview {
  regionId: string;
  packageName: string;
  resolvedVersion: string;
  registryPath: string;
  submitterId: string;
  submitterName: string;
  values: OutboundValue[];
  /** The publisher-shipped custom validator that WILL judge this submission,
   *  when the region declares one. The body is read from the Ed25519-verified
   *  manifest, so what the user reviews here is byte-identical to what the
   *  backend executes. Mirrors `OutboundValidator` in calp_commands.rs. */
  validator?: {
    name: string;
    source: string;
    sourceHash: string;
    consented: boolean;
  };
  /** Set when the region declares a validator NAME but the application ships no
   *  BODY for it — the submission WILL be refused (fail-closed) until the
   *  publisher republishes with the validator body included. */
  validatorError?: string;
}

/** Preview an outbound writeback submission without sending it. */
export function previewRegionSubmission(
  regionId: string,
): Promise<OutboundSubmissionPreview> {
  return invokeBackend("calp_preview_region_submission", { regionId });
}

/** How to render an application version to self-contained HTML (recipient reach):
 *  `static` = a stacked, print-ready report; `viewer` = a multi-sheet tabbed
 *  viewer with embedded navigation. Both are single offline-openable .html. */
export type HtmlExportMode = "static" | "viewer";

/** Render a published application version to a self-contained HTML string that any
 *  browser/phone/Mac can open WITHOUT Calcula. */
export function exportPackageHtml(
  registryPath: string,
  packageName: string,
  version: string,
  mode: HtmlExportMode,
): Promise<string> {
  return invokeBackend("calp_export_application_html", {
    registryPath,
    packageName,
    version,
    mode,
  });
}

/** Approve, reject, or reset a submitted writeback value (publisher action).
 * Pass the `submissionId` shown in the dashboard so the decision targets
 * exactly the reviewed submission — if a newer one arrived in the meantime the
 * backend refuses with a "superseded" error instead of deciding blind. */
export function setSubmissionState(
  regionId: string,
  submitterId: string,
  cellRow: number,
  cellCol: number,
  newState: "approved" | "rejected" | "submitted",
  reason?: string | null,
  submissionId?: string | null,
): Promise<void> {
  return invokeBackend("calp_set_submission_state", {
    regionId,
    submitterId,
    cellRow,
    cellCol,
    newState,
    reason: reason ?? null,
    submissionId: submissionId ?? null,
  });
}

/** One submission row for the publisher data-collection dashboard (D5). */
export interface RegionSubmission {
  /** The submission event id this row shows — pass back on approve/reject. */
  submissionId: string;
  regionId: string;
  cellRow: number;
  cellCol: number;
  submitterId: string;
  submitterName: string;
  valueDisplay: string;
  valueKind: "number" | "text" | "boolean" | "empty";
  state: "draft" | "submitted" | "approved" | "rejected";
  submittedAt: string | null;
  updatedAt: string;
  /** Publisher's reason for the approve/reject decision (if any). */
  reviewReason?: string | null;
  /** Display name of the publisher who decided. */
  reviewedBy?: string | null;
}

/** Load every submission for a writeback region across all submitters — the
 *  publisher's "see all" view (D5). Not filtered by per-subscriber visibility. */
export function loadRegionSubmissions(regionId: string): Promise<RegionSubmission[]> {
  return invokeBackend("calp_load_region_submissions", { regionId });
}

/** Export every submission for a region as CSV text (publisher data-collection
 * output). The caller saves the returned string as a .csv file. */
export function exportRegionSubmissionsCsv(regionId: string): Promise<string> {
  return invokeBackend("calp_export_region_submissions_csv", { regionId });
}

/** Export every submission for a region as Parquet bytes (typed, columnar —
 * directly readable by DuckDB / Snowflake / Spark / pandas / Polars). The caller
 * saves the returned bytes as a .parquet file. */
export function exportRegionSubmissionsParquet(regionId: string): Promise<number[]> {
  return invokeBackend("calp_export_region_submissions_parquet", { regionId });
}

/** Whether the auto-materialized Parquet rollup is enabled for the application
 * owning this region (publisher opt-in, default off). */
export function getWritebackRollup(regionId: string): Promise<boolean> {
  return invokeBackend("calp_get_writeback_rollup", { regionId });
}

/** Publisher-only: enable/disable the auto-materialized Parquet rollup for the
 * application owning this region. Enabling writes the rollup immediately. */
export function setWritebackRollup(regionId: string, enabled: boolean): Promise<void> {
  return invokeBackend("calp_set_writeback_rollup", { regionId, enabled });
}

/** Completion-tracking status: declared expected respondents, who responded,
 * and who is still missing. */
export interface RegionResponseStatus {
  expected: string[];
  responded: string[];
  missing: string[];
}

/** Who has responded vs. who is still expected for a region. */
export function regionResponseStatus(regionId: string): Promise<RegionResponseStatus> {
  return invokeBackend("calp_region_response_status", { regionId });
}

// ============================================================================
// Submission watch (§5.5): the honest push behind WRITEBACK_SUBMISSION_RECEIVED
// ============================================================================
//
// THE PROBLEM. A subscriber submits by APPENDING to a workspace on disk (or a
// share) from THEIR machine. The publisher's Calcula is not in that path and
// receives nothing — so until now a publisher learned about answers by opening
// the Responses pane and looking, and a script could not react at all.
//
// WHAT A REAL PUSH WOULD NEED, and why it does not exist: an OS file watcher on
// the workspace, plus a way to know which of its thousands of files matter. The
// workspace is an append-only event log that Rust folds on read; there is no
// change feed, no sequence cursor, and no per-region "latest" marker to watch.
// So a true push is not available, and inventing an event that never fires
// would be worse than none.
//
// WHAT THIS IS INSTEAD, stated plainly: a POLL, wearing an event. It is
// acceptable here only because all three of these hold:
//
//  1. DEMAND-DRIVEN. Nothing polls until something subscribes. The script host
//     acquires a watch when a script subscribes to the event and releases it at
//     unmount; the Responses pane acquires one while it is open. Refcount zero
//     = timer cleared = zero cost, which is the default state of every workbook.
//  2. BOUNDED. One pass every SUBMISSION_POLL_INTERVAL_MS, sequential, one IPC
//     per PUBLISHER-OWNED region. A region that refuses the publisher gate is
//     recorded and never polled again this session, so a subscriber-only
//     workbook settles at ONE region-list call per interval and no inbox reads.
//     Passes never overlap (a slow pass skips the next tick).
//  3. DISCLOSED. getSubmissionWatchStatus() reports the refcount, the interval,
//     which regions are watched, when the last pass ran and what it cost, so the
//     poll can be shown to the user rather than merely documented here.
//
// AUTHORIZATION IS NOT THIS FILE'S. Every inbox read goes through
// calp_load_region_submissions, which re-proves Ed25519 publisher-key
// possession in Rust on every call. The watcher cannot see a submission the
// caller was not already entitled to fetch by hand.

/** How often a pass runs while at least one watcher is registered. */
export const SUBMISSION_POLL_INTERVAL_MS = 60_000;

/** Per-event cap on the `submissions` array (the count is always exact). */
export const MAX_REPORTED_SUBMISSIONS = 50;

/** Live state of the submission watch, for disclosure surfaces. */
export interface SubmissionWatchStatus {
  /** How many holders currently want the watch (0 = nothing is polling). */
  refCount: number;
  running: boolean;
  intervalMs: number;
  /** Regions polled on the last pass (publisher-owned ones only). */
  watchedRegionIds: string[];
  /** Regions skipped for the rest of the session: not published by this
   *  machine, so their inbox is not ours to read. */
  skippedRegionIds: string[];
  /** ISO 8601 timestamp of the last completed pass, or null. */
  lastPollAt: string | null;
  /** Backend calls the last pass made (1 region list + 1 per watched region). */
  lastPollCalls: number;
  /** Failure of the last pass, if any (never thrown — a poll must not break
   *  the app, and a permanently failing poll must be visible, not silent). */
  lastError: string | null;
}

let watchRefCount = 0;
let watchTimer: ReturnType<typeof setInterval> | null = null;
/** The pass currently running, so two never overlap (a slow pass makes the next
 *  tick a no-op rather than stacking a second walk of the workspace). */
let inFlightPass: Promise<void> | null = null;
/** regionId -> submission ids already reported (replaced each pass, so this is
 *  bounded by the region's live slot count rather than by history). */
const seenSubmissionIds = new Map<string, Set<string>>();
/** Regions whose inbox this machine may not read (not the publisher). */
const nonPublisherRegions = new Set<string>();
let lastPollAt: string | null = null;
let lastPollCalls = 0;
let lastWatchError: string | null = null;
let watchedRegionIds: string[] = [];

/** True when the failure is the publisher gate refusing, rather than a
 *  transient I/O problem. Only this class disables a region for the session —
 *  a missing network share must be retried, a missing signing key never
 *  succeeds. Mirrors require_publisher's message in calp_commands.rs. */
function isPublisherRefusal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /only the publisher of/i.test(msg) || /can view or manage its writeback submissions/i.test(msg);
}

/**
 * Run ONE pass. `announce` false primes the seen-sets without emitting — used
 * on the first pass after the watch starts, because "this submission exists"
 * is not "this submission just arrived", and a publisher whose script starts
 * on a full inbox must not be told the whole history is new.
 */
async function doSubmissionPass(announce: boolean): Promise<void> {
  let calls = 0;
  // Pass-local, then published once at the end. Assigning lastWatchError as we
  // go and clearing it on success loses a per-region failure the moment any
  // other region succeeds — which is exactly the case worth reporting.
  let passError: string | null = null;
  try {
    const regions = await getWritebackRegions();
    calls += 1;
    const liveRegionIds = new Set(regions.map((r) => r.regionId));
    // Forget state for regions that no longer exist (unsubscribed application).
    for (const id of [...seenSubmissionIds.keys()]) {
      if (!liveRegionIds.has(id)) seenSubmissionIds.delete(id);
    }
    for (const id of [...nonPublisherRegions]) {
      if (!liveRegionIds.has(id)) nonPublisherRegions.delete(id);
    }

    const watched: string[] = [];
    for (const region of regions) {
      const regionId = region.regionId;
      if (nonPublisherRegions.has(regionId)) continue;
      let rows: RegionSubmission[];
      try {
        rows = await loadRegionSubmissions(regionId);
        calls += 1;
      } catch (err) {
        calls += 1;
        if (isPublisherRefusal(err)) {
          // Not ours to read. Record it so this is a one-time cost per region.
          nonPublisherRegions.add(regionId);
          seenSubmissionIds.delete(regionId);
        } else {
          passError = err instanceof Error ? err.message : String(err);
        }
        continue;
      }
      watched.push(regionId);

      // Only "submitted" counts as ARRIVED. An approve/reject is the
      // publisher's own action and re-folds to a new record; announcing it
      // would tell a publisher their own click was an incoming answer.
      const current = new Set<string>();
      const fresh: WritebackSubmissionNotice[] = [];
      const previous = seenSubmissionIds.get(regionId);
      for (const row of rows) {
        if (row.state !== "submitted") continue;
        current.add(row.submissionId);
        if (announce && previous && !previous.has(row.submissionId)) {
          fresh.push({
            submissionId: row.submissionId,
            submitterId: row.submitterId,
            submitterName: row.submitterName,
            cellRow: row.cellRow,
            cellCol: row.cellCol,
            submittedAt: row.submittedAt ?? null,
          });
        }
      }
      // Replacing (not merging) keeps this bounded by the live slot count.
      seenSubmissionIds.set(regionId, current);

      if (fresh.length > 0) {
        const payload: WritebackSubmissionReceivedPayload = {
          regionId,
          count: fresh.length,
          submissions: fresh.slice(0, MAX_REPORTED_SUBMISSIONS),
          truncated: fresh.length > MAX_REPORTED_SUBMISSIONS,
          observedAt: new Date().toISOString(),
        };
        emitAppEvent(AppEvents.WRITEBACK_SUBMISSION_RECEIVED, payload);
      }
    }
    watchedRegionIds = watched;
  } catch (err) {
    // A poll must never break the caller. It must also never fail invisibly —
    // that is what lastError and the disclosure surface are for.
    passError = err instanceof Error ? err.message : String(err);
  } finally {
    lastWatchError = passError;
    lastPollCalls = calls;
    lastPollAt = new Date().toISOString();
  }
}

/** Start a pass, or join the one already running. Never two at once. */
function runSubmissionPass(announce: boolean): Promise<void> {
  if (inFlightPass) return inFlightPass;
  const pass = doSubmissionPass(announce).finally(() => {
    inFlightPass = null;
  });
  inFlightPass = pass;
  return pass;
}

/** Resolve when no pass is running. The priming pass a watch starts is
 *  fire-and-forget by design (acquiring must not block a subscription); this is
 *  how a caller — or a test — waits for it. */
export function whenSubmissionWatchSettled(): Promise<void> {
  return inFlightPass ?? Promise.resolve();
}

/**
 * Register interest in WRITEBACK_SUBMISSION_RECEIVED and start the poll if this
 * is the first holder. Returns a release function; the watch stops when the
 * last holder releases. The release is idempotent, so a cleanup array that runs
 * twice cannot drive the count negative and strand the timer.
 */
export function acquireSubmissionWatch(): () => void {
  watchRefCount += 1;
  if (watchRefCount === 1) {
    // Prime first (no announcements), then poll on the interval.
    void runSubmissionPass(false);
    watchTimer = setInterval(() => {
      void runSubmissionPass(true);
    }, SUBMISSION_POLL_INTERVAL_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    watchRefCount = Math.max(0, watchRefCount - 1);
    if (watchRefCount === 0 && watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
      watchedRegionIds = [];
    }
  };
}

/** Disclosure: exactly what the submission watch is doing and what it costs. */
export function getSubmissionWatchStatus(): SubmissionWatchStatus {
  return {
    refCount: watchRefCount,
    running: watchTimer !== null,
    intervalMs: SUBMISSION_POLL_INTERVAL_MS,
    watchedRegionIds: [...watchedRegionIds],
    skippedRegionIds: [...nonPublisherRegions],
    lastPollAt,
    lastPollCalls,
    lastError: lastWatchError,
  };
}

/**
 * Run a pass NOW without waiting for the interval — used by the Responses pane
 * so "Refresh" also advances the watch, and by tests. Announces like a normal
 * pass (the priming pass has already happened if a watch is held).
 */
export function pollSubmissionsNow(): Promise<void> {
  return runSubmissionPass(watchRefCount > 0);
}

/** Test/reset hook: drop every watcher, timer and remembered id. */
export function resetSubmissionWatch(): void {
  if (watchTimer !== null) clearInterval(watchTimer);
  watchTimer = null;
  watchRefCount = 0;
  inFlightPass = null;
  seenSubmissionIds.clear();
  nonPublisherRegions.clear();
  watchedRegionIds = [];
  lastPollAt = null;
  lastPollCalls = 0;
  lastWatchError = null;
}

// ============================================================================
// Live Data Sources
// ============================================================================

/** A data source that needs manual configuration (SSPI failed). */
export interface DataSourceNeedsConfig {
  dataSourceId: string;
  name: string;
  server: string;
  database: string;
  connectionType: string;
}

/** Result of a data refresh operation. */
export interface DataRefreshResponse {
  sourcesRefreshed: number;
  needsConfiguration: DataSourceNeedsConfig[];
}

/** Info about a data source in the current workbook. */
export interface DataSourceInfo {
  id: string;
  name: string;
  connectionType: string;
  server: string;
  database: string;
  isConfigured: boolean;
  packageName: string;
}

/**
 * Refresh all data sources for the current workbook's subscriptions.
 * Tries SSPI first, then uses saved credentials, or reports which
 * data sources need manual configuration.
 */
export function refreshData(): Promise<DataRefreshResponse> {
  return invokeBackend("calp_refresh_data");
}

/**
 * Save connection credentials for a data source.
 * Stored in the subscriber's local .cala file, never in the workspace.
 */
export function saveDataSourceConfig(
  dataSourceId: string,
  connectionString: string,
): Promise<void> {
  return invokeBackend("calp_save_data_source_config", { dataSourceId, connectionString });
}

/** Get all data sources for the current workbook's subscriptions. */
export function getDataSources(): Promise<DataSourceInfo[]> {
  return invokeBackend("calp_get_data_sources");
}

// ============================================================================
// Application Inspector (standalone window) — read-only deep inspection of a
// published application version. Nothing is subscribed or materialized; every
// call re-verifies the manifest signature + TOFU pin, and artifacts are only
// readable via the signed manifest's checksum keys.
// ============================================================================

export interface InspectorVersionEntry {
  version: string;
  publishedAt: string;
  publishedBy: string;
  /** The version this one was pushed from. Empty for an application's first
   *  version, and for versions published before push lineage was recorded. */
  baseVersion: string;
  /** What the author said changed, from the SIGNED version manifest. */
  changeSummary: string;
}

export interface InspectorApplicationInfo {
  name: string;
  description: string;
  kind: string;
  author: string;
  created: string;
  versions: InspectorVersionEntry[];
}

export interface InspectorManifestInfo {
  formatVersion: number;
  kind: string;
  publishedAt: string;
  publishedBy: string;
  publisherName: string;
  /** Lowercase hex Ed25519 public key of the verified signer. */
  publisherKey: string;
  minAppVersion: string;
  /** A `CalpTrustStatus`. The Application Inspector is PASSIVE (VerifyOnly): merely
   *  pointing it at a workspace folder must never pin a publisher, so an
   *  unrecognised signer reports "notPinned" — or "notPinnedNameConflict" when
   *  another workspace holds this name under a different key. */
  trustStatus: CalpTrustStatus;
  /** Pins for this same application name in OTHER workspaces. */
  otherScopePins: OtherScopePin[];
  /** Whether THIS machine holds the publisher signing key. */
  isPublisher: boolean;
  artifactCount: number;
}

export interface InspectorSheetSummary {
  sheetId: string;
  name: string;
  description: string;
  cellCount: number;
  formulaCount: number;
  mergedCount: number;
  noteCount: number;
  hyperlinkCount: number;
  hiddenRowCount: number;
  hiddenColCount: number;
  hasFreeze: boolean;
  tabColor: string;
  visibility: string;
  hasPageSetup: boolean;
  showGridlines: boolean;
}

export interface InspectorTableInfo {
  id: string;
  name: string;
  sheetName: string;
  range: string;
  columns: string[];
}

export interface InspectorNamedRangeInfo {
  name: string;
  refersTo: string;
  sheetName: string | null;
}

export interface InspectorChartInfo {
  id: string;
  sheetName: string;
  title: string | null;
}

export interface InspectorPivotInfo {
  id: string;
  sourceType: string;
  name: string | null;
}

export interface InspectorSlicerInfo {
  name: string;
  sheetName: string;
  fieldName: string;
  /** Filter level: 1 = ordinary, 2-9 = PINNED. A pin changes what the
   * application's measures return (a CLEAR/RESET measure keeps respecting it),
   * so it is surfaced before subscribing. */
  filterLevel: number;
}

export interface InspectorPaneControlInfo {
  id: string;
  name: string;
  controlType: string;
}

export interface InspectorRibbonFilterInfo {
  name: string;
  fieldName: string;
}

export interface InspectorPivotLayoutInfo {
  name: string;
  sourceType: string;
  description: string | null;
}

export interface InspectorCustomObjectInfo {
  kind: string;
  id: string;
  name: string;
  sheetName: string | null;
  payloadPath: string;
}

export interface InspectorObjectScriptInfo {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  description: string | null;
  /** R19 declared-capability ceiling from the SIGNED manifest. */
  capabilities: string[];
}

export interface InspectorModuleScriptInfo {
  id: string;
  name: string;
  scope: string;
  description: string | null;
}

export interface InspectorNotebookInfo {
  id: string;
  name: string;
  cellCount: number;
}

export interface InspectorBindingInfo {
  modelTable: string;
  schema: string;
  sourceTable: string;
  hasQuery: boolean;
}

export interface InspectorSnapshotRef {
  table: string;
  path: string;
}

export interface InspectorDataSourceInfo {
  id: string;
  name: string;
  connectionType: string;
  server: string;
  database: string;
  modelPath: string;
  bindings: InspectorBindingInfo[];
  calculatedTableSnapshots: InspectorSnapshotRef[];
  hasWritebackHistory: boolean;
}

export interface InspectorArtifactEntry {
  path: string;
  sha256: string;
}

export interface InspectorOverview {
  package: InspectorApplicationInfo;
  resolvedVersion: string;
  manifest: InspectorManifestInfo;
  sheets: InspectorSheetSummary[];
  tables: InspectorTableInfo[];
  namedRanges: InspectorNamedRangeInfo[];
  charts: InspectorChartInfo[];
  sparklineSheets: string[];
  pivots: InspectorPivotInfo[];
  slicers: InspectorSlicerInfo[];
  paneControls: InspectorPaneControlInfo[];
  ribbonFilters: InspectorRibbonFilterInfo[];
  pivotLayouts: InspectorPivotLayoutInfo[];
  conditionalFormatSheets: string[];
  dataValidationSheets: string[];
  controlSheets: string[];
  commentSheets: string[];
  scenarioSheets: string[];
  outlineSheets: string[];
  hasTheme: boolean;
  themeName: string | null;
  extensionDataKeys: string[];
  customObjects: InspectorCustomObjectInfo[];
  objectScripts: InspectorObjectScriptInfo[];
  /** Excludes the reserved Custom Functions library module (see
   * customFunctionCount). */
  moduleScripts: InspectorModuleScriptInfo[];
  notebooks: InspectorNotebookInfo[];
  /** Functions in the reserved Custom Functions library, 0 when absent. */
  customFunctionCount: number;
  dataSources: InspectorDataSourceInfo[];
  writebackRegionCount: number;
  modelWritebackCount: number;
  lockedSheetCount: number;
  lockedCellCount: number;
  artifacts: InspectorArtifactEntry[];
}

export interface InspectorCell {
  a1: string;
  row: number;
  col: number;
  /** "s" | "n" | "b" | "e" | "l" | "d" | "x". */
  cellType: string;
  display: string;
  /** Formula WITHOUT the leading '='. */
  formula: string | null;
  styleIndex: number | null;
  hasRichText: boolean;
}

export interface InspectorUsedRange {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

export interface InspectorMergedRegion {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface InspectorSheetMetadata {
  mergedRegions: InspectorMergedRegion[];
  freezeRow: number | null;
  freezeCol: number | null;
  hiddenRowCount: number;
  hiddenColCount: number;
  tabColor: string;
  visibility: string;
  noteCount: number;
  hyperlinkCount: number;
  hasPageSetup: boolean;
  showGridlines: boolean;
}

export interface InspectorSheetDetail {
  sheetId: string;
  name: string;
  cells: InspectorCell[];
  totalCellCount: number;
  formulaCount: number;
  truncated: boolean;
  usedRange: InspectorUsedRange | null;
  columnWidths: Record<string, number>;
  rowHeights: Record<string, number>;
  styleCount: number;
  styledCellCount: number;
  metadata: InspectorSheetMetadata;
}

export interface InspectorObjectScriptDetail {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  description: string | null;
  capabilities: string[];
  source: string;
}

export interface InspectorModuleScriptDetail {
  id: string;
  name: string;
  scope: string;
  description: string | null;
  source: string;
}

export interface InspectorNotebookCell {
  id: string;
  source: string;
}

export interface InspectorNotebookDetail {
  id: string;
  name: string;
  cells: InspectorNotebookCell[];
}

export interface InspectorCustomFunctions {
  functionNames: string[];
  capabilities: string[];
}

export interface InspectorScripts {
  objectScripts: InspectorObjectScriptDetail[];
  moduleScripts: InspectorModuleScriptDetail[];
  notebooks: InspectorNotebookDetail[];
  customFunctions: InspectorCustomFunctions | null;
}

export interface InspectorModelColumn {
  name: string;
  dataType: string;
}

export interface InspectorModelTable {
  name: string;
  columns: InspectorModelColumn[];
}

export interface InspectorModelMeasure {
  name: string;
  /** Measure group, when the model organizes measures into groups. */
  group: string | null;
  expression: string;
}

export interface InspectorModelRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface InspectorSnapshotDetail {
  table: string;
  path: string;
  sizeBytes: number;
}

export interface InspectorModel {
  dataSourceId: string;
  name: string;
  modelFormatVersion: number | null;
  tables: InspectorModelTable[];
  measures: InspectorModelMeasure[];
  relationships: InspectorModelRelationship[];
  calculatedColumnCount: number;
  hierarchyCount: number;
  calculationGroupCount: number;
  kpiCount: number;
  securityRoleCount: number;
  globalVariableCount: number;
  scriptFunctionCount: number;
  contextCount: number;
  dateTable: string | null;
  calculatedTableSnapshots: InspectorSnapshotDetail[];
  hasWritebackHistory: boolean;
}

export interface InspectorWritebackRegion {
  id: string;
  sheetName: string;
  range: string;
  mode: string | null;
  valueType: string | null;
  visibility: string | null;
  submissionPolicy: string | null;
  versionBinding: string | null;
  lifecycle: string | null;
  aggregationHint: string | null;
  expectedRespondents: string[];
}

export interface InspectorModelWriteback {
  id: string;
  dataSourceId: string;
  table: string;
  column: string;
  keyColumns: string[];
  kind: string;
  valueType: string | null;
  allowedEditors: string[];
  submissionPolicy: string | null;
}

export interface InspectorRegionStats {
  regionId: string;
  submissionCount: number;
  submitterCount: number;
  approved: number;
  rejected: number;
  pending: number;
}

export interface InspectorSubmissionDetail {
  regionId: string;
  submitterName: string;
  cellRow: number;
  cellCol: number;
  modelKey: string[] | null;
  valueDisplay: string;
  valueKind: string;
  state: string;
  updatedAt: string;
  /** Publisher's approve/reject feedback, when a decision exists. */
  reviewReason: string | null;
  reviewedBy: string | null;
}

export interface InspectorWriteback {
  regions: InspectorWritebackRegion[];
  modelWritebacks: InspectorModelWriteback[];
  /** Response activity (stats, counts, values, rollup) is PUBLISHER-ONLY —
   * even aggregates would bypass a region's visibility policy. Empty/zero
   * unless this machine holds the signing key. */
  regionStats: InspectorRegionStats[];
  totalSubmissions: number;
  reviewEventCount: number;
  isPublisher: boolean;
  submissions: InspectorSubmissionDetail[];
  /** Derived Parquet rollup at submissions/_rollup.parquet (publisher-only). */
  rollupPresent: boolean;
  rollupSizeBytes: number | null;
}

export interface InspectorArtifact {
  path: string;
  sizeBytes: number;
  sha256: string;
  expectedSha256: string;
  verified: boolean;
  /** "json" | "text" | "binary". */
  contentKind: string;
  text: string | null;
  truncated: boolean;
}

export interface InspectorArtifactVerification {
  path: string;
  /** "ok" | "mismatch" | "missing". */
  status: string;
  sizeBytes: number;
}

export interface InspectorVerifyReport {
  signatureOk: boolean;
  /** A `CalpTrustStatus` — see `InspectorManifestInfo.trustStatus`. */
  trustStatus: CalpTrustStatus;
  publisherName: string;
  artifacts: InspectorArtifactVerification[];
  unlisted: string[];
  allOk: boolean;
}

export interface ResolvedWorkspaceLocation {
  /** The workspace ROOT to browse (walked up from whatever was picked). */
  registryPath: string;
  /** Set when the picked folder was an application (or version) directory. */
  packageName: string | null;
  /** Set when the picked folder was a specific version directory. */
  version: string | null;
}

/** Walk a picked folder up to its workspace root (application/version dirs are
 * recognized and pre-selected). Unrecognized paths pass through unchanged. */
export function inspectorResolveLocation(path: string): Promise<ResolvedWorkspaceLocation> {
  return invokeBackend("calp_inspector_resolve_location", { path });
}

/** Deep overview of an application version (Application Inspector landing payload). */
export function inspectorOverview(
  registryPath: string,
  packageName: string,
  versionPin: string,
): Promise<InspectorOverview> {
  return invokeBackend("calp_inspector_overview", { registryPath, packageName, versionPin });
}

/** Full cell-level view of one published sheet. */
export function inspectorSheet(
  registryPath: string,
  packageName: string,
  versionPin: string,
  sheetId: string,
  maxCells?: number,
): Promise<InspectorSheetDetail> {
  return invokeBackend("calp_inspector_sheet", {
    registryPath,
    packageName,
    versionPin,
    sheetId,
    maxCells: maxCells ?? null,
  });
}

/** Every line of code the application carries, with full source. */
export function inspectorScripts(
  registryPath: string,
  packageName: string,
  versionPin: string,
): Promise<InspectorScripts> {
  return invokeBackend("calp_inspector_scripts", { registryPath, packageName, versionPin });
}

/** Summary of one embedded BI model (schema only, never credentials). */
export function inspectorModel(
  registryPath: string,
  packageName: string,
  versionPin: string,
  dataSourceId: string,
): Promise<InspectorModel> {
  return invokeBackend("calp_inspector_model", {
    registryPath,
    packageName,
    versionPin,
    dataSourceId,
  });
}

/** Writeback declarations + folded post-publish response activity. */
export function inspectorWriteback(
  registryPath: string,
  packageName: string,
  versionPin: string,
): Promise<InspectorWriteback> {
  return invokeBackend("calp_inspector_writeback", { registryPath, packageName, versionPin });
}

/** Raw view of one signed artifact (pretty JSON / text / binary summary). */
export function inspectorArtifact(
  registryPath: string,
  packageName: string,
  versionPin: string,
  artifactPath: string,
): Promise<InspectorArtifact> {
  return invokeBackend("calp_inspector_artifact", {
    registryPath,
    packageName,
    versionPin,
    artifactPath,
  });
}

/** Full integrity audit: per-artifact hash verification report. */
export function inspectorVerifyArtifacts(
  registryPath: string,
  packageName: string,
  versionPin: string,
): Promise<InspectorVerifyReport> {
  return invokeBackend("calp_inspector_verify_artifacts", {
    registryPath,
    packageName,
    versionPin,
  });
}
