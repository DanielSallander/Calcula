//! FILENAME: app/extensions/ScriptableObjects/lib/consentStore.ts
// PURPOSE: Durable consent storage for distributed (.calp) scripts.
// CONTEXT: Consents persist inside the workbook (.cala virtual filesystem) so
// the user is not re-prompted on every open. Consent is keyed per package AND
// per script source hash: if an upstream refresh changes a script's source,
// the package re-prompts — silent code swaps must never inherit consent.

import { readVirtualFile, createVirtualFile } from "@api/backend";
import { parseDeclaredCapabilities } from "@api";
import type { CapabilityId } from "@api";

const CONSENT_FILE = ".calcula/script-consent.json";

export interface ConsentedScript {
  id: string;
  sourceHash: string;
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
  /** Capabilities the user consented for this package. Missing on records
   *  written before 4.2a — treated as []. */
  grantedCapabilities: CapabilityGrant[];
  grantedAt: string;
}

interface ConsentFile {
  version: 1;
  consents: ConsentRecord[];
}

/** SHA-256 of a script source, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Load persisted consents from the workbook. Returns [] when none exist.
 *  Records written before 4.2a lack grantedCapabilities — backfill as []. */
export async function loadConsents(): Promise<ConsentRecord[]> {
  try {
    const content = await readVirtualFile(CONSENT_FILE);
    const parsed = JSON.parse(content) as ConsentFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.consents)) {
      return parsed.consents.map((c) => ({
        ...c,
        grantedCapabilities: Array.isArray(c.grantedCapabilities)
          ? c.grantedCapabilities
          : [],
      }));
    }
  } catch {
    // Missing file or unparseable content — treat as no consents.
  }
  return [];
}

/**
 * The deduped, sorted set of capability ids declared across a package's
 * scripts (the union of every script's `// @capability` pragmas). Used to
 * compare currently-declared caps against what was consented, so a capability
 * EXPANSION re-prompts exactly like a source change does. Origins are not part
 * of this comparison: a source change that adds an origin already changes the
 * source hash and re-prompts.
 */
function declaredCapKey(sources: string[]): string {
  const caps = new Set<CapabilityId>();
  for (const source of sources) {
    for (const cap of parseDeclaredCapabilities(source).caps) caps.add(cap);
  }
  return [...caps].sort().join(",");
}

/** The deduped, sorted capability-id set of a stored consent record. */
function consentedCapKey(record: ConsentRecord): string {
  const caps = new Set<CapabilityId>();
  for (const grant of record.grantedCapabilities ?? []) caps.add(grant.capability);
  return [...caps].sort().join(",");
}

/**
 * Record consent for a package's current scripts (replacing any prior record
 * for the same package). Persists into the workbook's virtual filesystem —
 * durable once the workbook is saved.
 */
export async function recordConsent(
  packageName: string,
  scripts: Array<{ id: string; source: string }>,
  grantedCapabilities: CapabilityGrant[],
): Promise<void> {
  const hashed: ConsentedScript[] = [];
  for (const script of scripts) {
    hashed.push({ id: script.id, sourceHash: await sha256Hex(script.source) });
  }

  const consents = await loadConsents();
  const remaining = consents.filter((c) => c.packageName !== packageName);
  remaining.push({
    packageName,
    scripts: hashed,
    grantedCapabilities,
    grantedAt: new Date().toISOString(),
  });

  const file: ConsentFile = { version: 1, consents: remaining };
  await createVirtualFile(CONSENT_FILE, JSON.stringify(file, null, 2));
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

  for (const script of scripts) {
    const consented = record.scripts.find((s) => s.id === script.id);
    if (!consented) return false;
    const hash = await sha256Hex(script.source);
    if (hash !== consented.sourceHash) return false;
  }

  // Capability expansion re-prompts: the currently-declared capability set must
  // equal the consented set. (Source changes are already caught by the hash
  // check above; this catches the case where the consented record predates a
  // pragma's recognition or carries a narrower grant than is now declared.)
  if (declaredCapKey(scripts.map((s) => s.source)) !== consentedCapKey(record)) {
    return false;
  }

  return true;
}
