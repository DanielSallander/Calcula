//! FILENAME: app/src/api/scriptSecurity.ts
// PURPOSE: The global "Script Security" gate (disabled/prompt/enabled) AND the
//   persistent, revocable per-workbook TRUST store that stops "prompt" from
//   degenerating into nagware — Calcula's answer to Excel's Trusted Documents.
// CONTEXT: The setting governs ALL user-authored code execution, across THREE
//   enforcement points:
//   1. run_script / notebook / MCP: gate in Rust via a backend sentinel error.
//   2. Workbook-embedded Worker surfaces (object scripts, custom chart marks,
//      custom chart transforms, JS UDF libraries): gate at `assertMountAllowed`
//      (`@api/scriptHost/mountGate`), called by `hostMountScript` BEFORE spawning
//      any worker. Object scripts ALSO gate earlier at their own layer (a
//      load-time batch gate + `ObjectScriptManager.mountScript`) for an
//      object-specific prompt + a soft, no-error refusal; the host gate is the
//      shared floor behind them.
//   3. Distributed (installed) 3rd-party extensions, which run in their own
//      Worker realm: gate at `ExtensionManager.loadExtension`.
//   So "disabled" is a true lockdown: NO custom code runs anywhere.
//
// ---------------------------------------------------------------------------
// THE CONSENT-FATIGUE PROBLEM (and why per-workbook trust exists)
// ---------------------------------------------------------------------------
//   The default level is "prompt", and the backend's approval is SESSION-scoped
//   (`grant_script_session_approval`). That means every app restart re-prompted
//   before the user's OWN workbook could mount its OWN scripts — including its
//   onOpen hooks. The only escape was flipping the global setting to "enabled",
//   which turns the gate off for every workbook from every source. A security
//   control whose only usable position is "off" protects nothing, so this module
//   adds the middle position Excel shipped 15 years ago: trust THIS document.
//
//   Non-negotiable properties of that trust (each enforced below):
//   - HASH-BOUND. Trust is keyed to the workbook AND to the source hash of every
//     local script it covers, reusing the same hashing + diff machinery as
//     distributed-script consent (`./distributedConsent`). Editing a script (or
//     adding one) LAPSES trust and re-prompts WITH A DIFF.
//   - NEVER A CAPABILITY GRANT. Trusting a workbook to RUN its scripts grants
//     no capability at all: net.fetch / bi.query / bi.sql / bi.model /
//     distribution.writeback etc. keep their own separate consent flow. The
//     trust record stores the DECLARED capability set only as an escalation
//     baseline — if the code later declares a capability that was not declared
//     when trust was given, trust lapses and re-prompts.
//   - REVOCABLE + VISIBLE. Every record is listed and one-click revocable in
//     Settings > Script Security.
//   - LOCAL-ONLY, NEVER A FILE ATTRIBUTE. See the guarantee below.
//   - LOCAL SCRIPTS ONLY. Trust is computed over the workbook's OWN (provenance
//     "local") code. Code that arrived in a .calp package is excluded from the
//     trusted set entirely and keeps its per-package consent in
//     `./distributedConsent`; trust never satisfies that consent. (Workbook
//     trust does satisfy the GLOBAL Script Security floor for this workbook,
//     which is exactly what the floor is — a global on/off. A package script
//     still cannot mount until its own package consent is current.)
//
// ---------------------------------------------------------------------------
// HOW WE GUARANTEE TRUST NEVER TRAVELS WITH THE FILE
// ---------------------------------------------------------------------------
//   Trust is written ONLY to `localStorage` under TRUST_STORAGE_KEY. localStorage
//   belongs to the WebView profile of the signed-in OS user on THIS machine
//   (%LOCALAPPDATA%\com.calcula.app\...) — it is host state, not document state.
//   Nothing in this module ever calls createVirtualFile/readVirtualFile, so no
//   byte of it is written into the .cala archive, into a .calp package, or into
//   any exported artifact. (Contrast `./distributedConsent`, which DELIBERATELY
//   persists inside the workbook because package consent must survive a copy.)
//   Consequence: a workbook emailed, copied, or synced from another machine
//   arrives with ZERO trust and prompts on first run, no matter what it contains
//   — a malicious author cannot pre-trust their own file. Belt and braces: the
//   record is additionally keyed to the absolute file path AND to the script
//   hashes, so even an attacker who could plant a localStorage entry would have
//   to match both the victim's path and their exact script bytes.
//
//   Corollary: an UNSAVED workbook has no path, therefore no trust key, and can
//   never be persistently trusted. It falls back to the session prompt. This is
//   deliberate and mirrors Excel (a Trusted Document must have a location).
//
// ---------------------------------------------------------------------------
// THREE INDEPENDENT DECISIONS LIVE IN THE SAME RECORD
// ---------------------------------------------------------------------------
//   `WorkbookTrustRecord` holds three things, and they NEVER imply one another:
//     runTrust        - "this workbook's own scripts may EXECUTE". Grants no
//                       capability, ever.
//     notebookGrants  - "this notebook may use these capabilities" (not
//                       source-hash-bound; see the note above those helpers).
//     scriptGrants    - "this object script may use these capabilities",
//                       SOURCE-HASH-BOUND, per capability, per net.fetch origin.
//   They share one file because they share one identity (the workbook) and one
//   revoke surface (Settings > Script Security) — not because they share a
//   meaning. Every read path below reads exactly one of them.

import { invokeBackend } from "./backend";
import { emitAppEvent, onAppEvent, AppEvents } from "./events";
import { sha256Hex, diffScriptSets, declaredCapabilitySet } from "./distributedConsent";
import type { ConsentedScript, ChangedScript } from "./distributedConsent";
import { isCapabilityId, type CapabilityId } from "./scriptHost/capabilityIds";

// ============================================================================
// The global Script Security level
// ============================================================================

export type ScriptExecutionStatus = "allowed" | "disabled" | "needsApproval";

/** The three positions of the global Script Security setting. */
export type ScriptSecurityLevel = "disabled" | "prompt" | "enabled";

/** Canonical order for the Settings UI (most restrictive first). */
export const SCRIPT_SECURITY_LEVELS: readonly ScriptSecurityLevel[] = [
  "disabled",
  "prompt",
  "enabled",
] as const;

