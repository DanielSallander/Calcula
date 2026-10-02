//! FILENAME: app/src/api/distributedConsent.ts
// PURPOSE: Durable consent storage for distributed (.calp) scripts AND reserved
//          libraries (object scripts, chart-transform / chart-mark libraries).
// CONTEXT: Approvals are kept in the workbook (`.calcula/script-consent.json`)
//          so the user is not re-prompted on every open -- but each one is
//          SEALED TO THIS COMPUTER. Rust writes and verifies them
//          (app/src-tauri/src/consent_seal.rs): `record_script_consent` computes
//          every source hash itself and seals the record with a key that exists
//          only on this computer, and `list_script_consents` returns only the
//          records this computer sealed and that still match. So an approval
//          counts only on the computer that sealed it, and only for the exact
//          bytes under that application name: a copy of the workbook opened
//          anywhere else asks again, once, and a file built elsewhere cannot
//          carry an approval that counts here. What the seal does NOT stop:
//          records this computer sealed can be copied between workbooks (a
//          workbook sent away, edited, and sent back keeps them; records lifted
//          from one this computer saved count in another) -- re-using the
//          user's own earlier approval of those exact bytes, never forging a
//          new one (consent_seal.rs, "WHAT IT DOES NOT DO").
//          This module never reads or writes the file itself, and the page
//          cannot: create/rename refuse its key.
//
//          Consent is keyed per package AND per script source hash: if an
//          upstream refresh changes a script's source, the package re-prompts —
//          silent code swaps must never inherit consent. Promoted from the
//          ScriptableObjects extension to @api so EVERY distributed-code surface
//          (object scripts via ScriptableObjects, the sandboxed
//          chart-transform/chart-mark libraries via Charts) reuses ONE consent
//          store rather than each inventing a parallel one.
//
//          The wire types below mirror consent_seal.rs field for field; the
//          shared fixture app/src/api/__tests__/fixtures/consentSealWire.json is
//          read by BOTH sides' tests.

import { invokeBackend } from "./backend";
import { parseDeclaredCapabilities } from "./scriptHost/capabilities";
import type { CapabilityId } from "./scriptHost/capabilityIds";

export interface ConsentedScript {
  id: string;
  sourceHash: string;
  /** The source the user actually approved, retained so a later re-consent can
   *  DIFF old→new (review the change, not a blind re-approval). Optional for
   *  records written before this was added. */
  source?: string;
}

/** A consented capability for a package (Phase 4.2a). Origins only apply to
 *  net.fetch; absent/empty for every other capability. */
export interface CapabilityGrant {
  capability: CapabilityId;
  origins?: string[];
}

export interface ConsentRecord {
  packageName: string;
  scripts: ConsentedScript[];
  /** Capabilities the user consented for this package. */
  grantedCapabilities: CapabilityGrant[];
  grantedAt: string;
}

/**
 * Why a record in the workbook counts for nothing on this computer (Rust
 * `IgnoredReason`): no seal or a pre-seal file; sealed on another computer;
 * sealed here but changed since; or this computer's key cannot be read.
 */
export type ConsentIgnoredReason = "unsealed" | "otherComputer" | "altered" | "keyUnavailable";

/** A record the workbook carries that does not count here (Rust `IgnoredConsent`). */
export interface IgnoredConsent {
  packageName: string;
  reason: ConsentIgnoredReason;
}

/** `list_script_consents`' answer (Rust `ScriptConsentList`). */
export interface ConsentReport {
  consents: ConsentRecord[];
  ignored: IgnoredConsent[];
}

/**
 * `record_script_consent`'s request (Rust `RecordScriptConsentRequest`). What
 * the approval screen showed, and nothing else: no hash, no timestamp, no seal
 * -- Rust computes and refuses those (the request type denies unknown fields).
 */
export interface RecordScriptConsentRequest {
  packageName: string;
  scripts: Array<{ id: string; source: string }>;
  grantedCapabilities: CapabilityGrant[];
}

/** SHA-256 of a script source, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The approvals that count on THIS computer, plus every record the workbook
 * carries that does not, and why. Rejects when Rust cannot answer, so a caller
 * that wants to SAY why nothing is approved can.
 */
