//! FILENAME: app/src/api/__tests__/customFunctionConsent.test.ts
// PURPOSE: The distributed-package consent gate for formula functions that
//          arrived in a .calp — the hole this suite exists to keep closed is
//          "a package shipped JavaScript and it ran with no prompt".
// CONTEXT: Drives the REAL shared consent store (@api/distributedConsent) over
//          an in-memory virtual filesystem, so the hashing, the source-change
//          re-prompt and the capability-expansion re-prompt are exercised for
//          real rather than stubbed.

import { describe, it, expect, beforeEach, vi } from "vitest";

// The consent store is the only thing that touches the backend here.
const files = new Map<string, string>();
vi.mock("../backend", () => ({
  readVirtualFile: async (path: string) => {
    const v = files.get(path);
    if (v === undefined) throw new Error("not found");
    return v;
  },
  createVirtualFile: async (path: string, content: string) => {
    files.set(path, content);
  },
}));

import {
  gateCustomFunctionLibrary,
  grantCustomFunctionConsent,
  customFunctionConsentKey,
  customFunctionConsentSource,
  CUSTOM_FUNCTIONS_CONSENT_NEEDED,
  type CustomFunctionLibrary,
  type CustomFunctionUdf,
} from "../customFunctions";
import { recordConsent, loadConsents } from "../distributedConsent";

const local = (name: string, body: string): CustomFunctionUdf => ({
  name,
  params: ["x"],
  body,
});

const fromPackage = (
  name: string,
  body: string,
  sourcePackage: string,
): CustomFunctionUdf => ({ ...local(name, body), sourcePackage, sourceDigest: "deadbeef" });

/** Approve a package's current functions exactly as the dialog path does. */
async function approve(lib: CustomFunctionLibrary, pkg: string): Promise<void> {
  const { pending } = await gateCustomFunctionLibrary(lib);
  const p = pending.find((q) => q.packageName === pkg);
  if (!p) throw new Error(`nothing pending for ${pkg}`);
  await recordConsent(
    customFunctionConsentKey(p.packageName),
    [{ id: "__calcula_custom_functions__", source: p.consentSource }],
    p.capabilities.map((capability) => ({ capability })),
  );
}

beforeEach(() => {
  files.clear();
});

