//! FILENAME: app/extensions/ScriptableObjects/lib/__tests__/consentStore.test.ts
// PURPOSE: Phase 4.4 CONSENT-FLOW — unit coverage for the pragma-tamper /
//          capability-expansion re-prompt guard in isConsentCurrent.
// CONTEXT: A distributed (.calp) package's consent is keyed per script SOURCE
//          HASH and per the DECLARED capability set. A silent code swap (changed
//          source) OR a capability expansion (a new `// @capability` pragma) must
//          re-prompt — never inherit a prior grant. isConsentCurrent is pure: it
//          takes the ConsentRecord[] as an argument, so these tests construct
//          records directly (no backend / .cala read needed).
//
//          sourceHash is computed with the SAME sha256Hex helper consentStore
//          itself uses (imported below), so the stored hashes line up exactly
//          with what isConsentCurrent recomputes from the live source. This
//          keeps the test deterministic regardless of the digest's exact bytes.

import { describe, it, expect } from "vitest";
import {
  isConsentCurrent,
  getChangedScripts,
  sha256Hex,
} from "../consentStore";
import type { ConsentRecord } from "../consentStore";

// ---------------------------------------------------------------------------
// Fixtures — synthetic distributed scripts for one package.
// ---------------------------------------------------------------------------

const PKG = "test-consent-pkg";

// A script declaring exactly one capability (storage).
const SCRIPT_A_ID = "script-a";
const SCRIPT_A_SRC =
  "// @capability storage\n" +
  "function setup(shape){ shape.expose('rt', async function(){ return await shape.caps.storage.get('k'); }); }";

// The SAME script after an upstream code swap — different source bytes, but the
// SAME declared capability set (still just `storage`). This isolates the
// source-hash guard from the capability-set guard.
const SCRIPT_A_SRC_TAMPERED =
  "// @capability storage\n" +
  "function setup(shape){ shape.expose('rt', async function(){ /* swapped */ return 'pwned'; }); }";

// The same script with an ADDED `// @capability` pragma (net.fetch) — the
// pragma-tamper case: a script silently asking for MORE than was consented.
const SCRIPT_A_SRC_CAP_EXPANDED =
  "// @capability storage\n" +
  "// @capability net.fetch\n" +
  "function setup(shape){ shape.expose('rt', async function(){ return await shape.caps.storage.get('k'); }); }";

/**
 * Build a ConsentRecord for the given scripts, hashing their sources with the
 * exact helper consentStore uses (so isConsentCurrent's recomputed hashes match)
 * and granting the supplied capability set.
 */
async function makeRecord(
  packageName: string,
  scripts: Array<{ id: string; source: string }>,
  grantedCaps: ConsentRecord["grantedCapabilities"],
): Promise<ConsentRecord> {
  const hashed = [];
  for (const s of scripts) {
    hashed.push({ id: s.id, sourceHash: await sha256Hex(s.source) });
  }
  return {
    packageName,
    scripts: hashed,
    grantedCapabilities: grantedCaps,
    grantedAt: new Date("2026-06-14T00:00:00.000Z").toISOString(),
  };
}