/** Short label + honest description of what each level actually does. The
 *  prompt text points users at this setting, so the setting must exist and must
 *  not oversell itself. */
export const SCRIPT_SECURITY_LEVEL_INFO: Record<
  ScriptSecurityLevel,
  { label: string; summary: string; detail: string }
> = {
  disabled: {
    label: "Disable all scripts",
    summary: "No custom code runs anywhere. Nothing is asked.",
    detail:
      "Object scripts, custom chart marks and transforms, worksheet-function " +
      "libraries, notebooks, one-off scripts, AI tool calls and installed " +
      "third-party extensions are all blocked. Formulas, pivots and charts keep " +
      "working — only user-authored code stops.",
  },
  prompt: {
    label: "Ask before running scripts (recommended)",
    summary: "Asks once per workbook, then remembers if you trust it.",
    detail:
      "You are asked before this workbook's code runs. You can trust an " +
      "individual workbook so it stops asking; that trust is stored on this " +
      "computer only, is tied to the exact code you approved, and lapses the " +
      "moment that code changes. Trusting a workbook never grants a capability " +
      "(network, BI queries, writeback) — those are always asked separately, " +
      "per script. You can answer 'Always allow in this workbook' to a " +
      "capability question too; that answer is stored the same way — on this " +
      "computer only, tied to that script's exact code — and is revocable here.",
  },
  enabled: {
    label: "Run all scripts without asking",
    summary: "Every workbook's code runs unprompted. Not recommended.",
    detail:
      "Code in ANY workbook you open runs without a prompt, including a file " +
      "someone just sent you. Scripts still run sandboxed and every privileged " +
      "call is still consented and audited, but you lose the chance to look " +
      "first. Prefer 'Ask' plus per-workbook trust.",
  },
};

/** The current script-execution gate state. */
export async function getScriptExecutionStatus(): Promise<ScriptExecutionStatus> {
  return invokeBackend<ScriptExecutionStatus>("script_execution_status");
}

/** Read the persisted global Script Security level. */
export async function getScriptSecurityLevel(): Promise<ScriptSecurityLevel> {
  const level = await invokeBackend<string>("get_script_security_level");
  return (SCRIPT_SECURITY_LEVELS as readonly string[]).includes(level)
    ? (level as ScriptSecurityLevel)
    : "prompt";
}

/** Set (and persist, app-wide) the global Script Security level. */
export async function setScriptSecurityLevel(level: ScriptSecurityLevel): Promise<void> {
  await invokeBackend<void>("set_script_security_level", { level });
  invalidateTrustCache();
  emitAppEvent(SCRIPT_TRUST_CHANGED);
}

/** Grant once-per-session script execution approval (after the user confirms). */
export async function grantScriptSessionApproval(): Promise<void> {
  await invokeBackend<void>("grant_script_session_approval");
}

// ============================================================================
// Persisted trust record shape
// ============================================================================

/** Event fired whenever the trust store or the security level changes, so the
 *  Settings page and any transparency surface can re-read. */
export const SCRIPT_TRUST_CHANGED = "app:script-trust-changed";

const TRUST_STORAGE_KEY = "calcula.scriptTrust.v1";

/** A persisted capability grant for ONE notebook inside ONE workbook. */
export interface NotebookCapabilityGrant {
  notebookId: string;
  /** Capability ids the user approved for this notebook, sorted. */
  capabilities: CapabilityId[];
  grantedAt: string;
}

/**
 * A persisted "Always allow in this workbook" capability decision for ONE
 * worker-realm LOCAL script (object script / chart mark / chart transform / UDF
 * library) inside ONE workbook.
 *
 * Unlike a notebook grant this IS source-hash-bound, and the asymmetry is
 * deliberate. A notebook is an authoring surface edited between every run, so
 * hashing it would re-prompt forever (see the note above the notebook helpers).
 * An object script is INSTALLED code: it sits on a shape, fires on click, on
 * open, or on a schedule, and the user is not looking at it when it runs. That
 * is exactly the code whose permission must not survive somebody rewriting it.
 */
export interface ScriptCapabilityGrant {
  /** The mount id — the same string the broker and the Rust CapabilityStore key
   *  grants under (`HostMountDefinition.id`). */
  scriptId: string;
  /** Display name, for the Settings list. */
  scriptName: string;
  /** SHA-256 of the EXACT source the user approved. A mismatch lapses the whole
   *  grant — every capability in it, not just the changed part. */
  sourceHash: string;
  /** The approved source, retained so a lapse can show a DIFF instead of asking
   *  for a blind re-approval. */
  source: string;
  /** Capability ids approved with "Always", sorted. An id NOT in this list is an
   *  escalation and always goes back through the JIT prompt. */
  capabilities: CapabilityId[];
  /** For net.fetch: the exact origins approved, sorted. An origin not in this
   *  list re-prompts even when net.fetch itself is persisted. */
  netOrigins: string[];
  grantedAt: string;
}

/** The "this workbook's own local scripts may run" decision. */
export interface WorkbookRunTrust {
  /** Every LOCAL script covered, with the exact source the user approved. */
  scripts: ConsentedScript[];
  /** Capabilities those scripts DECLARED when trust was given. Stored as the
   *  escalation baseline ONLY — this is not a grant and confers nothing. */
  declaredCapabilities: CapabilityId[];
  trustedAt: string;
}

/** One workbook's local trust state. */
export interface WorkbookTrustRecord {
  /** Normalized absolute path (lowercased, forward slashes) — the identity key. */
  workbookKey: string;
  /** Path as the user sees it, for the Settings list. */
  displayPath: string;
  /** null when run-trust was never granted, or has been revoked. */
  runTrust: WorkbookRunTrust | null;
  /** Persisted notebook capability grants (kept SEPARATE from runTrust: a
   *  workbook can be trusted to run with zero capability grants, and a notebook
   *  grant can exist without the workbook being run-trusted). */
  notebookGrants: NotebookCapabilityGrant[];
  /** Persisted "Always allow" capability grants for this workbook's own
   *  worker-realm scripts. SEPARATE from runTrust for the same reason: run-trust
   *  says "this code may execute", never "this code may reach the network". */
  scriptGrants: ScriptCapabilityGrant[];
}

