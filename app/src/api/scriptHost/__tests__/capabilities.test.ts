// Unit tests for the capability grant store + pragma parser (Phase 4).
// The broker ENFORCES against handle.grants, which is a live reference to
// getGrantSet(scriptId) — so these tests pin the security-critical behavior that
// a grant/revoke mutates that exact live set (a stale snapshot would let a
// revoked script keep a capability, or a granted one never gain it).

import { describe, it, expect, beforeEach, vi } from "vitest";

// The grant store mirrors net.fetch origins to Rust via invokeBackend; mock it
// so the backend-calling paths resolve in jsdom (no Tauri here).
vi.mock("../../backend", () => ({ invokeBackend: vi.fn().mockResolvedValue(undefined) }));

import {
  parseDeclaredCapabilities,
  fetchOriginOf,
  getGrantSet,
  getScriptGrants,
  getGrantedOrigins,
  recordCapabilityGrant,
  recordCapabilityGrantAtInstall,
  recordCapabilityGrantUnlessRevoked,
  wasRevokedThisSession,
  revokeCapability,
  revokeScriptGrants,
  resetAllGrants,
  describeCapability,
} from "../capabilities";
import { buildHandleFromDefinition, brokerCall } from "../broker";
import { ALL_CAPABILITY_IDS } from "../capabilityIds";

beforeEach(() => {
  resetAllGrants();
});

describe("describeCapability (C7 transparency UI label source)", () => {
  it("gives every known capability a non-empty, non-id human description", () => {
    for (const id of ALL_CAPABILITY_IDS) {
      const desc = describeCapability(id);
      expect(desc.length, id).toBeGreaterThan(0);
      // The description should be prose, not just the raw id echoed back.
      expect(desc, id).not.toBe(id);
    }
  });

  it("falls back to the id for an unknown capability", () => {
    expect(describeCapability("filesystem" as never)).toBe("filesystem");
  });

  // --------------------------------------------------------------------------
  // Two descriptions that pointed at the wrong risk
  // --------------------------------------------------------------------------

  it("`storage` names the WORKBOOK, because that is where the data goes", () => {
    // The store is `.calcula/script-data/<scriptId>.json` in the .cala virtual
    // filesystem (host.ts scriptStoragePath). "store data on this device" was
    // wrong in the direction that misleads: a user who approves that and then
    // mails the file has shared whatever the script kept. The consequence — it
    // TRAVELS — is the whole point of the sentence.
    const text = describeCapability("storage");
    expect(text).toMatch(/workbook/i);
    expect(text, "the consequence of living in the file must be stated").toMatch(
      /travels with the file|share/i,
    );
    expect(text.toLowerCase(), "the store is not on the device, it is in the file").not.toContain(
      "on this device",
    );
  });

  it("`formula.udf` describes BEING a formula, not reading the sheet through one", () => {
    // "evaluate worksheet formulas" reads as "it gets to run formulas against
    // your data". The reverse is what is being asked for, and the consequence a
    // user needs is that its code then runs on every recalculation.
    const text = describeCapability("formula.udf");
    expect(text).toMatch(/your cells can call|formula functions/i);
    expect(text, "the recalculation consequence must be stated").toMatch(/recalculat/i);
    expect(text.toLowerCase()).not.toContain("evaluate worksheet formulas");
  });
});