describe("custom-function distributed consent gate", () => {
  it("withholds a package's functions until they are approved", async () => {
    const lib: CustomFunctionLibrary = {
      functions: [local("MINE", "return x;"), fromPackage("THEIRS", "return x * 2;", "vendor-kpis")],
      capabilities: ["bi.query"],
    };

    const first = await gateCustomFunctionLibrary(lib);
    // The subscriber's own function still mounts — a package must not be able
    // to disable the user's own work by arriving.
    expect(first.library.functions.map((f) => f.name)).toEqual(["MINE"]);
    expect(first.pending).toHaveLength(1);
    expect(first.pending[0].packageName).toBe("vendor-kpis");
    expect(first.pending[0].functionNames).toEqual(["THEIRS"]);
    // The prompt names what the SHARED realm holds, because that is what
    // approving really hands this code.
    expect(first.pending[0].capabilities).toEqual(["bi.query"]);

    await approve(lib, "vendor-kpis");

    const second = await gateCustomFunctionLibrary(lib);
    expect(second.pending).toEqual([]);
    expect(second.library.functions.map((f) => f.name)).toEqual(["MINE", "THEIRS"]);
  });

  it("a library that is ENTIRELY unconsented package code mounts nothing", async () => {
    const lib: CustomFunctionLibrary = {
      functions: [fromPackage("A", "return 1;", "p"), fromPackage("B", "return 2;", "p")],
      capabilities: [],
    };
    const gated = await gateCustomFunctionLibrary(lib);
    expect(gated.library.functions).toEqual([]);
    expect(gated.pending).toHaveLength(1);
  });

  it("a CHANGED function body re-prompts — an update cannot inherit consent", async () => {
    const lib: CustomFunctionLibrary = {
      functions: [fromPackage("F", "return 1;", "p")],
      capabilities: [],
    };
    await approve(lib, "p");
    expect((await gateCustomFunctionLibrary(lib)).pending).toEqual([]);

    // The publisher ships new code under the same name in a refresh.
    const updated: CustomFunctionLibrary = {
      functions: [fromPackage("F", "return fetchAllTheThings();", "p")],
      capabilities: [],
    };
    const gated = await gateCustomFunctionLibrary(updated);
    expect(gated.pending.map((p) => p.packageName)).toEqual(["p"]);
    expect(gated.library.functions).toEqual([]);
  });

  it("an ADDED function in the same package re-prompts", async () => {
    const lib: CustomFunctionLibrary = {
      functions: [fromPackage("F", "return 1;", "p")],
      capabilities: [],
    };
    await approve(lib, "p");
    const grown: CustomFunctionLibrary = {
      functions: [fromPackage("F", "return 1;", "p"), fromPackage("G", "return 2;", "p")],
      capabilities: [],
    };
    expect((await gateCustomFunctionLibrary(grown)).library.functions).toEqual([]);
  });

  it("WIDENING the shared sandbox re-prompts every package in it", async () => {
    // THE CONFUSED DEPUTY THIS GATE EXISTS FOR. The merged record shares the
    // subscriber's script id and therefore the subscriber's live grants, so a
    // package approved while the sandbox was inert must NOT silently acquire
    // bi.query the day the subscriber grants it for their own function.
    const inert: CustomFunctionLibrary = {
      functions: [fromPackage("F", "return 1;", "p")],
      capabilities: [],
    };
    await approve(inert, "p");
    expect((await gateCustomFunctionLibrary(inert)).pending).toEqual([]);

    const widened: CustomFunctionLibrary = { ...inert, capabilities: ["bi.query", "net.fetch"] };
    const gated = await gateCustomFunctionLibrary(widened);
    expect(gated.library.functions).toEqual([]);
    expect(gated.pending[0].capabilities).toEqual(["bi.query", "net.fetch"]);
  });

  it("consent is PER PACKAGE — a second package cannot ride in on the first's approval", async () => {
    const lib: CustomFunctionLibrary = {
      functions: [fromPackage("A", "return 1;", "good"), fromPackage("B", "return 2;", "evil")],
      capabilities: [],
    };
    await approve(lib, "good");
    const gated = await gateCustomFunctionLibrary(lib);
    expect(gated.library.functions.map((f) => f.name)).toEqual(["A"]);
    expect(gated.pending.map((p) => p.packageName)).toEqual(["evil"]);
  });

  it("consent keys are namespaced so they cannot clobber object-script consent", async () => {
    expect(customFunctionConsentKey("vendor-kpis")).toBe("custom-functions:vendor-kpis");
    // The bare package name is what the object-script flow uses; they must differ.
    expect(customFunctionConsentKey("vendor-kpis")).not.toBe("vendor-kpis");
  });

  it("the consent source carries a capability pragma per granted capability", async () => {
    // This is what makes the shared store's expansion check fire; without the
    // pragmas a widening would change nothing the store compares.
    const src = customFunctionConsentSource([local("F", "return 1;")], ["net.fetch", "bi.query"]);
    expect(src).toContain("// @capability bi.query");
    expect(src).toContain("// @capability net.fetch");
    // Sorted, so the same set in a different order is the same consent.
    expect(src).toBe(customFunctionConsentSource([local("F", "return 1;")], ["bi.query", "net.fetch"]));
  });

  it("the consent hash ignores the provenance keys the backend stamps", async () => {
    // sourceDigest is derived from the code; re-stamping it on a refresh must
    // not look like a code change and re-prompt for nothing.
    const a = customFunctionConsentSource(
      [{ ...local("F", "return 1;"), sourcePackage: "p", sourceDigest: "aaaa" }],
      [],
    );
    const b = customFunctionConsentSource(
      [{ ...local("F", "return 1;"), sourcePackage: "p", sourceDigest: "bbbb" }],
      [],
    );
    expect(a).toBe(b);
  });

  it("function ORDER inside a package does not change the consent", async () => {
    const caps: [] = [];
    const one = customFunctionConsentSource(
      [local("A", "return 1;"), local("B", "return 2;")],
      caps,
    );
    const two = customFunctionConsentSource(
      [local("B", "return 2;"), local("A", "return 1;")],
      caps,
    );
    expect(one).toBe(two);
  });

  it("a purely local library never reads the consent store at all", async () => {
    const lib: CustomFunctionLibrary = {
      functions: [local("A", "return 1;"), local("B", "return 2;")],
      capabilities: ["bi.query"],
    };
    const gated = await gateCustomFunctionLibrary(lib);
    // Same object back — no filtering, no prompt, no behaviour change for the
    // scripts that were here before this gate existed.
    expect(gated.library).toBe(lib);
    expect(gated.pending).toEqual([]);
  });

  it("granting persists a record the store can read back", async () => {
    const lib: CustomFunctionLibrary = {
      functions: [fromPackage("F", "return 1;", "p")],
      capabilities: ["bi.query"],
    };
    const { pending } = await gateCustomFunctionLibrary(lib);
    // grantCustomFunctionConsent also re-runs the install; the install path is
    // exercised by customFunctions.test.ts, so drive the persistence half here.
    await recordConsent(
      customFunctionConsentKey("p"),
      [{ id: "__calcula_custom_functions__", source: pending[0].consentSource }],
      pending[0].capabilities.map((capability) => ({ capability })),
    );
    const records = await loadConsents();
    const rec = records.find((r) => r.packageName === "custom-functions:p");
    expect(rec).toBeDefined();
    expect(rec?.grantedCapabilities.map((g) => g.capability)).toEqual(["bi.query"]);
    // The approved SOURCE is retained, so a later change can be shown as a diff.
    expect(rec?.scripts[0].source).toBe(pending[0].consentSource);
  });

  it("exports the event name the extension listens on", () => {
    expect(CUSTOM_FUNCTIONS_CONSENT_NEEDED).toBe("customfunctions:consent-needed");
    expect(typeof grantCustomFunctionConsent).toBe("function");
  });
});
