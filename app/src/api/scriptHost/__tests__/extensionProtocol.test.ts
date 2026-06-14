// Unit tests for the distributed-extension worker realm contract (Wave 3 /
// S8-C7 Phase B). Pins (1) that every method a sandboxed extension may route is
// an ALLOWLIST-governed, restricted-tier policy, and (2) the ambient authority
// denied in every worker realm.

import { describe, it, expect } from "vitest";
import { EXTENSION_BROKER_METHODS } from "../extensionProtocol";
import { ALLOWLIST } from "../allowlist";
import { NEUTERED_GLOBALS } from "../worker/workerHardening";

describe("extension worker broker methods", () => {
  it("every extension broker method has an ALLOWLIST policy", () => {
    for (const m of EXTENSION_BROKER_METHODS) {
      expect(ALLOWLIST[m], m).toBeDefined();
    }
  });

  it("are all restricted-tier (a sandboxed distributed extension is untrusted)", () => {
    for (const m of EXTENSION_BROKER_METHODS) {
      expect(ALLOWLIST[m].tier, m).toBe("restricted");
    }
  });

  it("capability-bearing methods require a declared capability (R19 ceiling)", () => {
    // cap.* methods must carry a capability; the ext.* convenience methods do not.
    expect(ALLOWLIST["cap.fetch"].capability).toBe("net.fetch");
    expect(ALLOWLIST["cap.storageGet"].capability).toBe("storage");
    expect(ALLOWLIST["cap.storageSet"].capability).toBe("storage");
    expect(ALLOWLIST["ext.notify"].capability).toBeUndefined();
    expect(ALLOWLIST["ext.executeCommand"].capability).toBeUndefined();
  });
});

describe("worker realm hardening", () => {
  it("pins the ambient authority denied in EVERY worker realm (object + extension)", () => {
    expect([...NEUTERED_GLOBALS].sort()).toEqual(
      ["EventSource", "WebSocket", "XMLHttpRequest", "caches", "fetch", "importScripts", "indexedDB"].sort(),
    );
  });
});