describe("consentStore.isConsentCurrent — pragma-tamper / cap-expansion guard", () => {
  it("returns TRUE when source hashes and declared caps both match (no re-prompt)", async () => {
    const scripts = [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC }];
    const record = await makeRecord(PKG, scripts, [{ capability: "storage" }]);

    const current = await isConsentCurrent([record], PKG, scripts);

    expect(current).toBe(true);
  });

  it("returns FALSE when a script's SOURCE changed (silent code swap re-prompts)", async () => {
    // Consent was recorded for the original source...
    const consentedScripts = [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC }];
    const record = await makeRecord(PKG, consentedScripts, [
      { capability: "storage" },
    ]);

    // ...but the live package now ships a tampered body (same id, same declared
    // cap set, different source hash).
    const liveScripts = [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC_TAMPERED }];

    const current = await isConsentCurrent([record], PKG, liveScripts);

    expect(current).toBe(false);
  });

  it("returns FALSE when a script ADDS a declared capability (pragma-tamper expansion re-prompts)", async () => {
    // Consent covered only `storage`...
    const consentedScripts = [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC }];
    const record = await makeRecord(PKG, consentedScripts, [
      { capability: "storage" },
    ]);

    // ...but the live source now also declares `// @capability net.fetch`.
    // Even though the hash check alone would already catch this, the declared-
    // cap-key comparison is the guard that makes a capability EXPANSION
    // re-prompt independently — so assert it from both angles below.
    const liveScripts = [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC_CAP_EXPANDED }];

    const current = await isConsentCurrent([record], PKG, liveScripts);

    expect(current).toBe(false);
  });

  it("returns FALSE on a capability MISMATCH even when source hashes line up", async () => {
    // Pin the capability-set guard in isolation: the stored record's source
    // hashes match the live source EXACTLY (same source string), but the
    // grantedCapabilities set is narrower than what the source now declares
    // (source declares `storage`, record granted nothing). A record that
    // predates a pragma's recognition, or carries a narrower grant, re-prompts.
    const scripts = [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC }];
    const recordWithNoCaps = await makeRecord(PKG, scripts, []); // granted: none

    const current = await isConsentCurrent([recordWithNoCaps], PKG, scripts);

    expect(current).toBe(false);
  });

  it("returns FALSE for an unknown package (no record => prompt)", async () => {
    const scripts = [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC }];
    const record = await makeRecord(PKG, scripts, [{ capability: "storage" }]);

    // Query a DIFFERENT package name than the one the record covers.
    const current = await isConsentCurrent(
      [record],
      "some-other-package",
      scripts,
    );

    expect(current).toBe(false);
  });

  it("returns FALSE when a NEW script id appears in the package (added script re-prompts)", async () => {
    // Consent recorded for script A only.
    const consentedScripts = [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC }];
    const record = await makeRecord(PKG, consentedScripts, [
      { capability: "storage" },
    ]);

    // The live package now also contains a second, never-consented script.
    const liveScripts = [
      { id: SCRIPT_A_ID, source: SCRIPT_A_SRC },
      { id: "script-b", source: "// @capability storage\nfunction setup(){}" },
    ];

    const current = await isConsentCurrent([record], PKG, liveScripts);

    expect(current).toBe(false);
  });

  it("matches the declared-cap union across MULTIPLE scripts (no re-prompt when the union is unchanged)", async () => {
    // Two scripts whose declared caps union to {storage, net.fetch}; the record
    // grants exactly that union. Order of grants in the record must not matter.
    const scripts = [
      { id: SCRIPT_A_ID, source: SCRIPT_A_SRC }, // storage
      {
        id: "script-net",
        source:
          "// @capability net.fetch https://api.example.com\nfunction setup(){}",
      }, // net.fetch
    ];
    const record = await makeRecord(PKG, scripts, [
      { capability: "net.fetch", origins: ["https://api.example.com"] },
      { capability: "storage" },
    ]);

    const current = await isConsentCurrent([record], PKG, scripts);

    expect(current).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getChangedScripts — the re-consent diff source (T3)
// ---------------------------------------------------------------------------

/** Like makeRecord, but RETAINS each script's source (so a diff is possible). */
async function recordWithSource(
  packageName: string,
  scripts: Array<{ id: string; source: string }>,
  grantedCaps: ConsentRecord["grantedCapabilities"],
): Promise<ConsentRecord> {
  const hashed = [];
  for (const s of scripts) {
    hashed.push({ id: s.id, sourceHash: await sha256Hex(s.source), source: s.source });
  }
  return {
    packageName,
    scripts: hashed,
    grantedCapabilities: grantedCaps,
    grantedAt: new Date("2026-06-14T00:00:00.000Z").toISOString(),
  };
}

describe("consentStore.getChangedScripts", () => {
  it("returns the changed script with old + new source", async () => {
    const rec = await recordWithSource(PKG, [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC }], []);
    const changed = await getChangedScripts([rec], PKG, [
      { id: SCRIPT_A_ID, source: SCRIPT_A_SRC_TAMPERED },
    ]);
    expect(changed).toEqual([
      { id: SCRIPT_A_ID, oldSource: SCRIPT_A_SRC, newSource: SCRIPT_A_SRC_TAMPERED },
    ]);
  });

  it("returns [] when the source is unchanged", async () => {
    const rec = await recordWithSource(PKG, [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC }], []);
    expect(
      await getChangedScripts([rec], PKG, [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC }]),
    ).toEqual([]);
  });

  it("skips scripts whose old source was NOT retained (pre-T3 records can't diff)", async () => {
    // makeRecord stores {id, sourceHash} with NO source.
    const rec = await makeRecord(PKG, [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC }], []);
    expect(
      await getChangedScripts([rec], PKG, [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC_TAMPERED }]),
    ).toEqual([]);
  });

  it("returns [] for an unknown package or a brand-new script id", async () => {
    const rec = await recordWithSource(PKG, [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC }], []);
    expect(
      await getChangedScripts([rec], "other-pkg", [{ id: SCRIPT_A_ID, source: SCRIPT_A_SRC_TAMPERED }]),
    ).toEqual([]);
    expect(
      await getChangedScripts([rec], PKG, [{ id: "brand-new", source: "x" }]),
    ).toEqual([]);
  });
});
