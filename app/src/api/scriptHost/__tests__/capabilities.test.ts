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

  it("resetAllGrants / revokeScriptGrants clear a script's grants", () => {
    recordCapabilityGrant("s4", "net.fetch", "https://x.com");
    revokeScriptGrants("s4");
    expect(getScriptGrants("s4")).toEqual({ caps: [], origins: [] });
    recordCapabilityGrant("s5", "storage");
    resetAllGrants();
    expect(getScriptGrants("s5")).toEqual({ caps: [], origins: [] });
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