describe("parseDeclaredCapabilities", () => {
  it("collects declared caps and net.fetch origins from pragmas", () => {
    const src = [
      "// @capability net.fetch https://api.example.com/path",
      "  // @capability storage",
      "// @capability bi.query",
      "function setup(ctx) {}",
    ].join("\n");
    const d = parseDeclaredCapabilities(src);
    expect(new Set(d.caps)).toEqual(new Set(["net.fetch", "storage", "bi.query"]));
    expect(d.origins).toEqual(["https://api.example.com"]); // normalized to origin
  });

  it("ignores unknown capability ids and non-pragma text", () => {
    const d = parseDeclaredCapabilities("// @capability filesystem\n// not a pragma net.fetch");
    expect(d.caps).toEqual([]);
    expect(d.origins).toEqual([]);
  });

  it("dedupes and drops malformed / non-https origins", () => {
    const d = parseDeclaredCapabilities(
      "// @capability net.fetch https://a.com\n// @capability net.fetch http://b.com\n// @capability net.fetch https://a.com",
    );
    expect(d.caps).toEqual(["net.fetch"]);
    expect(d.origins).toEqual(["https://a.com"]); // http dropped, dupe collapsed
  });
});

describe("fetchOriginOf", () => {
  it("normalizes https URLs to scheme://host[:port], dropping the default port", () => {
    expect(fetchOriginOf("https://Example.com/a/b?q=1")).toBe("https://example.com");
    expect(fetchOriginOf("https://example.com:8443/x")).toBe("https://example.com:8443");
    expect(fetchOriginOf("https://example.com:443/x")).toBe("https://example.com");
  });

  it("rejects non-https, userinfo, and non-strings", () => {
    expect(fetchOriginOf("http://example.com")).toBeNull();
    expect(fetchOriginOf("https://user:pass@example.com")).toBeNull();
    expect(fetchOriginOf("not a url")).toBeNull();
    expect(fetchOriginOf(42)).toBeNull();
  });
});

