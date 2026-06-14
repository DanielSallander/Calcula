// Unit tests for the single-source-of-truth capability vocabulary (Wave 3
// Stage 0). Before this, the capability id list was duplicated in three places
// (allowlist CapabilityId union, capabilities KNOWN_CAPABILITY_IDS, broker
// VALID_CAPABILITY_IDS). These tests pin that they now resolve to ONE set, so a
// future capability can't be half-added (which would fail closed confusingly).

import { describe, it, expect } from "vitest";

import { ALL_CAPABILITY_IDS, CAPABILITY_ID_SET, isCapabilityId } from "../capabilityIds";
import { ALLOWLIST } from "../allowlist";
import { buildHandleFromDefinition } from "../broker";

describe("capability vocabulary single source of truth", () => {
  it("CAPABILITY_ID_SET contains exactly ALL_CAPABILITY_IDS", () => {
    expect(CAPABILITY_ID_SET.size).toBe(ALL_CAPABILITY_IDS.length);
    for (const id of ALL_CAPABILITY_IDS) expect(CAPABILITY_ID_SET.has(id)).toBe(true);
  });

  it("every capability referenced by an ALLOWLIST method is a recognized id", () => {
    for (const [method, policy] of Object.entries(ALLOWLIST)) {
      if (policy.capability) {
        expect(isCapabilityId(policy.capability), `${method} -> ${policy.capability}`).toBe(true);
      }
    }
  });

  it("the broker ceiling filter (VALID_CAPABILITY_IDS) admits exactly the shared set", () => {
    // A declared list of every known id plus a garbage id: only the known ids
    // survive into the ceiling, proving broker uses the shared CAPABILITY_ID_SET.
    const handle = buildHandleFromDefinition({
      id: "cap-sot",
      name: "S",
      objectType: "cell",
      instanceId: null,
      accessLevel: "restricted",
      declaredCapabilities: [...ALL_CAPABILITY_IDS, "filesystem", "net.raw"],
    });
    const ceiling = new Set(handle.declaredCapabilities);
    // ui.html is auto-added for local scripts; every other known id passes through.
    for (const id of ALL_CAPABILITY_IDS) expect(ceiling.has(id)).toBe(true);
    expect(ceiling.has("filesystem" as never)).toBe(false);
    expect(ceiling.has("net.raw" as never)).toBe(false);
  });

  it("isCapabilityId narrows unknown strings", () => {
    expect(isCapabilityId("net.fetch")).toBe(true);
    expect(isCapabilityId("filesystem")).toBe(false);
    expect(isCapabilityId(42)).toBe(false);
    expect(isCapabilityId(undefined)).toBe(false);
  });
});