export async function loadConsentReport(): Promise<ConsentReport> {
  const report = await invokeBackend<ConsentReport>("list_script_consents");
  return {
    consents: Array.isArray(report?.consents) ? report.consents : [],
    ignored: Array.isArray(report?.ignored) ? report.ignored : [],
  };
}

/**
 * The approvals that count on this computer. [] when there are none -- and
 * when the backend cannot list them, which fails CLOSED: nothing counts as
 * approved, so the screen asks again rather than something running unasked.
 */
export async function loadConsents(): Promise<ConsentRecord[]> {
  try {
    return (await loadConsentReport()).consents;
  } catch (e) {
    console.warn("[distributedConsent] Could not list approvals:", e);
    return [];
  }
}

/**
 * The deduped, SORTED union of capability ids declared across a set of script
 * sources (every script's `// @capability` pragmas). Exported because the
 * per-workbook trust store (@api/scriptSecurity) compares the same way: a
 * capability EXPANSION must re-prompt exactly like a source change does, and
 * two independent implementations of "what does this code declare?" would drift.
 * Origins are deliberately not part of this set: a source change that adds an
 * origin already changes the source hash and re-prompts.
 */
export function declaredCapabilitySet(sources: string[]): CapabilityId[] {
  const caps = new Set<CapabilityId>();
  for (const source of sources) {
    for (const cap of parseDeclaredCapabilities(source).caps) caps.add(cap);
  }
  return [...caps].sort();
}

function declaredCapKey(sources: string[]): string {
  return declaredCapabilitySet(sources).join(",");
}

/** The deduped, sorted capability-id set of a stored consent record. */
function consentedCapKey(record: ConsentRecord): string {
  const caps = new Set<CapabilityId>();
  for (const grant of record.grantedCapabilities ?? []) caps.add(grant.capability);
  return [...caps].sort().join(",");
}

// SERIALIZE every recordConsent. Rust already makes each record one
// read-modify-write under one lock, so two grants can no longer lose each other;
// the queue keeps them reaching Rust in CALL order, so a later approval of the
// same application always replaces an earlier one and never the reverse.
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * The request, spelled out field by field: a caller's array may carry more
 * than `{ id, source }` (a name, a kind, a hash of its own), and none of that
 * leaves the page. Rust would refuse it anyway (unknown fields are denied).
 */
export function recordScriptConsentRequest(
  packageName: string,
  scripts: Array<{ id: string; source: string }>,
  grantedCapabilities: CapabilityGrant[],
): RecordScriptConsentRequest {
  return {
    packageName,
    scripts: scripts.map((s) => ({ id: s.id, source: s.source })),
    grantedCapabilities: grantedCapabilities.map((g) =>
      g.origins === undefined
        ? { capability: g.capability }
        : { capability: g.capability, origins: [...g.origins] },
    ),
  };
}

async function recordConsentSerial(
  packageName: string,
  scripts: Array<{ id: string; source: string }>,
  grantedCapabilities: CapabilityGrant[],
): Promise<void> {
  await invokeBackend<void>("record_script_consent", {
    request: recordScriptConsentRequest(packageName, scripts, grantedCapabilities),
  });
}

/**
 * Record consent for a package's current scripts (replacing THIS computer's
 * prior record for the same package), sealed to this computer by Rust. Durable
 * once the workbook is saved; counts only on this computer.
 *
 * REJECTS when Rust refuses -- an empty list, a duplicate id, or this
 * computer's approvals key cannot be read or created. A caller must SAY that
 * nothing was approved; swallowing it and carrying on as if approved is the
 * lie this contract exists to prevent.
 */
export function recordConsent(
  packageName: string,
  scripts: Array<{ id: string; source: string }>,
  grantedCapabilities: CapabilityGrant[],
): Promise<void> {
  const run = () => recordConsentSerial(packageName, scripts, grantedCapabilities);
  const next = writeQueue.then(run, run);
  writeQueue = next.catch(() => undefined);
  return next;
}

