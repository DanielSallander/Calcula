//! FILENAME: app/extensions/_shared/lib/__tests__/scriptModuleProvenance.test.ts
// PURPOSE: The picker-facing provenance helpers read the `sourcePackage` stamp
//          the way the run planner and the Rust consent gate read it, and say
//          nothing at all for the user's own code.

import { describe, it, expect } from "vitest";
import {
  describeDistributedScriptChoice,
  describeScriptSuggestion,
  describeWithheldFunctionField,
  isDistributedScriptEntry,
  scriptEntryApplication,
  scriptPickerLabel,
} from "../scriptModuleProvenance";
import { isDistributedModule, moduleApplicationName } from "../buttonScriptRun";

const local = { id: "l", name: "Report", sourcePackage: null };
const distributed = { id: "d", name: "Report", sourcePackage: "SalesApp" };
const unnamed = { id: "u", name: "Report", sourcePackage: "   " };

describe("scriptModuleProvenance", () => {
  it("names the application for a distributed entry and nothing for a local one", () => {
    expect(scriptEntryApplication(local)).toBeNull();
    expect(scriptEntryApplication({ id: "x", name: "Report" })).toBeNull();
    expect(scriptEntryApplication(distributed)).toBe("SalesApp");
    expect(isDistributedScriptEntry(local)).toBe(false);
    expect(isDistributedScriptEntry(distributed)).toBe(true);
  });

  it("agrees with the run planner about what is distributed, blank stamp included", () => {
    // Two modules with the identical stamp must never be local on one surface
    // and distributed on the other — the planner refuses by this reading. What
    // a BLANK stamp means is `scriptOriginForStoredRecord`'s decision, pinned
    // in its own tests; what is pinned here is that the picker and the planner
    // give the same answer for it, whatever that answer is.
    for (const entry of [local, distributed, unnamed]) {
      const asModule = { ...entry, source: "" };
      expect(isDistributedScriptEntry(entry)).toBe(isDistributedModule(asModule));
      expect(scriptEntryApplication(entry)).toBe(moduleApplicationName(asModule));
    }
  });

  it("labels two same-named modules from different origins differently", () => {
    expect(scriptPickerLabel(local)).toBe("Report");
    expect(scriptPickerLabel(distributed)).toBe('Report — from application "SalesApp"');
    expect(scriptPickerLabel(local)).not.toBe(scriptPickerLabel(distributed));
  });

  it("describes the distributed choice by its actual guarantee, and is silent for local", () => {
    const note = describeDistributedScriptChoice(distributed);
    expect(note).toContain("SalesApp");
    expect(note).toContain("exactly as published");
    expect(note).toContain("only if you have approved that application");
    expect(describeDistributedScriptChoice(local)).toBeNull();
  });

  it("explains the withheld function field for distributed, and offers it for local", () => {
    const why = describeWithheldFunctionField(distributed);
    expect(why).toContain("SalesApp");
    expect(why).toContain("code you have not approved");
    expect(describeWithheldFunctionField(local)).toBeNull();
  });

  it("writes a suggestion line that names the publisher only when there is one", () => {
    expect(describeScriptSuggestion(local)).toBe('Run script module "Report"');
    const line = describeScriptSuggestion(distributed);
    expect(line).toContain('"SalesApp"');
    expect(line).toContain("exactly as published");
  });
});