interface TrustFile {
  version: 1;
  records: WorkbookTrustRecord[];
}

/** Why a previously-trusted workbook stopped being trusted. */
export type WorkbookTrustLapseReason =
  | "sourceChanged"
  | "scriptAdded"
  | "capabilityEscalation";

/** The result of checking a workbook's code against its stored trust. */
export interface WorkbookTrustEvaluation {
  status: "trusted" | "untrusted" | "lapsed";
  /** Set only when status is "lapsed"; the PRIMARY reason (code identity beats
   *  capability escalation, because a changed script must be reviewed first). */
  reason: WorkbookTrustLapseReason | null;
  /** Scripts whose source changed since trust was given (old + new, for a diff). */
  changedScripts: ChangedScript[];
  /** Scripts that did not exist when trust was given. */
  addedScripts: Array<{ id: string; source: string }>;
  /** Capabilities newly DECLARED since trust was given (an escalation). */
  addedCapabilities: CapabilityId[];
}

/** A local script participating in workbook trust. */
export interface TrustableScript {
  id: string;
  name: string;
  source: string;
}

// ============================================================================
// Storage (localStorage only — see the header guarantee)
// ============================================================================

function readTrustFile(): TrustFile {
  try {
    const raw = localStorage.getItem(TRUST_STORAGE_KEY);
    if (!raw) return { version: 1, records: [] };
    const parsed = JSON.parse(raw) as TrustFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.records)) {
      // Defensive normalization: a hand-edited/partial entry must never make the
      // evaluator throw, and must never read as "trusted" by accident.
      return {
        version: 1,
        records: parsed.records
          .filter((r) => r && typeof r.workbookKey === "string" && r.workbookKey.length > 0)
          .map((r) => ({
            workbookKey: r.workbookKey,
            displayPath: typeof r.displayPath === "string" ? r.displayPath : r.workbookKey,
            runTrust:
              r.runTrust && Array.isArray(r.runTrust.scripts)
                ? {
                    scripts: r.runTrust.scripts,
                    declaredCapabilities: Array.isArray(r.runTrust.declaredCapabilities)
                      ? r.runTrust.declaredCapabilities
                      : [],
                    trustedAt:
                      typeof r.runTrust.trustedAt === "string" ? r.runTrust.trustedAt : "",
                  }
                : null,
            // Capability ids are filtered to the RECOGNIZED vocabulary at read
            // time, not just at use time. A notebook grant is re-mirrored into
            // the backend by `rehydrateNotebookCapabilityGrants` with no ceiling
            // in front of it (a notebook declares none), so this file is the last
            // place an id from tampered local storage could be caught before it
            // becomes a `grant_script_capability` argument. Rust's own allowlist
            // is the authority that makes the attack pointless; this is the layer
            // that makes it impossible to attempt.
            notebookGrants: Array.isArray(r.notebookGrants)
              ? r.notebookGrants
                  .filter(
                    (g) => g && typeof g.notebookId === "string" && Array.isArray(g.capabilities),
                  )
                  .map((g) => ({
                    notebookId: g.notebookId,
                    capabilities: g.capabilities.filter(isCapabilityId),
                    grantedAt: typeof g.grantedAt === "string" ? g.grantedAt : "",
                  }))
                  .filter((g) => g.capabilities.length > 0)
              : [],
            // A script grant with no sourceHash could never be matched against
            // live code, so it would either lapse forever or (worse, if the
            // check were sloppy) apply to anything. Drop it at read time.
            scriptGrants: Array.isArray(r.scriptGrants)
              ? r.scriptGrants
                  .filter(
                    (g) =>
                      g &&
                      typeof g.scriptId === "string" &&
                      g.scriptId.length > 0 &&
                      typeof g.sourceHash === "string" &&
                      g.sourceHash.length > 0 &&
                      Array.isArray(g.capabilities),
                  )
                  .map((g) => ({
                    scriptId: g.scriptId,
                    scriptName: typeof g.scriptName === "string" ? g.scriptName : g.scriptId,
                    sourceHash: g.sourceHash,
                    source: typeof g.source === "string" ? g.source : "",
                    capabilities: g.capabilities.filter(isCapabilityId),
                    netOrigins: Array.isArray(g.netOrigins)
                      ? g.netOrigins.filter((o): o is string => typeof o === "string")
                      : [],
                    grantedAt: typeof g.grantedAt === "string" ? g.grantedAt : "",
                  }))
              : [],
          })),
      };
    }
  } catch {
    // Unreadable store — fail CLOSED (no trust), never throw into a mount path.
  }
  return { version: 1, records: [] };
}

function writeTrustFile(file: TrustFile): void {
  try {
    localStorage.setItem(TRUST_STORAGE_KEY, JSON.stringify(file));
  } catch (e) {
    console.warn("[scriptSecurity] could not persist workbook trust:", e);
  }
  invalidateTrustCache();
  emitAppEvent(SCRIPT_TRUST_CHANGED);
}

/** Drop records that no longer carry any decision, so revoking really removes
 *  the workbook from the user-visible list instead of leaving a husk. */
function prune(records: WorkbookTrustRecord[]): WorkbookTrustRecord[] {
  return records.filter(
    (r) => r.runTrust !== null || r.notebookGrants.length > 0 || r.scriptGrants.length > 0,
  );
}

/** Every workbook the user has made a persistent decision about (for the
 *  Settings list / transparency surface). */
export function listWorkbookTrust(): WorkbookTrustRecord[] {
  return readTrustFile().records;
}

/** The stored record for one workbook key, or null. */
export function getWorkbookTrustRecord(workbookKey: string): WorkbookTrustRecord | null {
  return readTrustFile().records.find((r) => r.workbookKey === workbookKey) ?? null;
}

function upsertRecord(
  workbookKey: string,
  displayPath: string,
  mutate: (record: WorkbookTrustRecord) => void,
): void {
  const file = readTrustFile();
  let record = file.records.find((r) => r.workbookKey === workbookKey);
  if (!record) {
    record = {
      workbookKey,
      displayPath,
      runTrust: null,
      notebookGrants: [],
      scriptGrants: [],
    };
    file.records.push(record);
  }
  record.displayPath = displayPath;
  mutate(record);
  writeTrustFile({ version: 1, records: prune(file.records) });
}

