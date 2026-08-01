// Unit tests for extension trust classification + declared-capability ceiling
// (Wave 3 / S8-C7 Phase A). Pins the deny-by-default posture for distributed
// (third-party) extensions and the full-authority posture for trusted built-ins.

import { describe, it, expect } from "vitest";
import {
  computeContributionCeiling,
  computeExtensionCeiling,
  mayActivateOnMainThread,
} from "../extensionTrust";
import type { CapabilityId } from "../../../api/scriptHost/capabilityIds";
import type { ExtensionTrust } from "../../../api/extensionManager";

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

describe("computeContributionCeiling", () => {
  it("trusted built-ins are not contribution-bound", () => {
    expect(computeContributionCeiling({ formulas: ["X"] }, "trusted")).toEqual({});
  });

  it("distributed extensions are bounded by their declared contribution ids", () => {
    expect(
      computeContributionCeiling(
        { formulas: ["VATRATE"], commands: ["doThing"], nonsense: ["x"] },
        "distributed",
      ),
    ).toEqual({ formulas: ["VATRATE"], commands: ["doThing"] });
  });

  it("deny-by-default: nothing declared -> nothing may be contributed", () => {
    expect(computeContributionCeiling(undefined, "distributed")).toEqual({});
    expect(computeContributionCeiling({}, "distributed")).toEqual({});
    expect(computeContributionCeiling("garbage", "distributed")).toEqual({});
  });
});

describe("mayActivateOnMainThread (B2)", () => {
  it("only trusted built-ins may run on the main thread", () => {
    expect(mayActivateOnMainThread("trusted")).toBe(true);
  });

  it("distributed (untrusted) extensions are refused the main thread", () => {
    expect(mayActivateOnMainThread("distributed")).toBe(false);
  });

  it("NO trust value other than 'trusted' unlocks the main thread", () => {
    // The third-party add-in slice grew the SANDBOX so this predicate would
    // never have to widen (docs/design/third-party-addin-authoring.md §1: a
    // signature proves who, not what). If a third trust class is ever added to
    // ExtensionTrust, this test fails until someone justifies its realm.
    const everyTrust: ExtensionTrust[] = ["trusted", "distributed"];
    expect(everyTrust.filter(mayActivateOnMainThread)).toEqual(["trusted"]);
    // Defensive: an unexpected value must not be treated as trusted.
    expect(mayActivateOnMainThread("publisher" as ExtensionTrust)).toBe(false);
  });
});
