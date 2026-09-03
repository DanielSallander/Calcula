//! FILENAME: app/src/api/__tests__/customFunctionRealms.test.ts
// PURPOSE: A formula function that arrived inside an application does not mount
//          as the subscriber's own code, and does not run on the subscriber's
//          capability grants.
// CONTEXT: The custom-function library record is MERGED — `merge_custom_function_library`
//          (app/src-tauri/src/calp_commands.rs) folds a .calp's functions into
//          the ONE subscriber-owned record and stamps `sourcePackage` on each one
//          it folds in. The consent gate (customFunctionConsent.test.ts) decides
//          whether that code may run at all. THIS file pins what happens once it
//          may: a realm per trust origin, provenance derived from the stamp, and
//          a script id of its own — because the broker keys grants, the JIT
//          prompt, the persisted-grant store and same-origin trust by that id.
//
//          The sibling libraries that ship distributed code already did this
//          (chartTransformScripts / chartMarkScripts both mount
//          `provenance: "distributed"` with the package name); this one is per
//          FUNCTION because its record is merged per function.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Doubles. `scriptOrigin` is deliberately REAL — it is the derivation under test.
// ---------------------------------------------------------------------------
const hostMountScript = vi.fn(async (_d: unknown) => undefined);
const hostUnmountScript = vi.fn((_id: string) => undefined);
vi.mock("../scriptHost/host", () => ({
  hostMountScript: (d: unknown) => hostMountScript(d),
  hostUnmountScript: (id: string) => hostUnmountScript(id),
}));

const applyConsentedCapabilities = vi.fn(async (..._a: unknown[]) => undefined);
const revokeScriptGrants = vi.fn((_id: string) => undefined);
vi.mock("../scriptHost/capabilities", () => ({
  applyConsentedCapabilities: (...a: unknown[]) => applyConsentedCapabilities(...a),
  revokeScriptGrants: (id: string) => revokeScriptGrants(id),
}));

const releaseLink = vi.fn(() => undefined);
const linkScript = vi.fn(async (_r: unknown) => ({
  prelude: "",
  imports: [] as unknown[],
  release: releaseLink,
}));
vi.mock("../scriptLibraries", () => ({
  linkScript: (r: unknown) => linkScript(r),
}));

interface RegisteredUdf {
  name: string;
  implementation: (...args: unknown[]) => unknown;
}
const registered: RegisteredUdf[] = [];
const registerFunction = vi.fn((def: RegisteredUdf) => {
  registered.push(def);
  return () => {
    const i = registered.findIndex((r) => r === def);
    if (i >= 0) registered.splice(i, 1);
  };
});
vi.mock("../formulaFunctions", () => ({
  registerFunction: (def: RegisteredUdf) => registerFunction(def),
  UDF_ERROR_KEY: "__calculaError",
}));

const callExposedMethod = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../scriptableObjects", () => ({
  callExposedMethod: (...a: unknown[]) => callExposedMethod(...a),
}));

/** Package names whose functions the user has approved. */
const approved = new Set<string>();
vi.mock("../distributedConsent", () => ({
  loadConsents: async () => [],
  // The gate asks "is consent current for this key over this exact source?".
  // The consent STORE's own behaviour is pinned by customFunctionConsent.test.ts;
  // here it is reduced to the answer, so these tests are about the mount.
  isConsentCurrent: async (_c: unknown, key: string) =>
    approved.has(key.replace(/^custom-functions:/, "")),
  recordConsent: async () => undefined,
}));

const emitAppEvent = vi.fn(() => undefined);
vi.mock("../events", () => ({ emitAppEvent: (...a: unknown[]) => emitAppEvent(...(a as [])) }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => undefined }));

import {
  CUSTOM_FUNCTIONS_SCRIPT_ID,
  customFunctionScriptId,
  installCustomFunctions,
  planCustomFunctionRealms,
  uninstallCustomFunctions,
  type CustomFunctionLibrary,
  type CustomFunctionUdf,
} from "../customFunctions";

const mine = (name: string, body = "return x;"): CustomFunctionUdf => ({
  name,
  params: ["x"],
  body,
});

const theirs = (name: string, pkg: string, body = "return x * 2;"): CustomFunctionUdf => ({
  ...mine(name, body),
  sourcePackage: pkg,
  sourceDigest: "deadbeef",
});

