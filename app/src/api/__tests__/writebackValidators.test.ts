//! FILENAME: app/src/api/__tests__/writebackValidators.test.ts
// PURPOSE: Publisher-shipped writeback validators — the frontend half: the
//          consent-key contract with the Rust gate, discovery of the validator
//          body from the verified manifest, consent recording (merge, never
//          clobber), mounting into the hardened worker realm ONLY once
//          consented, and the advisory run's normalization + fail-soft rules.
// CONTEXT: The authoritative accept/refuse lives in Rust (calp_commands.rs,
//          `writeback_validator_tests`). Everything here is the surface that
//          gets the user's informed consent and gives in-cell feedback; none of
//          it can loosen the submit gate, which is exactly what the last test
//          in this file pins.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { hostMountScript, hostUnmountScript, callExposedMethod, invoke, loadConsents, recordConsent, isConsentCurrent } =
  vi.hoisted(() => ({
    hostMountScript: vi.fn(),
    hostUnmountScript: vi.fn(),
    callExposedMethod: vi.fn(),
    invoke: vi.fn(),
    loadConsents: vi.fn(),
    recordConsent: vi.fn(),
    isConsentCurrent: vi.fn(),
  }));
vi.mock("../scriptHost/host", () => ({ hostMountScript, hostUnmountScript }));
vi.mock("../scriptableObjects", () => ({ callExposedMethod }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../distributedConsent", () => ({ loadConsents, recordConsent, isConsentCurrent }));

import {
  WRITEBACK_VALIDATOR_CONSENT_SUFFIX,
  writebackValidatorConsentKey,
  writebackValidatorScriptId,
  registerWritebackValidator,
  getWritebackValidatorSource,
  writebackValidatorSchemaExtra,
  generateValidatorWorkerSource,
  fetchWritebackValidator,
  writebackValidatorsConsented,
  approveWritebackValidators,
  mountWritebackValidator,
  unmountWritebackValidators,
  mountedWritebackValidators,
  runWritebackValidatorAsync,
  runWritebackValidator,
  type WritebackValidatorDescriptor,
} from "../writebackValidators";

const descriptor = (over: Partial<WritebackValidatorDescriptor> = {}): WritebackValidatorDescriptor => ({
  regionId: "region-1",
  packageName: "acme.budget",
  packageVersion: "1.2.0",
  name: "positive",
  source: "(v) => v > 0 ? true : 'must be positive'",
  sourceHash: "hash-1",
  consented: true,
  ...over,
});

beforeEach(() => {
  unmountWritebackValidators();
  hostMountScript.mockReset().mockResolvedValue(undefined);
  hostUnmountScript.mockReset();
  callExposedMethod.mockReset();
  invoke.mockReset();
  loadConsents.mockReset().mockResolvedValue([]);
  recordConsent.mockReset().mockResolvedValue(undefined);
  isConsentCurrent.mockReset().mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Cross-language contract
// ---------------------------------------------------------------------------

describe("consent key contract", () => {
  // These exact strings are recomputed in Rust
  // (validator_consent_key / validator_script_id). If one side changes, every
  // approved validator silently becomes un-approved and every submission of a
  // validated region starts failing closed.
  it("matches the Rust key shapes", () => {
    expect(WRITEBACK_VALIDATOR_CONSENT_SUFFIX).toBe("::writeback-validators");
    expect(writebackValidatorConsentKey("acme.budget")).toBe("acme.budget::writeback-validators");
    expect(writebackValidatorScriptId("iban")).toBe("writeback-validator:iban");
  });

  it("keys validators apart from the package's object-script consent record", () => {
    expect(writebackValidatorConsentKey("acme.budget")).not.toBe("acme.budget");
  });
});

// ---------------------------------------------------------------------------
// Author side: a name is not enough — the BODY must ship
// ---------------------------------------------------------------------------

describe("author-side publishing", () => {
  it("publishes the validator's own source, not just its name", () => {
    const cleanup = registerWritebackValidator("positive", "Positive", (v) =>
      Number(v) > 0 ? true : "must be positive",
    );
    try {
      const source = getWritebackValidatorSource("positive");
      expect(source).toBeTruthy();
      expect(source).toContain("must be positive");
      const extra = writebackValidatorSchemaExtra("positive");
      expect(extra).toEqual({ customValidator: "positive", customValidatorSource: source });
    } finally {
      cleanup();
    }
  });

  it("yields nothing for an unknown validator (so no name-only region is authored)", () => {
    expect(getWritebackValidatorSource("nope")).toBeNull();
    expect(writebackValidatorSchemaExtra("nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("discovery", () => {
  it("maps the backend preview into a descriptor", async () => {
    invoke.mockResolvedValue({
      packageName: "acme.budget",
      resolvedVersion: "1.2.0",
      validator: { name: "positive", source: "(v) => true", sourceHash: "h", consented: false },
    });
    const status = await fetchWritebackValidator("region-1");
    expect(invoke).toHaveBeenCalledWith("calp_preview_region_submission", { regionId: "region-1" });
    expect(status.validator).toEqual({
      regionId: "region-1",
      packageName: "acme.budget",
      packageVersion: "1.2.0",
      name: "positive",
      source: "(v) => true",
      sourceHash: "h",
      consented: false,
    });
    expect(status.error).toBeNull();
  });

  /// The old broken state: a region names a validator the package never shipped.
  it("surfaces a declared-but-missing validator body as an error, not a pass", async () => {
    invoke.mockResolvedValue({
      packageName: "acme.budget",
      resolvedVersion: "1.2.0",
      validatorError: "ships no validator code for it",
    });
    const status = await fetchWritebackValidator("region-1");
    expect(status.validator).toBeNull();
    expect(status.error).toContain("ships no validator code");
  });

  it("never throws into the caller's UI path", async () => {
    invoke.mockRejectedValue(new Error("registry offline"));
    const status = await fetchWritebackValidator("region-1");
    expect(status.validator).toBeNull();
    expect(status.error).toContain("registry offline");
  });
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

describe("consent", () => {
  it("checks consent under the validator key with the exact source", async () => {
    const d = descriptor();
    await writebackValidatorsConsented("acme.budget", [d]);
    expect(isConsentCurrent).toHaveBeenCalledWith(
      [],
      "acme.budget::writeback-validators",
      [{ id: "writeback-validator:positive", source: d.source }],
    );
  });

  it("treats an empty validator list as consented", async () => {
    expect(await writebackValidatorsConsented("acme.budget", [])).toBe(true);
    expect(isConsentCurrent).not.toHaveBeenCalled();
  });

  // recordConsent REPLACES a package's whole record, so approving one validator
  // must carry its already-approved siblings forward or it silently revokes them.
  it("merges with previously approved validators of the same package", async () => {
    loadConsents.mockResolvedValue([
      {
        packageName: "acme.budget::writeback-validators",
        scripts: [
          { id: "writeback-validator:iban", sourceHash: "old", source: "(v) => true" },
          { id: "writeback-validator:positive", sourceHash: "stale", source: "(v) => 'old body'" },
        ],
        grantedCapabilities: [],
        grantedAt: "2026-07-30T00:00:00Z",
      },
    ]);
    const d = descriptor();
    await approveWritebackValidators("acme.budget", [d]);
    expect(recordConsent).toHaveBeenCalledWith(
      "acme.budget::writeback-validators",
      [
        { id: "writeback-validator:iban", source: "(v) => true" },
        { id: "writeback-validator:positive", source: d.source },
      ],
      [],
    );
  });

  it("grants zero capabilities — a validator is a pure predicate", async () => {
    await approveWritebackValidators("acme.budget", [descriptor()]);
    expect(recordConsent.mock.calls[0][2]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

describe("mounting", () => {
  it("refuses to mount an un-consented body", async () => {
    await expect(mountWritebackValidator(descriptor({ consented: false }))).rejects.toThrow(
      /has not been approved/,
    );
    expect(hostMountScript).not.toHaveBeenCalled();
  });

  it("mounts restricted, distributed, with an EMPTY capability ceiling", async () => {
    await mountWritebackValidator(descriptor());
    const def = hostMountScript.mock.calls[0][0];
    expect(def.accessLevel).toBe("restricted");
    expect(def.provenance).toBe("distributed");
    expect(def.packageName).toBe("acme.budget");
    expect(def.declaredCapabilities).toEqual([]);
    expect(mountedWritebackValidators()).toHaveLength(1);
  });

  it("wraps the publisher body in a non-public exposed method", () => {
    const source = generateValidatorWorkerSource("(v) => v > 0");
    expect(source).toContain("(v) => v > 0");
    expect(source).toContain('context.expose("validate"');
    expect(source).toContain("{ public: false }");
  });

  it("unmounts everything on teardown", async () => {
    await mountWritebackValidator(descriptor());
    unmountWritebackValidators();
    expect(hostUnmountScript).toHaveBeenCalled();
    expect(mountedWritebackValidators()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Advisory execution
// ---------------------------------------------------------------------------

describe("advisory execution", () => {
  it("returns the worker's rejection message", async () => {
    await mountWritebackValidator(descriptor());
    callExposedMethod.mockResolvedValue("must be positive");
    expect(await runWritebackValidatorAsync("region-1", -1, { regionId: "region-1" })).toBe(
      "must be positive",
    );
  });

  it("passes the package identity in the context", async () => {
    await mountWritebackValidator(descriptor());
    callExposedMethod.mockResolvedValue(null);
    await runWritebackValidatorAsync("region-1", 5, { regionId: "region-1", valueType: "number" });
    const [, , method, value, ctx] = callExposedMethod.mock.calls[0];
    expect(method).toBe("validate");
    expect(value).toBe(5);
    expect(ctx).toMatchObject({
      regionId: "region-1",
      valueType: "number",
      packageName: "acme.budget",
      packageVersion: "1.2.0",
    });
  });

  it("is a no-op when nothing is mounted (advisory, never a hard failure)", async () => {
    expect(await runWritebackValidatorAsync("region-1", 1, { regionId: "region-1" })).toBeNull();
    expect(callExposedMethod).not.toHaveBeenCalled();
  });

  it("does not block typing when the worker faults", async () => {
    await mountWritebackValidator(descriptor());
    callExposedMethod.mockRejectedValue(new Error("worker died"));
    expect(await runWritebackValidatorAsync("region-1", 1, { regionId: "region-1" })).toBeNull();
  });

  it("serves the sync accessor from the cached verdict", async () => {
    await mountWritebackValidator(descriptor());
    callExposedMethod.mockResolvedValue("must be positive");
    await runWritebackValidatorAsync("region-1", -1, { regionId: "region-1" });
    expect(runWritebackValidator("positive", -1, { regionId: "region-1" })).toBe("must be positive");
    // A value never judged yet has no advisory opinion — and returning null
    // here is NOT an accept decision, only "nothing to say"; the Rust gate is
    // what actually decides whether the value may be submitted.
    expect(runWritebackValidator("positive", 7, { regionId: "region-1" })).toBeNull();
  });

  it("runs a locally registered validator synchronously", () => {
    const cleanup = registerWritebackValidator("positive", "Positive", (v) =>
      Number(v) > 0 ? true : "must be positive",
    );
    try {
      expect(runWritebackValidator("positive", "5", { regionId: "region-1" })).toBeNull();
      expect(runWritebackValidator("positive", "-1", { regionId: "region-1" })).toBe(
        "must be positive",
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The anti-bypass invariant
// ---------------------------------------------------------------------------

describe("the frontend cannot vouch for a submission", () => {
  /**
   * A script holding `distribution.writeback` calls the submit gateway
   * directly, never touching this module. That path must still be judged, which
   * is only true if the backend re-runs the validator itself — so no export
   * here may hand the backend a verdict, and no submit call may carry one.
   * This test pins the API surface: nothing in this module can be used to tell
   * the backend "already validated".
   */
  it("exposes no way to assert a verdict to the backend", async () => {
    const api = await import("../writebackValidators");
    const names = Object.keys(api);
    expect(names.filter((n) => /verdict|attest|vouch|assert/i.test(n))).toEqual([]);
    // The only backend call this module makes is the READ-ONLY preview.
    invoke.mockResolvedValue({ packageName: "p", resolvedVersion: "1.0.0" });
    await fetchWritebackValidator("region-1");
    for (const call of invoke.mock.calls) {
      expect(call[0]).toBe("calp_preview_region_submission");
    }
  });
});
