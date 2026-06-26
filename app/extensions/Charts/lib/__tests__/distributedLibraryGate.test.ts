//! FILENAME: app/extensions/Charts/lib/__tests__/distributedLibraryGate.test.ts
// PURPOSE: The .calp consent gate for sandboxed chart libraries. evaluateLibraryConsent
//          must NEVER mount without a current consent: with a matching persisted
//          consent it applies the declared caps + installs; without one it returns
//          "needs-consent" and does NOT install. grantLibraryConsent applies caps,
//          installs, and persists the consent keyed by the (namespaced) consentKey.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { loadConsents, isConsentCurrent, recordConsent, applyConsentedCapabilities, describeCapability } = vi.hoisted(() => ({
  loadConsents: vi.fn(),
  isConsentCurrent: vi.fn(),
  recordConsent: vi.fn(),
  applyConsentedCapabilities: vi.fn(),
  describeCapability: vi.fn((c: string) => `desc:${c}`),
}));
vi.mock("@api", () => ({ loadConsents, isConsentCurrent, recordConsent, applyConsentedCapabilities, describeCapability }));

import {
  isLibraryConsentCurrent,
  mountConsentedLibrary,
  grantLibraryConsent,
  requestedCapabilityDescriptors,
  type LibraryGateDescriptor,
} from "../distributedLibraryGate";

function descriptor(over: Partial<LibraryGateDescriptor> = {}): LibraryGateDescriptor & { install: ReturnType<typeof vi.fn> } {
  const install = vi.fn().mockResolvedValue(undefined);
  return {
    scriptId: "__calcula_chart_transforms__",
    consentKey: "chart-transforms:Acme Reports",
    displayPackage: "Acme Reports",
    artifactLabel: "chart transform",
    itemNames: ["sandbox:foo"],
    capabilities: ["bi.query"],
    syntheticSource: "// @capability bi.query\n{\"transforms\":[]}",
    install,
    ...over,
  } as LibraryGateDescriptor & { install: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  loadConsents.mockReset().mockResolvedValue([]);
  isConsentCurrent.mockReset();
  recordConsent.mockReset().mockResolvedValue(undefined);
  applyConsentedCapabilities.mockReset().mockResolvedValue(undefined);
});

describe("isLibraryConsentCurrent", () => {
  it("is a PURE check — no install / cap grant as a side effect", async () => {
    isConsentCurrent.mockResolvedValue(true);
    const d = descriptor();
    const r = await isLibraryConsentCurrent(d);
    expect(r).toBe(true);
    expect(d.install).not.toHaveBeenCalled();
    expect(applyConsentedCapabilities).not.toHaveBeenCalled();
    // The consent check used the one-script view with the synthetic (cap-pragma) source.
    expect(isConsentCurrent).toHaveBeenCalledWith([], "chart-transforms:Acme Reports", [
      { id: "__calcula_chart_transforms__", source: d.syntheticSource },
    ]);
  });

  it("returns false when no current consent exists", async () => {
    isConsentCurrent.mockResolvedValue(false);
    expect(await isLibraryConsentCurrent(descriptor())).toBe(false);
  });
});

describe("mountConsentedLibrary", () => {
  it("applies the declared caps then installs (no consent record written)", async () => {
    const d = descriptor();
    await mountConsentedLibrary(d);
    expect(applyConsentedCapabilities).toHaveBeenCalledWith("__calcula_chart_transforms__", ["bi.query"], []);
    expect(d.install).toHaveBeenCalledTimes(1);
    expect(recordConsent).not.toHaveBeenCalled();
  });
});

describe("grantLibraryConsent", () => {
  it("applies caps, installs, and persists the consent under the namespaced key", async () => {
    const d = descriptor();
    await grantLibraryConsent(d);
    expect(applyConsentedCapabilities).toHaveBeenCalledWith("__calcula_chart_transforms__", ["bi.query"], []);
    expect(d.install).toHaveBeenCalledTimes(1);
    expect(recordConsent).toHaveBeenCalledWith(
      "chart-transforms:Acme Reports",
      [{ id: "__calcula_chart_transforms__", source: d.syntheticSource }],
      [{ capability: "bi.query" }],
    );
  });

  it("records an empty capability grant for a capability-free (mark) library", async () => {
    const d = descriptor({ scriptId: "__calcula_chart_marks__", consentKey: "chart-marks:Acme", capabilities: [], syntheticSource: "{\"marks\":[]}" });
    await grantLibraryConsent(d);
    expect(applyConsentedCapabilities).toHaveBeenCalledWith("__calcula_chart_marks__", [], []);
    expect(recordConsent).toHaveBeenCalledWith("chart-marks:Acme", [{ id: "__calcula_chart_marks__", source: "{\"marks\":[]}" }], []);
  });
});

describe("requestedCapabilityDescriptors", () => {
  it("maps capability ids to id+description+empty origins", () => {
    expect(requestedCapabilityDescriptors(["bi.query"])).toEqual([
      { capability: "bi.query", description: "desc:bi.query", origins: [] },
    ]);
    expect(requestedCapabilityDescriptors([])).toEqual([]);
  });
});
