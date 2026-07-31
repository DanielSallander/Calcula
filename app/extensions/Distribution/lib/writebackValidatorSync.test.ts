// FILENAME: app/extensions/Distribution/lib/writebackValidatorSync.test.ts
// PURPOSE: The subscriber-side validator sync pass: discover, gate on consent,
//          mount only what was approved, surface what is blocked, and tear down
//          validators whose regions went away.
// CONTEXT: Every "blocked"/"pending" outcome here is advisory bookkeeping for
//          the UI. The refusal that matters happens in Rust at submit — these
//          tests pin that this layer never mounts un-consented code and never
//          silently swallows a region whose validator cannot run.

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  fetchWritebackValidator,
  writebackValidatorsConsented,
  approveWritebackValidators,
  mountWritebackValidator,
  unmountWritebackValidator,
  unmountWritebackValidators,
} = vi.hoisted(() => ({
  fetchWritebackValidator: vi.fn(),
  writebackValidatorsConsented: vi.fn(),
  approveWritebackValidators: vi.fn(),
  mountWritebackValidator: vi.fn(),
  unmountWritebackValidator: vi.fn(),
  unmountWritebackValidators: vi.fn(),
}));
vi.mock("@api/writebackValidators", () => ({
  fetchWritebackValidator,
  writebackValidatorsConsented,
  approveWritebackValidators,
  mountWritebackValidator,
  unmountWritebackValidator,
  unmountWritebackValidators,
}));

import {
  syncWritebackValidators,
  approveAndMountWritebackValidators,
  resetWritebackValidators,
  lastWritebackValidatorSync,
  WRITEBACK_VALIDATORS_CHANGED_EVENT,
} from "./writebackValidatorSync";

const validator = (regionId: string, name = "positive", packageName = "acme.budget") => ({
  regionId,
  packageName,
  packageVersion: "1.2.0",
  name,
  source: `(v) => v > 0 ? true : '${name} failed'`,
  sourceHash: `hash-${name}`,
  consented: false,
});

beforeEach(() => {
  resetWritebackValidators();
  fetchWritebackValidator.mockReset();
  writebackValidatorsConsented.mockReset().mockResolvedValue(true);
  approveWritebackValidators.mockReset().mockResolvedValue(undefined);
  mountWritebackValidator.mockReset().mockResolvedValue(undefined);
  unmountWritebackValidator.mockReset();
  unmountWritebackValidators.mockReset();
});

describe("syncWritebackValidators", () => {
  it("ignores regions that declare no validator", async () => {
    const result = await syncWritebackValidators([{ regionId: "r1" }, { regionId: "r2" }]);
    expect(fetchWritebackValidator).not.toHaveBeenCalled();
    expect(result).toEqual({ mounted: [], pending: [], blocked: [] });
  });

  it("mounts an approved validator", async () => {
    fetchWritebackValidator.mockResolvedValue({
      regionId: "r1",
      validator: validator("r1"),
      error: null,
    });
    const result = await syncWritebackValidators([{ regionId: "r1", customValidator: "positive" }]);
    expect(mountWritebackValidator).toHaveBeenCalledTimes(1);
    expect(mountWritebackValidator.mock.calls[0][0].consented).toBe(true);
    expect(result.mounted).toHaveLength(1);
    expect(result.pending).toHaveLength(0);
  });

  it("never mounts an un-consented body — it reports it as pending review", async () => {
    writebackValidatorsConsented.mockResolvedValue(false);
    fetchWritebackValidator.mockResolvedValue({
      regionId: "r1",
      validator: validator("r1"),
      error: null,
    });
    const result = await syncWritebackValidators([{ regionId: "r1", customValidator: "positive" }]);
    expect(mountWritebackValidator).not.toHaveBeenCalled();
    expect(result.pending).toEqual([
      { packageName: "acme.budget", validators: [validator("r1")] },
    ]);
  });

  // The old failure mode, made visible: a region names a validator the package
  // never shipped. Submission of that region WILL be refused backend-side, so
  // the pane has to be able to say which region and why.
  it("reports a region whose validator has no body as blocked", async () => {
    fetchWritebackValidator.mockResolvedValue({
      regionId: "r1",
      validator: null,
      error: "acme.budget v1.2.0 ships no validator code for 'positive'",
    });
    const result = await syncWritebackValidators([{ regionId: "r1", customValidator: "positive" }]);
    expect(result.blocked).toEqual([
      { regionId: "r1", message: "acme.budget v1.2.0 ships no validator code for 'positive'" },
    ]);
    expect(mountWritebackValidator).not.toHaveBeenCalled();
    expect(unmountWritebackValidator).toHaveBeenCalledWith("r1");
  });

  it("consents per (package, validator) and mounts per region", async () => {
    fetchWritebackValidator.mockImplementation((regionId: string) =>
      Promise.resolve({ regionId, validator: validator(regionId), error: null }),
    );
    await syncWritebackValidators([
      { regionId: "r1", customValidator: "positive" },
      { regionId: "r2", customValidator: "positive" },
    ]);
    // One consent question for the shared validator...
    expect(writebackValidatorsConsented).toHaveBeenCalledTimes(1);
    expect(writebackValidatorsConsented.mock.calls[0][1]).toHaveLength(1);
    // ...two mounts, one per region that uses it.
    expect(mountWritebackValidator).toHaveBeenCalledTimes(2);
  });

  it("separates packages so one package's approval never covers another's code", async () => {
    fetchWritebackValidator.mockImplementation((regionId: string) =>
      Promise.resolve({
        regionId,
        validator:
          regionId === "r1"
            ? validator("r1", "positive", "acme.budget")
            : validator("r2", "iban", "other.vendor"),
        error: null,
      }),
    );
    writebackValidatorsConsented.mockImplementation((packageName: string) =>
      Promise.resolve(packageName === "acme.budget"),
    );
    const result = await syncWritebackValidators([
      { regionId: "r1", customValidator: "positive" },
      { regionId: "r2", customValidator: "iban" },
    ]);
    expect(result.mounted.map((v) => v.regionId)).toEqual(["r1"]);
    expect(result.pending.map((p) => p.packageName)).toEqual(["other.vendor"]);
  });

  it("tears down validators whose region disappeared", async () => {
    fetchWritebackValidator.mockResolvedValue({
      regionId: "r1",
      validator: validator("r1"),
      error: null,
    });
    await syncWritebackValidators([{ regionId: "r1", customValidator: "positive" }]);
    unmountWritebackValidator.mockClear();
    await syncWritebackValidators([]);
    expect(unmountWritebackValidator).toHaveBeenCalledWith("r1");
  });

  it("keeps working when an advisory mount is blocked", async () => {
    fetchWritebackValidator.mockResolvedValue({
      regionId: "r1",
      validator: validator("r1"),
      error: null,
    });
    mountWritebackValidator.mockRejectedValue(new Error("Script Security: disabled"));
    const result = await syncWritebackValidators([{ regionId: "r1", customValidator: "positive" }]);
    expect(result.mounted).toHaveLength(0);
    expect(result.blocked).toHaveLength(0); // submit is still gated backend-side
  });
});