describe("grant store", () => {
  it("records a grant into the live set returned by getGrantSet", () => {
    const live = getGrantSet("s1");
    expect(live.has("net.fetch")).toBe(false);
    recordCapabilityGrant("s1", "net.fetch", "https://api.example.com");
    // The SAME set object the broker would hold now reflects the grant.
    expect(live.has("net.fetch")).toBe(true);
    expect(getScriptGrants("s1")).toEqual({
      caps: ["net.fetch"],
      origins: ["https://api.example.com"],
    });
    expect(getGrantedOrigins("s1")).toEqual(["https://api.example.com"]);
  });

  it("revokeCapability mutates the live set in place (broker sees the revoke)", async () => {
    const live = getGrantSet("s2"); // what buildHandleFromDefinition put on handle.grants
    recordCapabilityGrant("s2", "storage");
    recordCapabilityGrant("s2", "net.fetch", "https://api.example.com");
    expect(live.has("net.fetch")).toBe(true);

    await revokeCapability("s2", "net.fetch");

    // Same set object — net.fetch gone, storage kept, origins cleared.
    expect(live.has("net.fetch")).toBe(false);
    expect(live.has("storage")).toBe(true);
    expect(getGrantedOrigins("s2")).toEqual([]);
  });

  it("revoking one cap leaves others (e.g. local ui.html) intact", async () => {
    recordCapabilityGrant("s3", "ui.html");
    recordCapabilityGrant("s3", "net.fetch", "https://x.com");
    await revokeCapability("s3", "net.fetch");
    expect(getScriptGrants("s3").caps).toEqual(["ui.html"]);
  });

  // --------------------------------------------------------------------------
  // A revoke STICKS against the grants nobody was asked about
  // --------------------------------------------------------------------------
  //
  // An add-in's grid.read is written down by the host when a contribution that
  // will use it is REGISTERED — and `register` is a message the sandboxed worker
  // posts whenever it likes. Deleting from the live set alone therefore lasted
  // only until the add-in registered anything else: `caps.add` asked nothing, so
  // the capability came back silently and every reader resumed.

  it("a revoked capability is NOT restored by a grant nobody was asked about", async () => {
    const live = getGrantSet("s6");
    expect(recordCapabilityGrantUnlessRevoked("s6", "grid.read")).toBe(true);
    expect(live.has("grid.read")).toBe(true);

    await revokeCapability("s6", "grid.read");
    expect(wasRevokedThisSession("s6", "grid.read")).toBe(true);

    // The registration-driven write — the exact call the extension host makes
    // when a second bound form, cell-style contributor or cell-content
    // subscription arrives.
    expect(recordCapabilityGrantUnlessRevoked("s6", "grid.read")).toBe(false);
    expect(live.has("grid.read"), "the revoke must outlive the next registration").toBe(false);
    expect(getScriptGrants("s6").caps).toEqual([]);
  });

  it("a FRESH CONSENT lifts the revoke — only that, and nothing the script does", async () => {
    recordCapabilityGrant("s7", "storage");
    await revokeCapability("s7", "storage");
    expect(recordCapabilityGrantUnlessRevoked("s7", "storage")).toBe(false);

    // recordCapabilityGrant is only ever reached from a decision the user just
    // made (a JIT answer, package consent, a persisted "Always" for this exact
    // source), so it clears the revoke — otherwise the user could never say yes
    // again without restarting.
    recordCapabilityGrant("s7", "storage");
    expect(wasRevokedThisSession("s7", "storage")).toBe(false);
    expect(recordCapabilityGrantUnlessRevoked("s7", "storage")).toBe(true);
    expect(getScriptGrants("s7").caps).toEqual(["storage"]);
  });

  it("a revoke recorded for a script with no grants yet still binds", async () => {
    // revokeCapability used to return early when the script had no grant state,
    // which would have left the decision unrecorded and the next silent write
    // free to grant it.
    await revokeCapability("s8", "grid.read");
    expect(recordCapabilityGrantUnlessRevoked("s8", "grid.read")).toBe(false);
  });

  it("UNMOUNT clears the sticky revoke with the grants — a workbook reset does not", async () => {
    // Unmount is host- or user-driven — no worker message causes one — and the
    // code that comes back is being loaded again under its install consent.
    await revokeCapability("s9", "grid.read");
    revokeScriptGrants("s9");
    expect(wasRevokedThisSession("s9", "grid.read")).toBe(false);

    // A workbook reset reloads NOTHING: a distributed add-in is not unmounted on
    // File > Open, so lifting its revoke there would let it take the capability
    // straight back by registering another bound form — the exact laundering
    // `revokedThisSession` exists to stop, one workbook swap later.
    await revokeCapability("s10", "grid.read");
    resetAllGrants();
    expect(wasRevokedThisSession("s10", "grid.read")).toBe(true);
    expect(recordCapabilityGrantUnlessRevoked("s10", "grid.read")).toBe(false);
  });

  it("resetAllGrants / revokeScriptGrants clear a script's grants", () => {
    recordCapabilityGrant("s4", "net.fetch", "https://x.com");
    revokeScriptGrants("s4");
    expect(getScriptGrants("s4")).toEqual({ caps: [], origins: [] });
    recordCapabilityGrant("s5", "storage");
    resetAllGrants();
    expect(getScriptGrants("s5")).toEqual({ caps: [], origins: [] });
  });

  // --------------------------------------------------------------------------
  // A workbook reset must not ORPHAN the set a mounted handle is holding
  // --------------------------------------------------------------------------
  //
  // `resetAllGrants` used to be `grantState.clear()`, which drops the Map entry
  // and leaves the Set object behind — still referenced by every mounted
  // handle, because `handle.grants` is that exact object, taken once at mount.
  // A distributed add-in is not unmounted by File > Open, so from the user's
  // first workbook swap on: the panel listed a capability the store no longer
  // knew about, `revokeCapability` returned at its `if (!s) return;` guard
  // without touching the set the broker reads, and the capability kept working.

  it("keeps the live Set the handle holds, so a later revoke and a later grant both reach it", async () => {
    const live = getGrantSet("x1"); // what buildHandleFromDefinition put on handle.grants
    recordCapabilityGrantUnlessRevoked("x1", "grid.read"); // install consent, no prompt
    recordCapabilityGrantAtInstall("x1", "formula.udf"); // ditto
    recordCapabilityGrant("x1", "storage"); // a JIT answer: "in this workbook"

    resetAllGrants();

    // Install-scoped: still live, and the store AGREES with the handle's set —
    // the panel reads the handle, so a set the store has forgotten is a revoke
    // button that does nothing.
    expect(live.has("grid.read")).toBe(true);
    expect(live.has("formula.udf")).toBe(true);
    expect(getScriptGrants("x1").caps.sort()).toEqual(["formula.udf", "grid.read"]);
    // Prompted: gone from both. The dialog said "in this workbook".
    expect(live.has("storage")).toBe(false);

    // The transparency panel's revoke button reaches the set the broker reads.
    await revokeCapability("x1", "grid.read");
    expect(live.has("grid.read")).toBe(false);

    // ...and a grant recorded AFTER the reset lands in the SAME set, rather than
    // in a fresh entry the handle does not reference — which is what made the
    // JIT prompt re-ask forever.
    recordCapabilityGrant("x1", "storage");
    expect(live.has("storage")).toBe(true);
  });

  it("revokeScriptGrants empties the set the handle holds before dropping the entry", () => {
    // Unmount drops everything, install-scoped included — but it must EMPTY the
    // set first, for the same reason: a stale handle holding it (a pending form
    // show, a queued style batch) would otherwise still pass every check.
    const live = getGrantSet("x2");
    recordCapabilityGrantUnlessRevoked("x2", "grid.read");
    recordCapabilityGrant("x2", "net.fetch", "https://x.com");
    revokeScriptGrants("x2");
    expect(live.has("grid.read")).toBe(false);
    expect(live.has("net.fetch")).toBe(false);
    expect(getGrantedOrigins("x2")).toEqual([]);
  });

  it("a workbook reset does not carry an install grant back to an UNMOUNTED add-in", () => {
    // The scope is the MOUNT, not "forever": once the add-in is unmounted its
    // install-scoped record goes with it, so a grant made for the same id later
    // is an ordinary per-workbook one and the next reset takes it.
    recordCapabilityGrantUnlessRevoked("x3", "grid.read");
    revokeScriptGrants("x3");
    recordCapabilityGrant("x3", "grid.read"); // a later, per-workbook consent
    resetAllGrants();
    expect(getScriptGrants("x3").caps).toEqual([]);
  });
});