/**
 * Whether the package's record lists EVERY one of `scripts` under its own id
 * with its CURRENT source hash — the id+hash question and nothing else.
 *
 * This is exactly what Rust asks (`consent_granted_in`,
 * app/src-tauri/src/calp_commands.rs) before it will run a distributed artifact,
 * so a TypeScript surface that wants to know "will the backend accept this?"
 * should ask THIS, not {@link isConsentCurrent}.
 *
 * Split out because one package record now covers artifacts of two kinds whose
 * CAPABILITY accounting differs. A package's object scripts drive
 * `grantedCapabilities` — the union the consent prompt showed and the
 * re-prompt-on-expansion key. Its MODULE scripts (macros) do not: nothing grants
 * a macro capabilities out of this record (both macro run routes derive their
 * ceiling from the macro's own source at run time, and Rust reads
 * `grantedCapabilities` nowhere), so folding a macro's pragmas into that union
 * would put a capability the user was never shown into the application's grant
 * AND make `isConsentCurrent` unsatisfiable — a package re-prompting on every
 * open, forever. Macros are therefore held to the hash question only, which is
 * the whole question the backend asks about them.
 */
export async function areScriptsConsented(
  consents: ConsentRecord[],
  packageName: string,
  scripts: Array<{ id: string; source: string }>,
): Promise<boolean> {
  const record = consents.find((c) => c.packageName === packageName);
  if (!record) return false;

  for (const script of scripts) {
    const consented = record.scripts.find((s) => s.id === script.id);
    if (!consented) return false;
    const hash = await sha256Hex(script.source);
    if (hash !== consented.sourceHash) return false;
  }
  return true;
}

/**
 * Check whether a package's scripts are covered by a persisted consent:
 * the package must have a record, EVERY current script's source hash must
 * match the hash consented to, AND the set of capabilities currently DECLARED
 * by the package's scripts must match what was consented. A changed/added
 * script OR a capability expansion (a script now declaring a capability that
 * wasn't consented) re-prompts.
 */
export async function isConsentCurrent(
  consents: ConsentRecord[],
  packageName: string,
  scripts: Array<{ id: string; source: string }>,
): Promise<boolean> {
  const record = consents.find((c) => c.packageName === packageName);
  if (!record) return false;

  if (!(await areScriptsConsented(consents, packageName, scripts))) return false;

  // Capability expansion re-prompts: the currently-declared capability set must
  // equal the consented set. (Source changes are already caught by the hash
  // check above; this catches the case where the consented record predates a
  // pragma's recognition or carries a narrower grant than is now declared.)
  if (declaredCapKey(scripts.map((s) => s.source)) !== consentedCapKey(record)) {
    return false;
  }

  return true;
}

/** A script whose source changed since it was last consented (T3). */
export interface ChangedScript {
  id: string;
  oldSource: string;
  newSource: string;
}

/**
 * The scripts whose source CHANGED between a previously-approved set and the
 * current one — each with the previously-approved source and the new one — so a
 * re-consent UI can show a DIFF instead of asking for a blind re-approval. Only
 * scripts that (a) appear in `prior`, (b) whose source actually differs, and
 * (c) whose old source was retained are returned.
 *
 * Exported as a standalone helper (rather than living inside getChangedScripts)
 * because per-workbook run-trust (@api/scriptSecurity) needs the SAME diff over
 * a differently-stored record. One implementation, two callers.
 */
export async function diffScriptSets(
  prior: ConsentedScript[],
  current: Array<{ id: string; source: string }>,
): Promise<ChangedScript[]> {
  const changed: ChangedScript[] = [];
  for (const script of current) {
    const before = prior.find((s) => s.id === script.id);
    if (!before || before.source === undefined) continue;
    const hash = await sha256Hex(script.source);
    if (hash !== before.sourceHash) {
      changed.push({ id: script.id, oldSource: before.source, newSource: script.source });
    }
  }
  return changed;
}

/**
 * For a re-consent prompt: the scripts whose source CHANGED since the user last
 * approved this package.
 */
export async function getChangedScripts(
  consents: ConsentRecord[],
  packageName: string,
  scripts: Array<{ id: string; source: string }>,
): Promise<ChangedScript[]> {
  const record = consents.find((c) => c.packageName === packageName);
  if (!record) return [];
  return diffScriptSets(record.scripts, scripts);
}
