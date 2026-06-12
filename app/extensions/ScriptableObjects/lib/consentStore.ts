//! FILENAME: app/extensions/ScriptableObjects/lib/consentStore.ts
// PURPOSE: Durable consent storage for distributed (.calp) scripts.
// CONTEXT: Consents persist inside the workbook (.cala virtual filesystem) so
// the user is not re-prompted on every open. Consent is keyed per package AND
// per script source hash: if an upstream refresh changes a script's source,
// the package re-prompts — silent code swaps must never inherit consent.

import { readVirtualFile, createVirtualFile } from "@api/backend";

const CONSENT_FILE = ".calcula/script-consent.json";

export interface ConsentedScript {
  id: string;
  sourceHash: string;
}

export interface ConsentRecord {
  packageName: string;
  scripts: ConsentedScript[];
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

/** Load persisted consents from the workbook. Returns [] when none exist. */
export async function loadConsents(): Promise<ConsentRecord[]> {
  try {
    const content = await readVirtualFile(CONSENT_FILE);
    const parsed = JSON.parse(content) as ConsentFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.consents)) {
      return parsed.consents;
    }
  } catch {
    // Missing file or unparseable content — treat as no consents.
  }
  return [];
}

/**
 * Record consent for a package's current scripts (replacing any prior record
 * for the same package). Persists into the workbook's virtual filesystem —
 * durable once the workbook is saved.
 */
export async function recordConsent(
  packageName: string,
  scripts: Array<{ id: string; source: string }>,
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
    grantedAt: new Date().toISOString(),
  });

  const file: ConsentFile = { version: 1, consents: remaining };
  await createVirtualFile(CONSENT_FILE, JSON.stringify(file, null, 2));
}

/**
 * Check whether a package's scripts are covered by a persisted consent:
 * the package must have a record and EVERY current script's source hash must
 * match the hash consented to. A changed or added script re-prompts.
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
  return true;
}