describe("R19 declared-capability ceiling (broker)", () => {
  const def = (id: string, declared: string[]) => ({
    id,
    name: "S",
    objectType: "cell",
    instanceId: null,
    accessLevel: "restricted",
    declaredCapabilities: declared,
  });

  it("denies an UNDECLARED capability with PermissionDenied, even if granted", async () => {
    const handle = buildHandleFromDefinition(def("r1", [])); // declares nothing
    recordCapabilityGrant("r1", "storage"); // grant it anyway — ceiling still wins
    await expect(
      brokerCall(handle, "cap.storageGet", ["k"], async () => "v"),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
  });

  it("declared-but-ungranted yields CapabilityRequired (not PermissionDenied)", async () => {
    const handle = buildHandleFromDefinition(def("r2", ["storage"]));
    await expect(
      brokerCall(handle, "cap.storageGet", ["k"], async () => "v"),
    ).rejects.toMatchObject({ code: "CapabilityRequired" });
  });

  it("declared AND granted reaches the executor", async () => {
    const handle = buildHandleFromDefinition(def("r3", ["storage"]));
    recordCapabilityGrant("r3", "storage");
    await expect(
      brokerCall(handle, "cap.storageGet", ["k"], async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("filters a garbage declared id out of the ceiling", () => {
    const handle = buildHandleFromDefinition(def("r4", ["filesystem", "storage"]));
    expect([...handle.declaredCapabilities]).toContain("storage");
    expect([...handle.declaredCapabilities]).not.toContain("filesystem");
  });
});
