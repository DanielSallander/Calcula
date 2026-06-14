// Unit tests for extension trust classification + declared-capability ceiling
// (Wave 3 / S8-C7 Phase A). Pins the deny-by-default posture for distributed
// (third-party) extensions and the full-authority posture for trusted built-ins.

import { describe, it, expect } from "vitest";
import { computeExtensionCeiling } from "../extensionTrust";
import type { CapabilityId } from "../../../api/scriptHost/capabilityIds";

describe("computeExtensionCeiling", () => {
  it("trusted built-ins are not ceiling-bound (empty list by convention)", () => {
    expect(computeExtensionCeiling(["net.fetch"], "trusted")).toEqual([]);
    expect(computeExtensionCeiling(undefined, "trusted")).toEqual([]);
  });

  it("distributed extensions are bounded by their declared, recognized caps", () => {
    expect(computeExtensionCeiling(["net.fetch", "storage"], "distributed")).toEqual([
      "net.fetch",
      "storage",
    ]);
  });

  it("deny-by-default: distributed with no declared caps -> empty ceiling", () => {
    expect(computeExtensionCeiling(undefined, "distributed")).toEqual([]);
    expect(computeExtensionCeiling([], "distributed")).toEqual([]);
  });

  it("drops unrecognized capability ids from a distributed manifest", () => {
    const declared = ["net.fetch", "filesystem", "storage"] as CapabilityId[];
    expect(computeExtensionCeiling(declared, "distributed")).toEqual(["net.fetch", "storage"]);
  });
});
