// Unit tests for the distributed-extension worker realm contract (Wave 3 /
// S8-C7 Phase B). Pins (1) that every method a sandboxed extension may route is
// an ALLOWLIST-governed, restricted-tier policy, and (2) the ambient authority
// denied in every worker realm.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  CONTRIBUTION_REGISTRATION_KINDS,
  EXTENSION_BROKER_METHODS,
  EXTENSION_CONTRIBUTION_KINDS,
} from "../extensionProtocol";
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

describe("the extension broker gate is enforced, not documented", () => {
  const hostSrc = fs.readFileSync(
    path.resolve(__dirname, "../extensionWorkerHost.ts"),
    "utf8",
  );

  it("handleBrokerCall consults EXTENSION_BROKER_METHODS before the broker", () => {
    // Regression: the set shipped with the comment "anything not here is
    // rejected by the broker as UnknownMethod" while NOTHING read it. The
    // broker enforces the shared ALLOWLIST, which also contains restricted-tier
    // rows meant for object scripts (base.*, sheet.*, events.subscribe); the
    // only thing keeping them out was executeExtensionImpl's `default:` arm —
    // fail-closed by accident, which evaporates as soon as a case is added.
    expect(hostSrc).toContain("EXTENSION_BROKER_METHODS.has(method)");
    const gateIndex = hostSrc.indexOf("EXTENSION_BROKER_METHODS.has(method)");
    const grantIndex = hostSrc.indexOf("await maybeRequestCapabilityGrant");
    expect(gateIndex, "the gate must exist").toBeGreaterThan(-1);
    expect(
      gateIndex,
      "an ungated method must never even reach capability prompting",
    ).toBeLessThan(grantIndex);
  });

  it("restricted-tier object-script rows are NOT reachable from an extension", () => {
    for (const m of ["base.log", "base.expose", "sheet.setCellValue", "events.subscribe"]) {
      expect(ALLOWLIST[m], `${m} should still be a real policy row`).toBeDefined();
      expect(
        EXTENSION_BROKER_METHODS.has(m),
        `${m} is restricted-tier but belongs to object scripts, not sandboxed extensions`,
      ).toBe(false);
    }
  });
});

describe("contribution kinds", () => {
  it("every declarative contribution kind is ceiling-gated", () => {
    // CONTRIBUTION_REGISTRATION_KINDS drives the gate in setupRegistration; a
    // kind that is in the protocol but not in this set would be admitted with
    // no declaration at all.
    for (const kind of EXTENSION_CONTRIBUTION_KINDS) {
      expect(CONTRIBUTION_REGISTRATION_KINDS.has(kind), kind).toBe(true);
    }
    // `event` is a subscription, not a contribution: it installs no surface and
    // its reach is bounded by SCRIPT_SUBSCRIBABLE_APP_EVENTS instead.
    expect(CONTRIBUTION_REGISTRATION_KINDS.has("event")).toBe(false);
  });
});

describe("worker realm hardening", () => {
  it("pins the ambient authority denied in EVERY worker realm (object + extension)", () => {
    expect([...NEUTERED_GLOBALS].sort()).toEqual(
      ["EventSource", "WebSocket", "XMLHttpRequest", "caches", "fetch", "importScripts", "indexedDB"].sort(),
    );
  });
});
