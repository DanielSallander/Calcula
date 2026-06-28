import { describe, it, expect, beforeEach } from "vitest";
import {
  CONSENT_STORAGE_KEY,
  loadConsents,
  persistConsents,
  recordConsent,
  isConsentCurrent,
} from "../extensionConsentStore";

describe("extensionConsentStore (B3)", () => {
  beforeEach(() => localStorage.clear());

  it("records and reads back consent by id + hash", () => {
    recordConsent("ext.a", "hash1");
    expect(isConsentCurrent(loadConsents(), "ext.a", "hash1")).toBe(true);
  });

  it("isConsentCurrent is false for a missing id OR a changed hash (re-prompt)", () => {
    recordConsent("ext.a", "hash1");
    const consents = loadConsents();
    expect(isConsentCurrent(consents, "ext.a", "hash2")).toBe(false); // code/signature changed
    expect(isConsentCurrent(consents, "ext.b", "hash1")).toBe(false); // never consented
  });

  it("tolerates missing / corrupt / array payloads (empty map)", () => {
    expect(loadConsents().size).toBe(0);
    localStorage.setItem(CONSENT_STORAGE_KEY, "not json");
    expect(loadConsents().size).toBe(0);
    localStorage.setItem(CONSENT_STORAGE_KEY, "[1,2,3]");
    expect(loadConsents().size).toBe(0);
  });

  it("persists across reload", () => {
    persistConsents(new Map([["ext.x", "h"]]));
    expect(isConsentCurrent(loadConsents(), "ext.x", "h")).toBe(true);
  });
});