// ============================================================================
// Workbook identity
// ============================================================================

/** Normalize a path into the trust key: forward slashes, lowercased (Windows
 *  paths are case-insensitive, so "C:\A.cala" and "c:/a.cala" are one workbook). */
export function workbookTrustKeyFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/\\/g, "/").toLowerCase();
}

/**
 * The trust key of the workbook open right now, or null when it has never been
 * saved (an unsaved workbook cannot be persistently trusted — it has no
 * identity to bind to). Dynamically imported so this module's static dependency
 * graph stays tiny: it sits in front of every worker mount.
 */
export async function currentWorkbookTrustKey(): Promise<{
  key: string;
  displayPath: string;
} | null> {
  try {
    const { getCurrentFilePath } = await import("../core/lib/file-api");
    const path = await getCurrentFilePath();
    const key = workbookTrustKeyFromPath(path);
    return key && path ? { key, displayPath: path } : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Trust evaluation
// ============================================================================

/**
 * Compare a workbook's CURRENT local code against its stored run-trust.
 *
 * Order matters: code identity is checked before capability escalation, because
 * a changed script is the thing the user must actually read. Removing a script
 * does NOT lapse trust (less code cannot be more dangerous); adding or editing
 * one does. Dropping a declared capability does not lapse trust either — only
 * ADDING one does, which is the escalation the user never agreed to.
 */
export async function evaluateWorkbookTrust(
  record: WorkbookTrustRecord | null,
  scripts: TrustableScript[],
): Promise<WorkbookTrustEvaluation> {
  const empty: WorkbookTrustEvaluation = {
    status: "untrusted",
    reason: null,
    changedScripts: [],
    addedScripts: [],
    addedCapabilities: [],
  };
  const runTrust = record?.runTrust;
  if (!runTrust) return empty;

  const changedScripts = await diffScriptSets(runTrust.scripts, scripts);
  const addedScripts: Array<{ id: string; source: string }> = [];
  for (const script of scripts) {
    const before = runTrust.scripts.find((s) => s.id === script.id);
    if (!before) {
      addedScripts.push({ id: script.id, source: script.source });
      continue;
    }
    // A record written without a retained source cannot produce a diff, but the
    // hash still decides trust — treat a hash mismatch with no old source as an
    // addition (re-prompt, just without a diff to show).
    if (before.source === undefined) {
      const hash = await sha256Hex(script.source);
      if (hash !== before.sourceHash) addedScripts.push({ id: script.id, source: script.source });
    }
  }

  const declaredNow = declaredCapabilitySet(scripts.map((s) => s.source));
  const consented = new Set(runTrust.declaredCapabilities);
  const addedCapabilities = declaredNow.filter((c) => !consented.has(c));

  if (addedScripts.length > 0) {
    return { status: "lapsed", reason: "scriptAdded", changedScripts, addedScripts, addedCapabilities };
  }
  if (changedScripts.length > 0) {
    return { status: "lapsed", reason: "sourceChanged", changedScripts, addedScripts, addedCapabilities };
  }
  if (addedCapabilities.length > 0) {
    return {
      status: "lapsed",
      reason: "capabilityEscalation",
      changedScripts,
      addedScripts,
      addedCapabilities,
    };
  }
  return { status: "trusted", reason: null, changedScripts: [], addedScripts: [], addedCapabilities: [] };
}

/**
 * Every piece of the OPEN workbook's own (provenance "local") executable code,
 * as trustable units. Distributed/package code is excluded on purpose — trust
 * must never cover it (it keeps per-package consent in ./distributedConsent).
 *
 * codeInventory is dynamically imported: it pulls the object-script, module,
 * notebook and broker graphs, and this module is imported by the mount gate.
 */
export async function collectLocalWorkbookScripts(): Promise<TrustableScript[]> {
  try {
    const { getWorkbookCodeUnits } = await import("./codeInventory");
    const units = await getWorkbookCodeUnits();
    return units
      .filter((u) => u.provenance === "local")
      .map((u) => ({ id: `${u.surfaceId}:${u.id}`, name: u.name, source: u.source }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (e) {
    console.warn("[scriptSecurity] could not inventory local workbook code:", e);
    return [];
  }
}

/** Full trust picture for the open workbook, or null when it has no identity. */
export interface CurrentWorkbookTrust {
  key: string;
  displayPath: string;
  record: WorkbookTrustRecord | null;
  scripts: TrustableScript[];
  evaluation: WorkbookTrustEvaluation;
}

// Session cache: the gate runs before EVERY worker mount, and a full inventory
// per mount would be absurd. Cleared on workbook open/new and on any trust
// mutation, so a revoke takes effect immediately ("revoked means stop").
let trustCache: { key: string; value: CurrentWorkbookTrust } | null = null;

/** Drop the cached evaluation. Exported for tests and for surfaces that mutate
 *  workbook code (a saved script edit must re-evaluate). */
export function invalidateTrustCache(): void {
  trustCache = null;
}

export async function evaluateCurrentWorkbookTrust(
  options?: { refresh?: boolean },
): Promise<CurrentWorkbookTrust | null> {
  const identity = await currentWorkbookTrustKey();
  if (!identity) return null;
  if (!options?.refresh && trustCache && trustCache.key === identity.key) {
    return trustCache.value;
  }
  const record = getWorkbookTrustRecord(identity.key);
  // Skip the (expensive) inventory when there is nothing to compare against.
  const scripts = record?.runTrust ? await collectLocalWorkbookScripts() : [];
  const evaluation = await evaluateWorkbookTrust(record, scripts);
  const value: CurrentWorkbookTrust = {
    key: identity.key,
    displayPath: identity.displayPath,
    record,
    scripts,
    evaluation,
  };
  trustCache = { key: identity.key, value };
  return value;
}

/**
 * Persist "this workbook's own scripts may run" for the OPEN workbook. Records
 * the exact source of every local script (so an edit lapses trust and can be
 * diffed) and the capability set those scripts DECLARE — as a baseline for
 * escalation detection, NOT as a grant. Returns false when the workbook has no
 * path to bind to.
 */
export async function trustCurrentWorkbook(): Promise<boolean> {
  const identity = await currentWorkbookTrustKey();
  if (!identity) return false;
  const scripts = await collectLocalWorkbookScripts();
  const hashed: ConsentedScript[] = [];
  for (const script of scripts) {
    hashed.push({
      id: script.id,
      sourceHash: await sha256Hex(script.source),
      source: script.source,
    });
  }
  upsertRecord(identity.key, identity.displayPath, (record) => {
    record.runTrust = {
      scripts: hashed,
      declaredCapabilities: declaredCapabilitySet(scripts.map((s) => s.source)),
      trustedAt: new Date().toISOString(),
    };
  });
  return true;
}

/** Revoke run-trust for one workbook. Notebook and script capability grants are
 *  SEPARATE decisions and survive; revoke them explicitly. (The converse is the
 *  property that matters: run-trust never created them in the first place.) */
export function revokeWorkbookRunTrust(workbookKey: string): void {
  const file = readTrustFile();
  const record = file.records.find((r) => r.workbookKey === workbookKey);
  if (!record) return;
  record.runTrust = null;
  writeTrustFile({ version: 1, records: prune(file.records) });
}

/** Forget EVERYTHING about one workbook — run-trust, every notebook grant and
 *  every script capability grant. When it is the OPEN workbook, the live and
 *  authoritative Rust grants are dropped too, so a running script loses the
 *  capability now rather than at the next launch. */
export function revokeWorkbookTrustEntirely(workbookKey: string): void {
  const file = readTrustFile();
  const record = file.records.find((r) => r.workbookKey === workbookKey);
  const scriptGrants = (record?.scriptGrants ?? []).map((g) => ({
    scriptId: g.scriptId,
    capabilities: [...g.capabilities],
  }));
  writeTrustFile({
    version: 1,
    records: file.records.filter((r) => r.workbookKey !== workbookKey),
  });
  void stopLiveScriptGrants(workbookKey, scriptGrants);
}

/** Clear the whole trust store (the "revoke all" escape hatch). */
export function revokeAllWorkbookTrust(): void {
  const file = readTrustFile();
  const perWorkbook = file.records.map((r) => ({
    workbookKey: r.workbookKey,
    grants: r.scriptGrants.map((g) => ({
      scriptId: g.scriptId,
      capabilities: [...g.capabilities],
    })),
  }));
  writeTrustFile({ version: 1, records: [] });
  for (const wb of perWorkbook) {
    void stopLiveScriptGrants(wb.workbookKey, wb.grants);
  }
}

// ============================================================================
// Notebook capability grants (persisted per workbook + notebook)
// ============================================================================
//
// A notebook declares no capability ceiling up front; it asks JUST IN TIME
// (BI_CONSENT_REQUIRED) and the grant is mirrored into the Rust CapabilityStore,
// which is IN-MEMORY. So every restart re-prompted for a grant the user had
// already made, on a notebook they wrote themselves. These helpers persist the
// decision locally and re-mirror it on workbook open.
//
// WHY THESE ARE NOT SOURCE-HASH-BOUND (a deliberate deviation from run-trust):
// a notebook is an authoring surface — it is edited between every run. Binding
// its capability grant to a source hash would re-prompt on essentially every
// replay, which is the exact fatigue this task exists to kill. The security
// boundary that actually matters here is the CAPABILITY SET, and that IS
// enforced: only the specific ids the user approved are re-mirrored, and asking
// for an id outside that set produces a fresh JIT prompt (escalation re-prompts).
// The grant is still per-workbook, per-notebook, local-only, and revocable.

/** Persist a JIT notebook capability grant for the OPEN workbook. Returns false
 *  when the workbook has no path (the grant stays session-only). */
export async function persistNotebookCapabilityGrant(
  notebookId: string,
  capability: CapabilityId,
): Promise<boolean> {
  const identity = await currentWorkbookTrustKey();
  if (!identity) return false;
  upsertRecord(identity.key, identity.displayPath, (record) => {
    const existing = record.notebookGrants.find((g) => g.notebookId === notebookId);
    if (existing) {
      if (!existing.capabilities.includes(capability)) {
        existing.capabilities = [...existing.capabilities, capability].sort();
        existing.grantedAt = new Date().toISOString();
      }
    } else {
      record.notebookGrants.push({
        notebookId,
        capabilities: [capability],
        grantedAt: new Date().toISOString(),
      });
    }
  });
  return true;
}

/** Whether `capability` is persistently granted to `notebookId` in the open
 *  workbook. An id outside the persisted set answers false — escalation must go
 *  back through the JIT prompt. */
export async function isNotebookCapabilityPersisted(
  notebookId: string,
  capability: CapabilityId,
): Promise<boolean> {
  const identity = await currentWorkbookTrustKey();
  if (!identity) return false;
  const record = getWorkbookTrustRecord(identity.key);
  const grant = record?.notebookGrants.find((g) => g.notebookId === notebookId);
  return !!grant && grant.capabilities.includes(capability);
}

/** Revoke every persisted capability for one notebook in one workbook. The
 *  backend mirror is dropped too, so an already-running session stops. */
export async function revokeNotebookCapabilityGrants(
  workbookKey: string,
  notebookId: string,
): Promise<void> {
  const file = readTrustFile();
  const record = file.records.find((r) => r.workbookKey === workbookKey);
  if (!record) return;
  record.notebookGrants = record.notebookGrants.filter((g) => g.notebookId !== notebookId);
  writeTrustFile({ version: 1, records: prune(file.records) });
  // "Revoked means stop": clear the authoritative in-memory grant as well, so a
  // notebook that is mounted right now loses the capability immediately rather
  // than at the next restart.
  try {
    await invokeBackend<void>("revoke_script_capabilities", {
      scriptId: notebookScriptId(notebookId),
    });
  } catch {
    // Older/other windows may not expose the revoke door; the persisted grant is
    // gone either way, so the capability cannot come back after this session.
  }
}

/** The CapabilityStore key a notebook's grants live under (mirrors
 *  ScriptNotebook's `notebook:{id}` convention). */
export function notebookScriptId(notebookId: string): string {
  return `notebook:${notebookId}`;
}

/**
 * Re-mirror the open workbook's persisted notebook grants into the authoritative
 * (in-memory) Rust CapabilityStore. Called on workbook open so replay does not
 * re-prompt for a decision the user already made. Returns how many grants were
 * restored.
 */
export async function rehydrateNotebookCapabilityGrants(): Promise<number> {
  const identity = await currentWorkbookTrustKey();
  if (!identity) return 0;
  const record = getWorkbookTrustRecord(identity.key);
  if (!record || record.notebookGrants.length === 0) return 0;
  let restored = 0;
  for (const grant of record.notebookGrants) {
    for (const capability of grant.capabilities) {
      try {
        await invokeBackend<void>("grant_script_capability", {
          scriptId: notebookScriptId(grant.notebookId),
          capability,
        });
        restored += 1;
      } catch (e) {
        console.warn(
          `[scriptSecurity] could not restore ${capability} for notebook ${grant.notebookId}:`,
          e,
        );
      }
    }
  }
  return restored;
}

// ============================================================================
// Object-script capability grants (persisted per workbook + script + SOURCE HASH)
// ============================================================================
//
// The JIT prompt (R10) has always offered "Allow always", and until now "always"
// meant "until you close Calcula": the authoritative Rust CapabilityStore is
// in-memory and starts empty every launch, and nothing on this side wrote the
// decision down. Two consequences, both bad:
//   1. the user re-answered the same question on every restart, for their OWN
//      code — the fatigue that pushes people to flip Script Security to
//      "enabled" globally, which turns the whole tier model off;
//   2. a `schedule` job restored from the .cala sat armed but DORMANT until its
//      script happened to re-ask, so the consent string's promise ("saved in
//      this workbook, so it resumes next time you open it") was only
//      conditionally true.
//
// These helpers make "always" mean what it says, WITHOUT widening anything:
//
//   HASH-BOUND.        The grant records the SHA-256 of the exact source the
//                      user approved. At mount the live source is re-hashed; a
//                      mismatch DELETES the grant (the user approved code, not
//                      a file name) and hands the next prompt a diff.
//   CEILING-BOUND.     Only capabilities still inside the script's R19 declared
//                      ceiling are restored. A pragma removal cannot leave a
//                      grant floating above the ceiling.
//   ESCALATION-SAFE.   ONLY the exact ids (and, for net.fetch, the exact
//                      origins) in the record are restored. Anything else is
//                      absent from the grant set, so the broker denies it and
//                      the JIT prompt fires — a script cannot quietly acquire a
//                      capability it was never granted.
//   NEVER RUN-TRUST.   Trusting a workbook to RUN its scripts still grants zero
//                      capabilities: nothing here reads `runTrust`, and
//                      `trustCurrentWorkbook` never writes here.
//   LOCAL-ONLY.        Same guarantee as the rest of this module (see header):
//                      localStorage, never a virtual file, so no byte of it can
//                      ride inside a .cala or a .calp to another machine.
//   REVOCABLE.         Per capability and per script, from Settings, and the
//                      revoke drops the live + Rust grant too ("revoked means
//                      stop", not "stop next launch").
//   LOCAL SCRIPTS ONLY. Distributed (.calp) scripts never JIT-prompt and never
//                      reach here — they keep per-package consent, which lives
//                      INSIDE the workbook because it must survive a copy.
//                      Callers enforce this; `persistScriptCapabilityGrant` is
//                      only reached from the local-only JIT path.

/** What a mount should re-establish for one script, plus any lapse to show. */
export interface RestoredScriptGrant {
  /** Capability ids to put back into the live grant set (and mirror to Rust). */
  capabilities: CapabilityId[];
  /** net.fetch origins to put back. Empty unless net.fetch itself was restored. */
  netOrigins: string[];
  /** Non-null when a stored grant was DISCARDED because the source changed:
   *  a user-facing explanation with a diff, to show before asking again. */
  lapseNotice: string | null;
}

/** The persisted grant for one script in the OPEN workbook, or null. */
export async function getScriptCapabilityGrant(
  scriptId: string,
): Promise<ScriptCapabilityGrant | null> {
  const identity = await currentWorkbookTrustKey();
  if (!identity) return null;
  const record = getWorkbookTrustRecord(identity.key);
  return record?.scriptGrants.find((g) => g.scriptId === scriptId) ?? null;
}

/**
 * Persist an "Always allow in this workbook" JIT decision for one LOCAL script.
 * Returns false when the workbook has no path — an unsaved workbook has no
 * identity to bind to, so the decision stays session-only (mirrors run-trust).
 *
 * If a stored grant exists for a DIFFERENT source hash it is REPLACED, not
 * merged: capabilities approved for code that no longer exists must never
 * accumulate onto its replacement.
 */
export async function persistScriptCapabilityGrant(args: {
  scriptId: string;
  scriptName: string;
  source: string;
  capability: CapabilityId;
  netOrigin?: string | null;
}): Promise<boolean> {
  const identity = await currentWorkbookTrustKey();
  if (!identity) return false;
  const sourceHash = await sha256Hex(args.source);
  const now = new Date().toISOString();
  upsertRecord(identity.key, identity.displayPath, (record) => {
    const existing = record.scriptGrants.find((g) => g.scriptId === args.scriptId);
    const fresh: ScriptCapabilityGrant = {
      scriptId: args.scriptId,
      scriptName: args.scriptName,
      sourceHash,
      source: args.source,
      capabilities: [args.capability],
      netOrigins: args.netOrigin ? [args.netOrigin] : [],
      grantedAt: now,
    };
    if (!existing) {
      record.scriptGrants.push(fresh);
      return;
    }
    if (existing.sourceHash !== sourceHash) {
      // The code changed since the earlier grant — start over from this one
      // decision instead of inheriting permissions granted to other code.
      record.scriptGrants[record.scriptGrants.indexOf(existing)] = fresh;
      return;
    }
    existing.scriptName = args.scriptName;
    existing.source = args.source;
    if (!existing.capabilities.includes(args.capability)) {
      existing.capabilities = [...existing.capabilities, args.capability].sort();
    }
    if (args.netOrigin && !existing.netOrigins.includes(args.netOrigin)) {
      existing.netOrigins = [...existing.netOrigins, args.netOrigin].sort();
    }
    existing.grantedAt = now;
  });
  return true;
}

/**
 * Decide what a mounting script may have back from its persisted grant.
 *
 * This is an INPUT to the grant flow, never a bypass of it: the caller records
 * the returned ids into the live grant set and mirrors them through the same
 * `grant_script_capability` / `grant_script_net_origin` commands a fresh consent
 * would use, so the Rust store stays the authority and its own allowlist still
 * validates every id.
 *
 * A source-hash mismatch discards the grant here and now (so it can never be
 * revived) and returns a diff for the next prompt.
 */
export async function restorePersistedScriptCapabilityGrant(args: {
  scriptId: string;
  source: string;
  /** The script's authoritative R19 ceiling (broker handle.declaredCapabilities). */
  declaredCapabilities: readonly CapabilityId[];
}): Promise<RestoredScriptGrant> {
  const none: RestoredScriptGrant = { capabilities: [], netOrigins: [], lapseNotice: null };
  const identity = await currentWorkbookTrustKey();
  if (!identity) return none;
  const record = getWorkbookTrustRecord(identity.key);
  const grant = record?.scriptGrants.find((g) => g.scriptId === args.scriptId);
  if (!grant) return none;

  const liveHash = await sha256Hex(args.source);
  if (liveHash !== grant.sourceHash) {
    // LAPSE. Drop the stored decision before returning — an edited script must
    // not keep yesterday's permissions even for the rest of this session.
    dropScriptGrant(identity.key, args.scriptId);
    return { capabilities: [], netOrigins: [], lapseNotice: describeScriptGrantLapse(grant, args.source) };
  }

  const ceiling = new Set(args.declaredCapabilities);
  const capabilities = grant.capabilities.filter((c) => ceiling.has(c));
  const netOrigins = capabilities.includes("net.fetch") ? [...grant.netOrigins] : [];
  return { capabilities, netOrigins, lapseNotice: null };
}

/** The explanation shown before re-asking a script whose persisted grant lapsed
 *  — what it used to be allowed to do, and exactly what changed in the code. */
export function describeScriptGrantLapse(
  grant: ScriptCapabilityGrant,
  newSource: string,
): string {
  const caps = grant.capabilities.join(", ") || "(none)";
  const diff = grant.source
    ? formatSourceDiff(grant.source, newSource)
    : "  (the approved source was not retained, so no diff can be shown)";
  return (
    `The code of "${grant.scriptName}" has CHANGED since you chose "Always allow".\n\n` +
    `The saved permission (${caps}) has been withdrawn — permissions follow the ` +
    `code you approved, not the script's name.\n\n` +
    `What changed:\n${diff}`
  );
}

/** Remove one script's persisted grant from one workbook (storage only). */
function dropScriptGrant(workbookKey: string, scriptId: string): void {
  const file = readTrustFile();
  const record = file.records.find((r) => r.workbookKey === workbookKey);
  if (!record) return;
  const next = record.scriptGrants.filter((g) => g.scriptId !== scriptId);
  if (next.length === record.scriptGrants.length) return;
  record.scriptGrants = next;
  writeTrustFile({ version: 1, records: prune(file.records) });
}

/**
 * "Revoked means stop": drop the live (broker) grant AND the authoritative Rust
 * grant for a script, so a revoke bites a script that is running RIGHT NOW
 * rather than at the next launch. Only meaningful for the OPEN workbook — a
 * closed workbook has nothing mounted, and its script ids must never be used to
 * revoke same-named ids in the workbook that IS open.
 */
async function stopLiveScriptGrants(
  workbookKey: string,
  grants: Array<{ scriptId: string; capabilities: CapabilityId[] }>,
): Promise<void> {
  if (grants.length === 0) return;
  const identity = await currentWorkbookTrustKey();
  if (!identity || identity.key !== workbookKey) return;
  try {
    const { revokeCapability } = await import("./scriptHost/capabilities");
    for (const g of grants) {
      for (const cap of g.capabilities) {
        await revokeCapability(g.scriptId, cap);
      }
    }
  } catch (e) {
    console.warn("[scriptSecurity] could not drop live script capability grants:", e);
  }
}

/** Revoke ONE persisted capability from ONE script. The live + Rust grants go
 *  too when that workbook is the open one. */
export async function revokeScriptCapability(
  workbookKey: string,
  scriptId: string,
  capability: CapabilityId,
): Promise<void> {
  const file = readTrustFile();
  const record = file.records.find((r) => r.workbookKey === workbookKey);
  const grant = record?.scriptGrants.find((g) => g.scriptId === scriptId);
  if (!record || !grant) return;
  grant.capabilities = grant.capabilities.filter((c) => c !== capability);
  if (capability === "net.fetch") grant.netOrigins = [];
  // A grant with nothing left in it is not a decision — remove the husk so the
  // Settings list shows the script gone rather than empty.
  if (grant.capabilities.length === 0) {
    record.scriptGrants = record.scriptGrants.filter((g) => g.scriptId !== scriptId);
  }
  writeTrustFile({ version: 1, records: prune(file.records) });
  await stopLiveScriptGrants(workbookKey, [{ scriptId, capabilities: [capability] }]);
}

/** Revoke EVERY persisted capability of one script. */
export async function revokeScriptCapabilityGrants(
  workbookKey: string,
  scriptId: string,
): Promise<void> {
  const file = readTrustFile();
  const record = file.records.find((r) => r.workbookKey === workbookKey);
  const grant = record?.scriptGrants.find((g) => g.scriptId === scriptId);
  if (!record || !grant) return;
  const capabilities = [...grant.capabilities];
  record.scriptGrants = record.scriptGrants.filter((g) => g.scriptId !== scriptId);
  writeTrustFile({ version: 1, records: prune(file.records) });
  await stopLiveScriptGrants(workbookKey, [{ scriptId, capabilities }]);
}

/**
 * Re-establish the OPEN workbook's persisted script grants without a mount —
 * used when a workbook's scripts are already mounted (e.g. the security level
 * was just relaxed) and by tests. Mount-time restore is the normal path
 * (`restoreAndSyncGrants` in scriptHost/capabilities.ts), because only the mount
 * knows each script's live source and ceiling. Returns how many scripts were
 * considered.
 */
export async function countPersistedScriptGrants(): Promise<number> {
  const identity = await currentWorkbookTrustKey();
  if (!identity) return 0;
  return getWorkbookTrustRecord(identity.key)?.scriptGrants.length ?? 0;
}

// ============================================================================
// The gate
// ============================================================================

/** How many lines of a changed script to show in the re-consent diff. */
const DIFF_PREVIEW_LINES = 12;

/** A compact, readable +/- diff of one script, capped so a confirm box stays
 *  usable. Line-level, not character-level — enough to answer "what changed?". */
export function formatSourceDiff(oldSource: string, newSource: string): string {
  const before = oldSource.split("\n");
  const after = newSource.split("\n");
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const removed = before.filter((l) => !afterSet.has(l) && l.trim().length > 0);
  const added = after.filter((l) => !beforeSet.has(l) && l.trim().length > 0);
  const lines: string[] = [];
  for (const l of removed.slice(0, DIFF_PREVIEW_LINES)) lines.push(`  - ${l.trim()}`);
  if (removed.length > DIFF_PREVIEW_LINES) {
    lines.push(`  - ... ${removed.length - DIFF_PREVIEW_LINES} more removed line(s)`);
  }
  for (const l of added.slice(0, DIFF_PREVIEW_LINES)) lines.push(`  + ${l.trim()}`);
  if (added.length > DIFF_PREVIEW_LINES) {
    lines.push(`  + ... ${added.length - DIFF_PREVIEW_LINES} more added line(s)`);
  }
  return lines.length > 0 ? lines.join("\n") : "  (whitespace-only change)";
}

/** The explanation shown when a workbook's trust has LAPSED — never a blind
 *  "approve again", always what changed. */
export function describeTrustLapse(evaluation: WorkbookTrustEvaluation): string {
  if (evaluation.status !== "lapsed") return "";
  const parts: string[] = [];
  if (evaluation.addedScripts.length > 0) {
    parts.push(
      `NEW CODE since you trusted this workbook:\n` +
        evaluation.addedScripts.map((s) => `  * ${s.id}`).join("\n"),
    );
  }
  for (const changed of evaluation.changedScripts) {
    parts.push(`CHANGED: ${changed.id}\n${formatSourceDiff(changed.oldSource, changed.newSource)}`);
  }
  if (evaluation.addedCapabilities.length > 0) {
    parts.push(
      `The code now asks for capabilities it did not declare before:\n` +
        evaluation.addedCapabilities.map((c) => `  * ${c}`).join("\n") +
        `\n(You still approve each capability separately when it is used.)`,
    );
  }
  return `This workbook was trusted, but its code changed — trust has lapsed.\n\n${parts.join("\n\n")}`;
}

/** Options for the gate. */
export interface EnsureScriptsAllowedOptions {
  /** Offer to persistently trust the workbook after the user approves. Default
   *  true. Pass false for surfaces where a trust offer would be confusing. */
  offerTrust?: boolean;
}

/**
 * Ensure user scripts may run, honoring the Script Security setting BEFORE
 * mounting/executing. Returns true if allowed.
 *  - "enabled" (or an already-granted "prompt"): true, no UI.
 *  - "disabled": false, no UI.
 *  - "prompt" + this workbook is TRUSTED and its code is unchanged: true, no UI
 *    (the session approval is granted silently so the Rust-side gate agrees).
 *  - "prompt" otherwise: ask; on approval, grant + offer to trust this workbook
 *    so the next launch is quiet. A LAPSED trust shows what changed first.
 *
 * @param promptMessage - shown when confirmation is needed.
 */
export async function ensureScriptsAllowed(
  promptMessage: string,
  options?: EnsureScriptsAllowedOptions,
): Promise<boolean> {
  const status = await getScriptExecutionStatus();
  if (status === "allowed") return true;
  if (status === "disabled") return false;

  const trust = await evaluateCurrentWorkbookTrust();
  if (trust && trust.evaluation.status === "trusted") {
    // The persistent decision stands in for this session's approval. It does NOT
    // grant any capability — every capability still goes through its own consent.
    await grantScriptSessionApproval();
    return true;
  }

  const lapse = trust ? describeTrustLapse(trust.evaluation) : "";
  const message =
    (lapse ? `${lapse}\n\n` : "") +
    `${promptMessage}\n\n` +
    `(Script Security is set to 'Ask'. Change it in Settings > Script Security.)`;
  if (!window.confirm(message)) return false;

  await grantScriptSessionApproval();

  if (options?.offerTrust !== false && trust) {
    const already = trust.evaluation.status === "lapsed";
    const trustPrompt =
      `Always run this workbook's own scripts without asking?\n\n` +
      `${trust.displayPath}\n\n` +
      `This is remembered on THIS COMPUTER ONLY — it is never stored in the file, ` +
      `so a copy sent to someone else is not trusted.\n` +
      `It covers only code authored in this workbook (never code from a .calp ` +
      `package), grants NO capabilities (network, BI, writeback are still asked ` +
      `for separately), lapses automatically if the code changes, and can be ` +
      `revoked any time in Settings > Script Security.` +
      (already ? `\n\nChoosing OK re-trusts the CHANGED code shown above.` : "");
    if (window.confirm(trustPrompt)) {
      await trustCurrentWorkbook();
    }
  }
  return true;
}

// ============================================================================
// Workbook-open wiring
// ============================================================================
//
// A new workbook means a new trust key: the cached evaluation must go, and the
// incoming workbook's persisted notebook grants must be re-mirrored into the
// backend's in-memory CapabilityStore before anything replays. Registered at
// module load (@api/cellTypes and @api/cellBehaviors establish this precedent)
// and guarded so repeated imports cannot double-subscribe.

let workbookHooksInstalled = false;

export function installWorkbookTrustHooks(): void {
  if (workbookHooksInstalled || typeof window === "undefined") return;
  workbookHooksInstalled = true;
  const onWorkbookChanged = () => {
    invalidateTrustCache();
    void rehydrateNotebookCapabilityGrants();
  };
  onAppEvent(AppEvents.AFTER_OPEN, onWorkbookChanged);
  onAppEvent(AppEvents.AFTER_NEW, invalidateTrustCache);
  // Saving under a new name changes the workbook's identity.
  onAppEvent(AppEvents.AFTER_SAVE, invalidateTrustCache);
}

installWorkbookTrustHooks();
