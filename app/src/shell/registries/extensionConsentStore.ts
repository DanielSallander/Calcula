//! FILENAME: app/src/shell/registries/extensionConsentStore.ts
// PURPOSE: Persist first-use (TOFU) consent for third-party extensions (B3).
// CONTEXT: A disk-scanned distributed extension must NOT auto-activate without
//   the user's explicit consent — the VBA failure mode the project was founded
//   to fix. Consent is keyed by extension id + a content/trust hash, so a code
//   swap, a capability change, OR a signature-status change re-prompts.
//   localStorage so it survives restarts. Tiny standalone module — trivially
//   unit-testable (mirrors extensionDisabledStore).

import { sha256Hex } from "../../api/distributedConsent";

/** localStorage key holding the consent map { [extId]: hash }. */
export const CONSENT_STORAGE_KEY = "calcula.extensions.consent";

/** Persisted consent: extension id -> the content/trust hash consented to. */
export type ConsentMap = Map<string, string>;

/** The consent hash for a bundle: changes when its code OR signature/trust
 *  status changes, forcing a re-prompt. */
export async function extensionConsentHash(content: string, trustStatus?: string): Promise<string> {
  return sha256Hex(`${trustStatus ?? "unsigned"}\n${content}`);
}

/** Read the persisted consent map. Tolerates a missing key / corrupt JSON. */
export function loadConsents(): ConsentMap {
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return new Map();
    const map: ConsentMap = new Map();
    for (const [id, hash] of Object.entries(obj)) {
      if (typeof id === "string" && typeof hash === "string") map.set(id, hash);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Persist the consent map as a JSON object. Never throws. */
export function persistConsents(consents: ConsentMap): void {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(Object.fromEntries(consents)));
  } catch (e) {
    console.warn("[ExtensionManager] Failed to persist extension consents:", e);
  }
}

/** Record consent for an extension at a specific hash (overwrites a prior one). */
export function recordConsent(id: string, hash: string): void {
  const consents = loadConsents();
  consents.set(id, hash);
  persistConsents(consents);
}

/** True only when the extension's CURRENT hash has been consented to. */
export function isConsentCurrent(consents: ConsentMap, id: string, hash: string): boolean {
  return consents.get(id) === hash;
}