/** Every mount definition this install handed the host, in order. */
function mounts(): Array<Record<string, unknown>> {
  return hostMountScript.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

function mountFor(scriptId: string): Record<string, unknown> {
  const found = mounts().find((m) => m.id === scriptId);
  if (!found) throw new Error(`nothing mounted under "${scriptId}"`);
  return found;
}

beforeEach(() => {
  hostMountScript.mockClear().mockResolvedValue(undefined);
  hostUnmountScript.mockClear();
  applyConsentedCapabilities.mockClear();
  revokeScriptGrants.mockClear();
  linkScript.mockClear();
  registerFunction.mockClear();
  callExposedMethod.mockClear();
  releaseLink.mockClear();
  registered.length = 0;
  approved.clear();
});

afterEach(() => {
  uninstallCustomFunctions();
});

// ===========================================================================
describe("planCustomFunctionRealms", () => {
  it("splits the merged record by trust origin, subscriber first", () => {
    const plan = planCustomFunctionRealms({
      functions: [theirs("B", "zeta"), mine("A"), theirs("C", "acme")],
      capabilities: [],
    });
    expect(plan.map((r) => r.packageName)).toEqual(["", "acme", "zeta"]);
    expect(plan.map((r) => r.origin)).toEqual([
      { kind: "local" },
      { kind: "package", name: "acme" },
      { kind: "package", name: "zeta" },
    ]);
  });

  it("gives each realm a script id of its own", () => {
    const plan = planCustomFunctionRealms({
      functions: [mine("A"), theirs("B", "acme")],
      capabilities: [],
    });
    expect(plan[0].scriptId).toBe(CUSTOM_FUNCTIONS_SCRIPT_ID);
    expect(plan[1].scriptId).toBe(customFunctionScriptId("acme"));
    expect(plan[1].scriptId).not.toBe(CUSTOM_FUNCTIONS_SCRIPT_ID);
  });

  it("a realm's source holds ONLY its own functions", () => {
    // The `fns` sibling table is per realm, so a publisher's body cannot call
    // the subscriber's function by name — and cannot be called by one.
    const plan = planCustomFunctionRealms({
      functions: [mine("MINE", "return 1;"), theirs("THEIRS", "acme", "return 2;")],
      capabilities: [],
    });
    expect(plan[0].source).toContain('fns["MINE"]');
    expect(plan[0].source).not.toContain('fns["THEIRS"]');
    expect(plan[1].source).toContain('fns["THEIRS"]');
    expect(plan[1].source).not.toContain('fns["MINE"]');
  });

  it("a blank stamp is nothing stamped — it stays the subscriber's", () => {
    const plan = planCustomFunctionRealms({
      functions: [{ ...mine("A"), sourcePackage: "   " }],
      capabilities: [],
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].origin).toEqual({ kind: "local" });
    expect(plan[0].scriptId).toBe(CUSTOM_FUNCTIONS_SCRIPT_ID);
  });

  it("a publisher who names the application `local` still gets a package realm", () => {
    const plan = planCustomFunctionRealms({
      functions: [theirs("A", "local")],
      capabilities: [],
    });
    expect(plan[0].origin).toEqual({ kind: "package", name: "local" });
    expect(plan[0].scriptId).not.toBe(CUSTOM_FUNCTIONS_SCRIPT_ID);
  });
});

// ===========================================================================
describe("a package's functions mount as the package's", () => {
  const lib: CustomFunctionLibrary = {
    functions: [mine("MINE"), theirs("THEIRS", "vendor-kpis")],
    capabilities: ["bi.query"],
  };

  beforeEach(() => {
    approved.add("vendor-kpis");
  });

  it("mounts one realm per origin, never one shared realm", async () => {
    await installCustomFunctions(lib);
    expect(mounts().map((m) => m.id)).toEqual([
      CUSTOM_FUNCTIONS_SCRIPT_ID,
      customFunctionScriptId("vendor-kpis"),
    ]);
  });

  it("carries DISTRIBUTED provenance and the publisher's name", async () => {
    await installCustomFunctions(lib);
    const pkg = mountFor(customFunctionScriptId("vendor-kpis"));
    // Before the split this definition simply omitted `provenance`, which the
    // handle builder reads as LOCAL — the JIT-prompt path, the local grant
    // store, and same-trust-origin with the user's own scripts.
    expect(pkg.provenance).toBe("distributed");
    expect(pkg.packageName).toBe("vendor-kpis");
    expect(pkg.accessLevel).toBe("restricted");
  });

  it("leaves the subscriber's own realm local, unchanged", async () => {
    await installCustomFunctions(lib);
    const own = mountFor(CUSTOM_FUNCTIONS_SCRIPT_ID);
    expect(own.provenance).toBe("local");
    expect(own.packageName).toBeUndefined();
  });

  it("does not run on the subscriber's grants — its own id, its own consented set", async () => {
    await installCustomFunctions(lib);
    // getGrantSet is keyed by script id, so a distinct id IS the separation.
    expect(applyConsentedCapabilities).toHaveBeenCalledTimes(1);
    expect(applyConsentedCapabilities).toHaveBeenCalledWith(
      customFunctionScriptId("vendor-kpis"),
      ["bi.query"],
      [],
    );
  });

  it("each realm is linked and exposed under its own instance", async () => {
    await installCustomFunctions(lib);
    const own = mountFor(CUSTOM_FUNCTIONS_SCRIPT_ID);
    const pkg = mountFor(customFunctionScriptId("vendor-kpis"));
    expect(own.instanceId).not.toBe(pkg.instanceId);

    // ...and each registered UDF calls into ITS OWN realm, so a formula can
    // never reach a body through another origin's realm.
    const theirsUdf = registered.find((r) => r.name === "THEIRS");
    await theirsUdf?.implementation(1);
    expect(callExposedMethod).toHaveBeenCalledWith("workbook", pkg.instanceId, "THEIRS", 1);

    callExposedMethod.mockClear();
    const mineUdf = registered.find((r) => r.name === "MINE");
    await mineUdf?.implementation(2);
    expect(callExposedMethod).toHaveBeenCalledWith("workbook", own.instanceId, "MINE", 2);
  });

  it("an UNCONSENTED package mounts no realm at all", async () => {
    approved.clear();
    await installCustomFunctions(lib);
    expect(mounts().map((m) => m.id)).toEqual([CUSTOM_FUNCTIONS_SCRIPT_ID]);
    expect(applyConsentedCapabilities).not.toHaveBeenCalled();
    expect(registered.map((r) => r.name)).toEqual(["MINE"]);
  });

  it("tears every realm down, and takes the package's grants with it", async () => {
    await installCustomFunctions(lib);
    hostUnmountScript.mockClear();
    uninstallCustomFunctions();

    expect(hostUnmountScript.mock.calls.map((c) => c[0])).toEqual([
      CUSTOM_FUNCTIONS_SCRIPT_ID,
      customFunctionScriptId("vendor-kpis"),
    ]);
    // The package's grants came from its consent record and are re-derived from
    // it at every install; the SUBSCRIBER's are their own "Always" answers and
    // must survive an ordinary edit-and-reinstall.
    expect(revokeScriptGrants.mock.calls.map((c) => c[0])).toEqual([
      customFunctionScriptId("vendor-kpis"),
    ]);
    expect(releaseLink).toHaveBeenCalledTimes(2);
    expect(registered).toEqual([]);
  });
});

// ===========================================================================
describe("a purely local library is unchanged", () => {
  it("mounts exactly one realm, under the library's own id, as local", async () => {
    await installCustomFunctions({
      functions: [mine("A"), mine("B")],
      capabilities: ["bi.query"],
    });
    expect(mounts()).toHaveLength(1);
    const own = mounts()[0];
    expect(own.id).toBe(CUSTOM_FUNCTIONS_SCRIPT_ID);
    expect(own.provenance).toBe("local");
    expect(own.accessLevel).toBe("restricted");
    expect(own.declaredCapabilities).toEqual(["bi.query"]);
    // No consent replay for code the user wrote: their own realm keeps the
    // just-in-time prompt.
    expect(applyConsentedCapabilities).not.toHaveBeenCalled();
    expect(registered.map((r) => r.name)).toEqual(["A", "B"]);
  });

  it("a failed mount leaves NOTHING half-installed", async () => {
    // Establish this test's own rollback target first.
    await installCustomFunctions({ functions: [mine("KEEP")], capabilities: [] });
    hostMountScript.mockClear();
    hostUnmountScript.mockClear();

    approved.add("acme");
    hostMountScript.mockImplementationOnce(async () => undefined); // the local realm
    hostMountScript.mockImplementationOnce(async () => {
      throw new Error("SyntaxError in the publisher's body");
    });

    await expect(
      installCustomFunctions({
        functions: [mine("A"), theirs("B", "acme")],
        capabilities: [],
      }),
    ).rejects.toThrow(/SyntaxError/);

    // The local realm of the NEW library mounted first. It must not be left
    // standing on its own with half the library's functions silently missing —
    // the install rolls back to the last good library instead.
    expect(registered.map((r) => r.name)).toEqual(["KEEP"]);
    expect(hostUnmountScript).toHaveBeenCalledWith(CUSTOM_FUNCTIONS_SCRIPT_ID);
  });
});