describe("approveAndMountWritebackValidators", () => {
  it("records consent before mounting", async () => {
    const order: string[] = [];
    approveWritebackValidators.mockImplementation(async () => {
      order.push("consent");
    });
    mountWritebackValidator.mockImplementation(async () => {
      order.push("mount");
    });
    const live = await approveAndMountWritebackValidators("acme.budget", [validator("r1")]);
    expect(order).toEqual(["consent", "mount"]);
    expect(live).toHaveLength(1);
  });

  it("propagates a consent-store failure instead of mounting anyway", async () => {
    approveWritebackValidators.mockRejectedValue(new Error("disk full"));
    await expect(
      approveAndMountWritebackValidators("acme.budget", [validator("r1")]),
    ).rejects.toThrow("disk full");
    expect(mountWritebackValidator).not.toHaveBeenCalled();
  });
});

describe("the pane's view of the last pass", () => {
  // The WritebackPane mounts AFTER the extension has already synced, so the
  // consent prompt has to survive as state, not only as an event payload.
  it("remembers the latest pass so a late-mounting pane still sees it", async () => {
    expect(lastWritebackValidatorSync()).toEqual({ mounted: [], pending: [], blocked: [] });

    writebackValidatorsConsented.mockResolvedValue(false);
    fetchWritebackValidator.mockResolvedValue({
      regionId: "r1",
      validator: validator("r1"),
      error: null,
    });
    await syncWritebackValidators([{ regionId: "r1", customValidator: "positive" }]);

    const seen = lastWritebackValidatorSync();
    expect(seen.pending).toHaveLength(1);
    expect(seen.pending[0].packageName).toBe("acme.budget");
    expect(seen.mounted).toEqual([]);
  });

  it("a blocked region survives in the remembered pass", async () => {
    fetchWritebackValidator.mockResolvedValue({
      regionId: "r1",
      validator: null,
      error: "ships no validator code for it",
    });
    await syncWritebackValidators([{ regionId: "r1", customValidator: "positive" }]);
    expect(lastWritebackValidatorSync().blocked).toEqual([
      { regionId: "r1", message: "ships no validator code for it" },
    ]);
  });

  it("reset clears the remembered pass (workbook close / deactivate)", async () => {
    writebackValidatorsConsented.mockResolvedValue(false);
    fetchWritebackValidator.mockResolvedValue({
      regionId: "r1",
      validator: validator("r1"),
      error: null,
    });
    await syncWritebackValidators([{ regionId: "r1", customValidator: "positive" }]);
    expect(lastWritebackValidatorSync().pending).toHaveLength(1);
    resetWritebackValidators();
    expect(lastWritebackValidatorSync()).toEqual({ mounted: [], pending: [], blocked: [] });
  });

  it("names the event the pane subscribes to", () => {
    expect(WRITEBACK_VALIDATORS_CHANGED_EVENT).toBe("distribution:writebackValidatorsChanged");
  });
});
