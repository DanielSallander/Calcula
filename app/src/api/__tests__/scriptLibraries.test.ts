//! FILENAME: app/src/api/__tests__/scriptLibraries.test.ts
// PURPOSE: The contract tests for shared script libraries (@api/scriptLibraries).
// CONTEXT: docs/design/script-package-manager.md §8. The confused-deputy test is
//          the most important one in the file: a library MUST NOT be able to
//          widen its consumer's capability ceiling.
//
// FIDELITY NOTE — why these are not shallow mocks. ONLY `hostMountScript` and
// `hostUnmountScript` are replaced (jsdom has no Worker); everything else in
// scriptHost/host.ts is the REAL module, including the caller-identity import
// table and `authorizeImportCall`. The fake mount does what the real worker host
// does: builds the handle with `buildHandleFromDefinition` (the REAL broker
// function, so the R19 ceiling is the real one) and EXECUTES the generated
// source with a context whose `expose`/`callMethod`/`callImport` route through
// the REAL broker and the REAL host authorization. So the identity gate, the
// per-call grant capping, the export routing, the host-only-namespace rule and
// the ceiling denial are all exercised for real; only the Worker boundary and
// the Rust backend are stubbed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { webcrypto } from "node:crypto";

// jsdom has no WebCrypto subtle digest; sha256Hex (consent + lockfile identity)
// needs it, and the linker needs getRandomValues.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

// ---------------------------------------------------------------------------
// In-memory workbook virtual filesystem + backend stub
// ---------------------------------------------------------------------------

const vfs = new Map<string, string>();
const invokeBackend = vi.fn(async (cmd: string) => {
  if (cmd === "library_resolve") return [];
  return undefined;
});

vi.mock("../backend", () => ({
  invokeBackend: (...a: unknown[]) => invokeBackend(...(a as [string])),
  readVirtualFile: async (p: string) => {
    if (!vfs.has(p)) throw new Error(`no such file: ${p}`);
    return vfs.get(p)!;
  },
  createVirtualFile: async (p: string, c = "") => {
    vfs.set(p, c);
  },
  deleteVirtualFile: async (p: string) => {
    vfs.delete(p);
  },
  listVirtualFiles: async () => [...vfs.keys()].map((path) => ({ path })),
}));

// ---------------------------------------------------------------------------
// Fake worker host: real handle, real broker registration, real execution
// ---------------------------------------------------------------------------

import {
  buildHandleFromDefinition,
  registerExposed,
  callExposed,
  clearExposed,
  hostCallExposed,
  brokerCall,
  BrokerError,
  HOST_ONLY_EXPOSED_PREFIX,
  type ScriptHandle,
} from "../scriptHost/broker";

interface FakeRealm {
  handle: ScriptHandle;
  definition: Record<string, unknown>;
  cleanups: Array<() => void>;
}

const realms = new Map<string, FakeRealm>();
const mountSpecs: Array<Record<string, unknown>> = [];

/**
 * The context a mounted script sees. Mirrors the real shims' relevant members.
 *
 * `callImport` is the load-bearing one: it does exactly what host.ts's
 * `base.callImport` executor does — resolve + authorize against the REAL host
 * import table keyed by this handle's scriptId, then dispatch through
 * `hostCallExposed`. Nothing about which realm is reached, or whether the call
 * is allowed, comes from this test's own bookkeeping.
 */
function makeContext(handle: ScriptHandle, cleanups: Array<() => void>): Record<string, unknown> {
  return {
    expose(name: string, fn: (...a: unknown[]) => unknown, opts?: { public?: boolean }) {
      cleanups.push(registerExposed(handle, name, fn, opts?.public === true));
    },
    callMethod(targetType: string, instanceId: string | null, method: string, ...args: unknown[]) {
      return callExposed(handle, targetType, instanceId, method, args);
    },
    async callImport(alias: string, methodName: string, args: unknown[]) {
      const binding = await authorizeImportCall({
        handle,
        consumerSource: String(sourcesByScriptId.get(handle.scriptId) ?? ""),
        alias,
        methodName,
      });
      if (!realms.has(binding.libraryScriptId)) {
        throw new BrokerError("HostError", `Library ${binding.package} is no longer mounted`);
      }
      return await hostCallExposed(binding.objectType, binding.instanceId, binding.entryMethod, [
        methodName,
        Array.isArray(args) ? args : [],
      ]);
    },
    log() {},
  };
}

/** scriptId -> source, so the fake callImport can bind an "always" grant to the
 *  consumer's source exactly as the real executor does. */
const sourcesByScriptId = new Map<string, string>();

function runSource(source: string, context: unknown): void {
  // Same shape as worker/bootstrap.ts's compile wrapper.
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "context",
    `${source}\n; return typeof setup === "function" ? setup(context) : undefined;`,
  );
  fn(context);
}

const hostMountScript = vi.fn(async (definition: Record<string, unknown>) => {
  mountSpecs.push(definition);
  const handle = buildHandleFromDefinition(definition as never);
  const cleanups: Array<() => void> = [];
  sourcesByScriptId.set(definition.id as string, String(definition.source ?? ""));
  runSource(definition.source as string, makeContext(handle, cleanups));
  realms.set(definition.id as string, { handle, definition, cleanups });
});

const hostUnmountScript = vi.fn((id: string) => {
  const realm = realms.get(id);
  if (!realm) return;
  for (const c of realm.cleanups) c();
  realms.delete(id);
});

// PARTIAL mock: only the two Worker-spawning entry points are faked. The import
// table, authorizeImportCall and the per-call grant gate are the real thing.
vi.mock("../scriptHost/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scriptHost/host")>();
  return {
    ...actual,
    hostMountScript: (d: Record<string, unknown>) => hostMountScript(d),
    hostUnmountScript: (id: string) => hostUnmountScript(id),
    hostResetAll: () => undefined,
  };
});

// Grants are the Rust store's business; here we only need them to land in the
// live in-memory set so the broker's grant check passes for CEILING-allowed caps.
vi.mock("../scriptHost/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scriptHost/capabilities")>();
  return {
    ...actual,
    applyConsentedCapabilities: async (scriptId: string, caps: string[]) => {
      for (const c of caps) actual.recordCapabilityGrant(scriptId, c as never);
    },
    restoreAndSyncGrants: async () => undefined,
  };
});

import {
  authorizeImportCall,
  listScriptImports,
  registerScriptImports,
  resetScriptImports,
} from "../scriptHost/host";
import {
  recordCapabilityGrant,
  resetAllGrants,
  resolveCapabilityRequest,
  type CapabilityDecision,
  type CapabilityRequestPayload,
} from "../scriptHost/capabilities";
import { onAppEvent } from "../events";
import {
  parseUses,
  parseExports,
  parseModulePragmas,
  intersectCeiling,
  chainCeiling,
  minTier,
  linkScript,
  listLibraryRealms,
  resetScriptLibraryRealms,
  generateLibraryRealmSource,
  generatePrelude,
  generateImportsTypings,
  commitLockedLibraries,
  loadLockfile,
  removeLockedLibrary,
  consentKeyFor,
  LibraryLinkError,
  type LockedLibrary,
} from "../scriptLibraries";
import { recordConsent, sha256Hex } from "../distributedConsent";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STATS_SOURCE = [
  "// @export mean",
  "// @export scale",
  "function library(context) {",
  "  return {",
  "    mean: (values) => values.reduce((a, b) => a + b, 0) / values.length,",
  "    scale: (values, k) => values.map((v) => v * k),",
  "  };",
  "}",
].join("\n");

/** A library that WANTS the network. The confused-deputy fixture. */
const HTTP_SOURCE = [
  "// @capability net.fetch",
  "// @export post",
  "function library(context) {",
  "  return { post: async (url, body) => await context.caps.net.fetch(url, body) };",
  "}",
].join("\n");

async function installLibrary(opts: {
  pkg: string;
  version: string;
  pin?: string;
  modules: Array<{ id: string; source: string }>;
  uses?: LockedLibrary["uses"];
  requiredBy?: string[];
}): Promise<void> {
  const sources = new Map<string, string>();
  const modules = [];
  for (const m of opts.modules) {
    const hash = await sha256Hex(m.source);
    sources.set(hash, m.source);
    const pragmas = parseModulePragmas(m.source).pragmas;
    modules.push({
      id: m.id,
      name: m.id,
      sourceHash: hash,
      artifactSha256: hash,
      exports: pragmas.exports,
      capabilities: pragmas.capabilities,
      netOrigins: pragmas.netOrigins,
    });
  }
  await commitLockedLibraries(
    [
      {
        package: opts.pkg,
        pin: opts.pin ?? `^${opts.version}`,
        resolved: opts.version,
        registry: "C:/registry",
        publisherKey: "aa".repeat(32),
        publisherName: "Test Publisher",
        modules,
        uses: opts.uses ?? [],
        requiredBy: opts.requiredBy ?? [],
        installedAt: new Date().toISOString(),
      },
    ],
    sources,
  );
  await recordConsent(
    consentKeyFor(opts.pkg),
    opts.modules.map((m) => ({ id: m.id, source: m.source })),
    modules.flatMap((m) => m.capabilities).map((capability) => ({ capability })),
  );
}

/**
 * The JIT capability dialog, standing in for the user.
 *
 * The prompts a consumer receives ARE the security-relevant output of half this
 * file, so they are recorded rather than silently absorbed: `promptLog` is what
 * the user was actually asked, and `promptAnswer` is what they said. A test that
 * asserts "no prompt" and a test that asserts "prompted, and denying stops the
 * call" both read this.
 */
const promptLog: CapabilityRequestPayload[] = [];
let promptAnswer: CapabilityDecision = "once";
onAppEvent("scriptable-objects:capability-request", (detail) => {
  const payload = detail as unknown as CapabilityRequestPayload;
  promptLog.push(payload);
  // Async, like a real dialog: the host must be awaiting, not spinning.
  setTimeout(() => resolveCapabilityRequest(payload.requestId, promptAnswer), 0);
});

/** Mount a consumer script the way ObjectScriptManager does: link, then run the
 *  prelude + source in a realm, and return its evaluated `imports` binding. */
async function mountConsumer(opts: {
  id: string;
  source: string;
  capabilities?: string[];
  netOrigins?: string[];
  tier?: "restricted" | "unlocked";
  provenance?: string;
  packageName?: string;
}): Promise<{ handle: ScriptHandle; imports: Record<string, Record<string, (...a: unknown[]) => unknown>>; release: () => void }> {
  const link = await linkScript({
    scriptId: opts.id,
    scriptName: opts.id,
    source: opts.source,
    declaredCapabilities: (opts.capabilities ?? []) as never,
    declaredNetOrigins: opts.netOrigins,
    accessLevel: opts.tier ?? "restricted",
  });
  const handle = buildHandleFromDefinition({
    id: opts.id,
    name: opts.id,
    objectType: "workbook",
    instanceId: opts.id,
    accessLevel: opts.tier ?? "restricted",
    provenance: opts.provenance,
    packageName: opts.packageName,
    declaredCapabilities: opts.capabilities ?? [],
  });
  sourcesByScriptId.set(opts.id, opts.source);
  const cleanups: Array<() => void> = [];
  const context = makeContext(handle, cleanups);
  // eslint-disable-next-line no-new-func
  const fn = new Function("context", `${link.prelude}${opts.source}\n; return imports;`);
  const imports = fn(context);
  return { handle, imports, release: link.release };
}

beforeEach(() => {
  vfs.clear();
  realms.clear();
  mountSpecs.length = 0;
  sourcesByScriptId.clear();
  promptLog.length = 0;
  promptAnswer = "once";
  clearExposed();
  resetScriptLibraryRealms();
  resetScriptImports();
  resetAllGrants();
  hostMountScript.mockClear();
  hostUnmountScript.mockClear();
});

// ===========================================================================
// 1. Pragma dialect
// ===========================================================================

describe("// @uses pragma", () => {
  it("parses alias, package and pin, and the -isolated modifier", () => {
    const { uses, errors } = parseUses(
      ["// @uses stats acme.stats@^1.2.0", "// @uses-isolated vault acme.vault@2.0.1"].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(uses).toEqual([
      { alias: "stats", package: "acme.stats", pin: "^1.2.0", isolated: false },
      { alias: "vault", package: "acme.vault", pin: "2.0.1", isolated: true },
    ]);
  });

  it("reports a duplicate alias instead of silently picking one", () => {
    const { uses, errors } = parseUses(
      ["// @uses s a.one@1.0.0", "// @uses s a.two@1.0.0"].join("\n"),
    );
    expect(uses).toHaveLength(1);
    expect(errors.join()).toMatch(/declared more than once/);
  });

  it("reports a malformed pin and a non-identifier alias", () => {
    expect(parseUses("// @uses s acme.stats@not-a-version").errors.join()).toMatch(
      /not a valid version pin/,
    );
    expect(parseUses("// @uses 9bad acme.stats@1.0.0").errors.join()).toMatch(/not a valid alias/);
    expect(parseUses("// @uses s acme.stats").errors.join()).toMatch(/not a <package>@<pin>/);
  });

  it("rejects an alias that would shadow the generated binding", () => {
    expect(parseUses("// @uses imports acme.stats@1.0.0").errors.join()).toMatch(/reserved/);
  });

  it("is line-anchored, NOT JS-aware: a pragma inside a template literal matches", () => {
    // Documented behaviour, identical to the existing @capability parser. It is
    // safe by construction: a pragma can only REQUEST a link, and every link is
    // resolved against the lockfile and intersected down to the consumer's
    // ceiling — so a smuggled pragma can make a mount FAIL, never reach further.
    const src = ["const doc = `", "// @uses smuggled acme.evil@1.0.0", "`;"].join("\n");
    expect(parseUses(src).uses).toEqual([
      { alias: "smuggled", package: "acme.evil", pin: "1.0.0", isolated: false },
    ]);
  });

  it("parses // @export names and the module's own capabilities", () => {
    expect(parseExports(STATS_SOURCE).exports).toEqual(["mean", "scale"]);
    expect(parseModulePragmas(HTTP_SOURCE).pragmas.capabilities).toEqual(["net.fetch"]);
  });
});

// ===========================================================================
// 2. Ceiling arithmetic
// ===========================================================================

describe("effective ceiling", () => {
  it("is the intersection, and reports what was narrowed away", () => {
    const e = intersectCeiling(["net.fetch", "bi.query"], {
      capabilities: ["bi.query", "storage"],
      tier: "restricted",
    });
    expect(e.capabilities).toEqual(["bi.query"]);
    expect(e.narrowed).toEqual(["net.fetch"]);
  });

  it("takes min() of the tiers", () => {
    expect(minTier("unlocked", "restricted")).toBe("restricted");
    expect(minTier("unlocked", "unlocked")).toBe("unlocked");
    expect(intersectCeiling([], { capabilities: [], tier: "restricted" }, "unlocked").tier).toBe(
      "restricted",
    );
  });

  it("chains transitively: a depth-2 dep cannot re-widen what its parent gave up", () => {
    const parent = intersectCeiling(["net.fetch", "bi.query"], {
      capabilities: ["bi.query"],
      tier: "restricted",
    });
    // The grandchild declares net.fetch. Chained against the PARENT's effective
    // set (not the root consumer's declaration) it still cannot get it.
    const child = chainCeiling(["net.fetch", "bi.query"], parent);
    expect(child.capabilities).toEqual(["bi.query"]);
    expect(child.narrowed).toEqual(["net.fetch"]);
  });

  it("gives consumers with equal effective ceilings the same dedup key", () => {
    const a = intersectCeiling(["bi.query"], { capabilities: ["bi.query", "storage"], tier: "restricted" });
    const b = intersectCeiling(["bi.query"], { capabilities: ["bi.query"], tier: "restricted" });
    const c = intersectCeiling(["bi.query"], { capabilities: [], tier: "restricted" });
    expect(a.key).toBe(b.key);
    expect(c.key).not.toBe(a.key);
  });
});

// ===========================================================================
// 3. Linking: the happy path
// ===========================================================================

describe("linking a declared library", () => {
  it("mounts the library and lets the consumer call a declared export", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });

    const consumer = await mountConsumer({
      id: "script-a",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });

    await expect(consumer.imports.stats.mean([1, 2, 3])).resolves.toBe(2);
    await expect(consumer.imports.stats.scale([1, 2], 3)).resolves.toEqual([3, 6]);
  });

  it("errors clearly on a property the library did not // @export", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const consumer = await mountConsumer({
      id: "script-a",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    expect(() => consumer.imports.stats.median).toThrow(/does not export 'median'/);
  });

  it("errors clearly on an alias the script did not declare", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const consumer = await mountConsumer({
      id: "script-a",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    expect(() => consumer.imports.other).toThrow(/did not declare a library aliased 'other'/);
  });

  it("shares one realm between consumers at the same effective ceiling", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    await mountConsumer({
      id: "a",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    await mountConsumer({
      id: "b",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    expect(listLibraryRealms()).toHaveLength(1);
    expect(listLibraryRealms()[0].consumers.sort()).toEqual(["a", "b"]);
  });

  it("gives a DIFFERENT realm to a consumer with a different effective ceiling", async () => {
    await installLibrary({
      pkg: "acme.http",
      version: "1.0.0",
      modules: [{ id: "http", source: HTTP_SOURCE }],
    });
    await mountConsumer({
      id: "with-net",
      source: "// @uses h acme.http@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["net.fetch"],
    });
    await mountConsumer({
      id: "without-net",
      source: "// @uses h acme.http@^1.0.0\nfunction setup(context) {}\n",
    });
    expect(listLibraryRealms()).toHaveLength(2);
  });

  it("// @uses-isolated forces a private realm even at an identical ceiling", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    await mountConsumer({
      id: "a",
      source: "// @uses-isolated stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    await mountConsumer({
      id: "b",
      source: "// @uses-isolated stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    expect(listLibraryRealms()).toHaveLength(2);
  });

  it("unmounts the realm when its last consumer releases", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const a = await mountConsumer({
      id: "a",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    const b = await mountConsumer({
      id: "b",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    a.release();
    expect(listLibraryRealms()).toHaveLength(1);
    b.release();
    expect(listLibraryRealms()).toHaveLength(0);
  });
});

// ===========================================================================
// 4. THE LOAD-BEARING TEST: a library cannot widen its consumer
// ===========================================================================

describe("a library can NEVER widen its consumer's ceiling", () => {
  it("mounts the library WITHOUT a capability the consumer did not declare", async () => {
    await installLibrary({
      pkg: "acme.http",
      version: "1.0.0",
      modules: [{ id: "http", source: HTTP_SOURCE }],
    });

    // The consumer declares NOTHING. The library declares net.fetch.
    await mountConsumer({
      id: "innocent",
      source: "// @uses h acme.http@^1.0.0\nfunction setup(context) {}\n",
    });

    const realmSpec = mountSpecs.find((s) => String(s.name).startsWith("Library acme.http"));
    expect(realmSpec).toBeDefined();
    expect(realmSpec!.declaredCapabilities).toEqual([]);
    expect(realmSpec!.provenance).toBe("distributed");
    expect(realmSpec!.packageName).toBe("acme.http");
  });

  it("and the BROKER denies the library's fetch with PermissionDenied naming net.fetch", async () => {
    await installLibrary({
      pkg: "acme.http",
      version: "1.0.0",
      modules: [{ id: "http", source: HTTP_SOURCE }],
    });
    await mountConsumer({
      id: "innocent",
      source: "// @uses h acme.http@^1.0.0\nfunction setup(context) {}\n",
    });

    const realmId = listLibraryRealms()[0].scriptId;
    const realmHandle = realms.get(realmId)!.handle;
    // Even though the library declared net.fetch AND we pre-grant it, the R19
    // ceiling handed to buildHandleFromDefinition is the INTERSECTION — so the
    // call is denied before the grant check and is never JIT-promptable.
    realmHandle.grants.add?.("net.fetch" as never);
    await expect(
      brokerCall(realmHandle, "cap.fetch", ["https://evil.example/x", {}], async () => "leaked"),
    ).rejects.toMatchObject({
      name: "BrokerError",
      code: "PermissionDenied",
      capability: "net.fetch",
    });
  });

  it("but a consumer that DID declare net.fetch gets a library realm that has it", async () => {
    await installLibrary({
      pkg: "acme.http",
      version: "1.0.0",
      modules: [{ id: "http", source: HTTP_SOURCE }],
    });
    await mountConsumer({
      id: "declares-net",
      source: "// @uses h acme.http@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["net.fetch"],
    });
    const realmSpec = mountSpecs.find((s) => String(s.name).startsWith("Library acme.http"));
    expect(realmSpec!.declaredCapabilities).toEqual(["net.fetch"]);
  });

  it("surfaces the narrowing instead of leaving a mystery runtime error", async () => {
    await installLibrary({
      pkg: "acme.http",
      version: "1.0.0",
      modules: [{ id: "http", source: HTTP_SOURCE }],
    });
    const link = await linkScript({
      scriptId: "innocent",
      scriptName: "innocent",
      source: "// @uses h acme.http@^1.0.0\nfunction setup(context) {}\n",
      declaredCapabilities: [],
      accessLevel: "restricted",
    });
    expect(link.imports[0].narrowedCapabilities).toEqual(["net.fetch"]);
    expect(link.imports[0].effectiveCapabilities).toEqual([]);
  });

  it("caps a library realm's tier at the consumer's tier", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    await mountConsumer({
      id: "restricted-consumer",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
      tier: "restricted",
    });
    const spec = mountSpecs.find((s) => String(s.name).startsWith("Library acme.stats"));
    expect(spec!.accessLevel).toBe("restricted");
  });
});

// ===========================================================================
// 5. AUTHORITY IS CALLER IDENTITY — there is no credential to steal
//
//    These are the tests for the first of Wave H's two named residuals. The old
//    scheme authorized on possession of a 128-bit token baked into the
//    consumer's prelude; a consumer that leaked it delegated its whole library
//    reach undetectably. The token is gone. What replaced it is a HOST-side map
//    keyed by the calling script's mount id, so the questions below are all
//    variations of "can anything other than being the importer get you in?".
// ===========================================================================

describe("a script that did not declare the import cannot call the library", () => {
  async function installStats(): Promise<void> {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
  }

  const intruderHandle = (): ScriptHandle =>
    buildHandleFromDefinition({
      id: "intruder",
      name: "intruder",
      objectType: "workbook",
      instanceId: "intruder",
      accessLevel: "restricted",
      declaredCapabilities: [],
    });

  it("THE LEAKED-CREDENTIAL TEST: there is no token in the prelude to leak", async () => {
    await installStats();
    const link = await linkScript({
      scriptId: "importer",
      scriptName: "importer",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
      declaredCapabilities: [],
      accessLevel: "restricted",
    });
    // The prelude is injected INTO the consumer's realm, so anything in it is
    // readable by (and forwardable from) the consumer's own code. It must
    // therefore contain nothing whose disclosure grants anything: no realm
    // address, no credential — only the alias and the declared export names,
    // both of which the script's own source already states.
    const realmInstanceId = mountSpecs.find((s) => String(s.name).startsWith("Library acme.stats"))!
      .instanceId as string;
    expect(link.prelude).not.toContain(realmInstanceId);
    expect(link.prelude).not.toMatch(/[0-9a-f]{32}/);
    expect(link.prelude).toContain("callImport");
  });

  it("even holding the realm's address, a non-importer is refused at the broker", async () => {
    await installStats();
    await mountConsumer({
      id: "importer",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    const instanceId = mountSpecs.find((s) => String(s.name).startsWith("Library acme.stats"))!
      .instanceId as string;

    // The strongest form of the old attack: the intruder KNOWS the realm's
    // instance id (say the importer told it) and calls the entry point directly.
    await expect(
      callExposed(intruderHandle(), "workbook", instanceId, `${HOST_ONLY_EXPOSED_PREFIX}callImport`, [
        "mean",
        [[1, 2, 3]],
      ]),
    ).rejects.toMatchObject({ name: "BrokerError", code: "PermissionDenied" });
  });

  it("the host-only namespace is refused identically for a name that does not exist", async () => {
    // The refusal must not be a probe: "no such method" and "not yours to call"
    // have to be the same observation, or the rule enumerates host relays.
    await expect(
      callExposed(intruderHandle(), "workbook", "nope", `${HOST_ONLY_EXPOSED_PREFIX}whatever`, []),
    ).rejects.toMatchObject({ name: "BrokerError", code: "PermissionDenied" });
  });

  it("a SAME-PACKAGE distributed script is refused too (public:false alone would not)", async () => {
    // A library realm's trust origin is its package name. A distributed script
    // shipped in that same package is same-tier + same-origin with the realm, so
    // the ordinary non-public rule would have let it straight in, jumping over
    // the host's identity check. The host-only prefix is what closes this.
    await installStats();
    await mountConsumer({
      id: "importer",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    const instanceId = mountSpecs.find((s) => String(s.name).startsWith("Library acme.stats"))!
      .instanceId as string;
    const sibling = buildHandleFromDefinition({
      id: "sibling",
      name: "sibling",
      objectType: "workbook",
      instanceId: "sibling",
      accessLevel: "restricted",
      provenance: "distributed",
      packageName: "acme.stats",
      declaredCapabilities: [],
    });
    await expect(
      callExposed(sibling, "workbook", instanceId, `${HOST_ONLY_EXPOSED_PREFIX}callImport`, [
        "mean",
        [[1, 2, 3]],
      ]),
    ).rejects.toMatchObject({ name: "BrokerError", code: "PermissionDenied" });
  });

  it("knowing another script's ALIAS gets a peer nothing — its own table is consulted", async () => {
    await installStats();
    await mountConsumer({
      id: "importer",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    // "stats" is a live alias — for the IMPORTER. Resolution is keyed by the
    // caller's id, so it means nothing to anyone else.
    await expect(
      authorizeImportCall({
        handle: intruderHandle(),
        consumerSource: "",
        alias: "stats",
        methodName: "mean",
      }),
    ).rejects.toMatchObject({ name: "BrokerError", code: "PermissionDenied" });
    await expect(
      authorizeImportCall({
        handle: intruderHandle(),
        consumerSource: "",
        alias: "stats",
        methodName: "mean",
      }),
    ).rejects.toThrow(/did not declare a library aliased 'stats'/);
  });

  it("an undeclared export is refused host-side, before the realm is reached", async () => {
    await installStats();
    const consumer = await mountConsumer({
      id: "importer",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    await expect(
      authorizeImportCall({
        handle: consumer.handle,
        consumerSource: "",
        alias: "stats",
        methodName: "constructor",
      }),
    ).rejects.toThrow(/is not an export of acme\.stats@1\.2\.4/);
  });

  it("tracks BOTH aliases when one script binds the same package twice", async () => {
    // Two aliases resolve to one realm. If the second link overwrote the first
    // instead of joining it, releasing once would unmount a realm the other
    // alias was still using (or the realm would leak after both were gone).
    await installStats();
    const consumer = await mountConsumer({
      id: "twice",
      source:
        "// @uses one acme.stats@^1.2.4\n// @uses two acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    await expect(consumer.imports.one.mean([2, 4])).resolves.toBe(3);
    await expect(consumer.imports.two.mean([2, 4])).resolves.toBe(3);
    expect(listLibraryRealms()).toHaveLength(1);
    expect(listScriptImports("twice").map((b) => b.alias).sort()).toEqual(["one", "two"]);

    consumer.release();
    expect(listLibraryRealms()).toHaveLength(0);
    expect(listScriptImports("twice")).toEqual([]);
  });

  it("release revokes the TABLE, so a released consumer stops working immediately", async () => {
    await installStats();
    const a = await mountConsumer({
      id: "a",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    const b = await mountConsumer({
      id: "b",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
    });
    await expect(a.imports.stats.mean([2, 4])).resolves.toBe(3);
    a.release();
    // b still holds the realm, so it is still mounted and still works. a is
    // refused by the HOST — not by anything inside the realm, which is what
    // makes revocation survive a realm that is hung, crashed or tampered with.
    await expect(b.imports.stats.mean([2, 4])).resolves.toBe(3);
    expect(listScriptImports("a")).toEqual([]);
    await expect(a.imports.stats.mean([2, 4])).rejects.toThrow(
      /did not declare a library aliased 'stats'/,
    );
  });
});

// ===========================================================================
// 6. Lockfile: pinning, drift, missing dependency, integrity
// ===========================================================================

describe("lockfile", () => {
  it("fails the mount when the declared library is not installed", async () => {
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "My Script",
        source: "// @uses stats acme.stats@^1.0.0\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toMatchObject({ name: "LibraryLinkError", reason: "unresolved-alias" });
  });

  it("names the missing package in the error", async () => {
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "My Script",
        source: "// @uses stats acme.stats@^1.0.0\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toThrow(/"acme\.stats" is not installed in this workbook/);
  });

  it("refuses to silently substitute a different pin", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      pin: "^1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "My Script",
        source: "// @uses stats acme.stats@^2.0.0\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toMatchObject({ name: "LibraryLinkError", reason: "version-drift" });
  });

  it("binds the LOCKED version, not whatever a registry would resolve now", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const link = await linkScript({
      scriptId: "s",
      scriptName: "s",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
      declaredCapabilities: [],
      accessLevel: "restricted",
    });
    expect(link.imports[0].resolvedVersion).toBe("1.2.4");
    // Nothing consulted the registry during a mount.
    expect(invokeBackend).not.toHaveBeenCalledWith("library_resolve", expect.anything());
  });

  it("refuses a cached source that no longer matches its hash", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    // Tamper with the workbook outside Calcula.
    const lock = await loadLockfile();
    const hash = lock.libraries[0].modules[0].sourceHash;
    vfs.set(`.calcula/script-libs/${hash}.js`, STATS_SOURCE + "\n// evil");
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "s",
        source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toMatchObject({ name: "LibraryLinkError", reason: "integrity" });
  });

  it("stops the mount when consent for the library has lapsed", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    // Simulate an upstream source change that was never re-approved: the
    // lockfile + cache move, the consent record does not.
    const newSource = STATS_SOURCE + "\n// v2";
    const newHash = await sha256Hex(newSource);
    const lock = await loadLockfile();
    lock.libraries[0].modules[0].sourceHash = newHash;
    vfs.set(".calcula/script-deps.json", JSON.stringify(lock));
    vfs.set(`.calcula/script-libs/${newHash}.js`, newSource);

    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "s",
        source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toMatchObject({ name: "LibraryLinkError", reason: "consent-required" });
  });

  it("removing a package also drops the transitive nodes only it required", async () => {
    await installLibrary({
      pkg: "acme.fmt",
      version: "1.0.1",
      modules: [{ id: "fmt", source: STATS_SOURCE }],
      requiredBy: ["acme.stats"],
    });
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    expect((await loadLockfile()).libraries).toHaveLength(2);
    const left = await removeLockedLibrary("acme.stats");
    expect(left).toHaveLength(0);
  });
});

// ===========================================================================
// 7. Generated code shape
// ===========================================================================

describe("generated sources", () => {
  it("routes ONLY declared exports, through a host-only NON-public entry point", () => {
    const src = generateLibraryRealmSource([
      { id: "m", exports: ["mean"], source: STATS_SOURCE },
    ]);
    expect(src).toContain(`context.expose("${HOST_ONLY_EXPOSED_PREFIX}callImport"`);
    // Both halves matter: `public: false` keeps peers out, and the host-only
    // NAME keeps SAME-ORIGIN peers out, which public:false alone would not.
    expect(src).toContain("{ public: false }");
    expect(src).not.toContain("public: true");
    expect(src).toContain('exports: ["mean"]');
    // The retired token machinery must be gone, not merely unused: a dormant
    // `__addToken` is a second door with no host-side authorization in front.
    expect(src).not.toContain("__addToken");
    expect(src).not.toContain("__revokeToken");
    expect(src).not.toContain("tokenOk");
  });

  it("emits the prelude as a SINGLE line so user line numbers do not shift", () => {
    const prelude = generatePrelude([{ alias: "s", package: "acme.stats", exports: ["mean"] }]);
    expect(prelude.trimEnd().split("\n")).toHaveLength(1);
    expect(prelude.endsWith("\n")).toBe(true);
  });

  it("puts no realm address and no credential in the prelude", () => {
    const prelude = generatePrelude([{ alias: "s", package: "acme.stats", exports: ["mean"] }]);
    expect(prelude).toContain("c.callImport(s.a, n,");
    expect(prelude).not.toContain("callMethod");
    expect(prelude).not.toContain("__lib_");
  });

  it("emits nothing at all for a script with no imports", () => {
    expect(generatePrelude([])).toBe("");
  });

  it("types the imports binding from the LOCKFILE, export by export", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const dts = await generateImportsTypings("// @uses stats acme.stats@^1.2.4\n");
    expect(dts).toContain("declare const imports");
    expect(dts).toContain("readonly stats: {");
    expect(dts).toContain("readonly mean: (...args: any[]) => Promise<any>;");
    expect(dts).toContain("readonly scale: (...args: any[]) => Promise<any>;");
    expect(dts).not.toContain("median");
  });

  it("types a NOT-INSTALLED alias as never, so the editor shows it before the mount does", async () => {
    const dts = await generateImportsTypings("// @uses missing acme.gone@^1.0.0\n");
    expect(dts).toContain("readonly missing: never;");
    expect(dts).toContain("NOT INSTALLED");
  });

  it("emits no typings for a script with no imports", async () => {
    expect(await generateImportsTypings("function setup(context) {}\n")).toBe("");
  });
});

// ===========================================================================
// 8. Malformed declarations fail the mount
// ===========================================================================

describe("malformed declarations", () => {
  it("throws LibraryLinkError('malformed') rather than ignoring the pragma", async () => {
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "s",
        source: "// @uses s acme.stats@nope\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toBeInstanceOf(LibraryLinkError);
  });

  it("refuses a package whose modules export the same name twice", async () => {
    await installLibrary({
      pkg: "acme.dup",
      version: "1.0.0",
      modules: [
        { id: "a", source: STATS_SOURCE },
        { id: "b", source: STATS_SOURCE },
      ],
    });
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "s",
        source: "// @uses d acme.dup@^1.0.0\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toThrow(/both export 'mean'/);
  });
});

// ===========================================================================
// 9. TRANSITIVE dependencies — a library's own `// @uses`
//
//    `resolveClosure` installs, consents and locks a whole dependency graph, so
//    the LINKER has to be able to run one. These tests pin the two things that
//    make a transitive link safe rather than merely working: the ceiling is
//    chained against the PARENT (never re-widened against the root consumer),
//    and the dependency realm is refcounted against the parent realm so it
//    cannot outlive it.
// ===========================================================================

/** A leaf library that wants BOTH capabilities. */
const LEAF_SOURCE = [
  "// @capability net.fetch",
  "// @capability bi.query",
  "// @export leafCall",
  "function library(context) {",
  "  return { leafCall: () => 'leaf' };",
  "}",
].join("\n");

/** A middle library that declares only bi.query and re-exports the leaf. */
const MIDDLE_SOURCE = [
  "// @capability bi.query",
  "// @uses leaf acme.leaf@^1.0.0",
  "// @export middleCall",
  "function library(context) {",
  "  return { middleCall: async () => await imports.leaf.leafCall() };",
  "}",
].join("\n");

describe("transitive library dependencies", () => {
  async function installChain(): Promise<void> {
    await installLibrary({
      pkg: "acme.leaf",
      version: "1.0.0",
      modules: [{ id: "leaf", source: LEAF_SOURCE }],
      requiredBy: ["acme.middle"],
    });
    await installLibrary({
      pkg: "acme.middle",
      version: "1.0.0",
      modules: [{ id: "middle", source: MIDDLE_SOURCE }],
      uses: [{ alias: "leaf", package: "acme.leaf", pin: "^1.0.0", isolated: false }],
    });
  }

  it("mounts the dependency realm and makes the chained call actually work", async () => {
    await installChain();
    const consumer = await mountConsumer({
      id: "c1",
      source: "// @uses mid acme.middle@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["bi.query"],
    });
    // The chained call crosses TWO realm boundaries: consumer -> middle -> leaf.
    await expect(consumer.imports.mid.middleCall()).resolves.toBe("leaf");

    const packages = listLibraryRealms().map((r) => r.package).sort();
    expect(packages).toEqual(["acme.leaf", "acme.middle"]);
    const middle = listLibraryRealms().find((r) => r.package === "acme.middle")!;
    expect(middle.dependencies).toEqual(["acme.leaf"]);
  });

  it("chains the ceiling against the PARENT, so a leaf cannot re-widen past the middle", async () => {
    await installChain();
    // The CONSUMER declares both. The MIDDLE declares only bi.query. The LEAF
    // declares both again — the classic laundering shape: if the leaf were
    // intersected against the ROOT it would get net.fetch back.
    await mountConsumer({
      id: "c1",
      source: "// @uses mid acme.middle@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["net.fetch", "bi.query"],
    });
    const leaf = listLibraryRealms().find((r) => r.package === "acme.leaf")!;
    const middle = listLibraryRealms().find((r) => r.package === "acme.middle")!;
    expect(middle.capabilities).toEqual(["bi.query"]);
    expect(leaf.capabilities).toEqual(["bi.query"]);
    expect(leaf.capabilities).not.toContain("net.fetch");

    // And the mount spec the broker built its R19 ceiling from says the same.
    const leafSpec = mountSpecs.find((s) => String(s.packageName) === "acme.leaf")!;
    expect(leafSpec.declaredCapabilities).toEqual(["bi.query"]);
  });

  it("releases the dependency realm when the last consumer of its parent goes away", async () => {
    await installChain();
    const consumer = await mountConsumer({
      id: "c1",
      source: "// @uses mid acme.middle@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["bi.query"],
    });
    expect(listLibraryRealms()).toHaveLength(2);
    consumer.release();
    // Both realms are gone — the leaf is not left mounted with a live token.
    expect(listLibraryRealms()).toEqual([]);
    expect(hostUnmountScript).toHaveBeenCalledTimes(2);
  });

  it("refuses a hand-edited lockfile whose libraries import each other", async () => {
    await installLibrary({
      pkg: "acme.a",
      version: "1.0.0",
      modules: [
        {
          id: "a",
          source: "// @uses b acme.b@^1.0.0\n// @export ping\nfunction library() { return { ping: () => 1 }; }",
        },
      ],
      uses: [{ alias: "b", package: "acme.b", pin: "^1.0.0", isolated: false }],
    });
    await installLibrary({
      pkg: "acme.b",
      version: "1.0.0",
      modules: [
        {
          id: "b",
          source: "// @uses a acme.a@^1.0.0\n// @export pong\nfunction library() { return { pong: () => 1 }; }",
        },
      ],
      uses: [{ alias: "a", package: "acme.a", pin: "^1.0.0", isolated: false }],
    });
    await expect(
      linkScript({
        scriptId: "s",
        scriptName: "s",
        source: "// @uses a acme.a@^1.0.0\nfunction setup(context) {}\n",
        declaredCapabilities: [],
        accessLevel: "restricted",
      }),
    ).rejects.toThrow(/dependency cycle/);
    // Nothing half-mounted survives the refusal.
    expect(listLibraryRealms()).toEqual([]);
  });
});

// ===========================================================================
// 10. Realm sharing must not launder net.fetch ORIGINS
//
//     Origins are intersected with the consumer's exactly as capabilities are.
//     If the sharing key ignored them, the FIRST consumer to mount a realm
//     would fix the origin allowlist for every later sharer — and a consumer
//     that declared only b.example would reach a.example through it.
// ===========================================================================

const ORIGIN_SOURCE = [
  "// @capability net.fetch https://a.example",
  "// @capability net.fetch https://b.example",
  "// @export get",
  "function library(context) { return { get: () => 1 }; }",
].join("\n");

describe("net.fetch origin narrowing across shared realms", () => {
  beforeEach(async () => {
    await installLibrary({
      pkg: "acme.http2",
      version: "1.0.0",
      modules: [{ id: "http", source: ORIGIN_SOURCE }],
    });
  });

  async function link(scriptId: string, origins: string[]): Promise<void> {
    await linkScript({
      scriptId,
      scriptName: scriptId,
      source: "// @uses h acme.http2@^1.0.0\nfunction setup(context) {}\n",
      declaredCapabilities: ["net.fetch"] as never,
      declaredNetOrigins: origins,
      accessLevel: "restricted",
    });
  }

  it("gives two consumers with DIFFERENT declared origins two different realms", async () => {
    await link("c1", ["https://a.example"]);
    await link("c2", ["https://b.example"]);

    const byOrigin = listLibraryRealms().map((r) => r.netOrigins.join(","));
    expect(byOrigin.sort()).toEqual(["https://a.example", "https://b.example"]);
    // The second consumer did NOT inherit the first's realm (and its origin).
    expect(listLibraryRealms()).toHaveLength(2);
  });

  it("still shares ONE realm when the resolved origin sets are identical", async () => {
    await link("c1", ["https://a.example"]);
    await link("c2", ["https://a.example"]);
    expect(listLibraryRealms()).toHaveLength(1);
    expect(listLibraryRealms()[0].consumers.sort()).toEqual(["c1", "c2"]);
  });

  it("narrows to the intersection — an origin the consumer never declared is dropped", async () => {
    await link("c1", ["https://b.example", "https://evil.example"]);
    expect(listLibraryRealms()[0].netOrigins).toEqual(["https://b.example"]);
  });
});

// ===========================================================================
// 11. THE CALLER'S OWN GRANTS CAP THE CALL
//
//     Wave H's second named residual. The ceiling intersection guarantees the
//     realm holds nothing the consumer did not DECLARE — but a declaration is
//     not consent. A consumer that declared `net.fetch` and was never
//     JIT-prompted could still cause egress by calling a library the user
//     approved for `net.fetch` at install time: nothing ungranted happened, but
//     the CONSUMER's own prompt was skipped, which is exactly the "I approved
//     the library, not this" confusion the whole capability model exists to
//     prevent.
//
//     Now that `base.callImport` knows who is calling, the call is additionally
//     measured against the CALLER's grants — at CALL time, never at link time
//     (a consumer legitimately holds nothing when its realm is mounted, because
//     the first USE is the prompt).
// ===========================================================================

/** A library that wants a blanket (non-origin) capability. */
const QUERY_SOURCE = [
  "// @capability bi.query",
  "// @export runQuery",
  "function library(context) {",
  "  return { runQuery: () => 'rows' };",
  "}",
].join("\n");

describe("a library call is capped by the CALLER's grants, not its declarations", () => {
  async function installQuery(): Promise<void> {
    await installLibrary({
      pkg: "acme.query",
      version: "1.0.0",
      modules: [{ id: "q", source: QUERY_SOURCE }],
    });
  }

  const USES_QUERY = "// @uses q acme.query@^1.0.0\nfunction setup(context) {}\n";

  it("THE RESIDUAL: a consumer that DECLARED but was never granted is prompted, not silently served", async () => {
    await installQuery();
    const consumer = await mountConsumer({
      id: "declares-only",
      source: USES_QUERY,
      capabilities: ["bi.query"],
    });
    // Link-time state: the realm holds bi.query (the declaration allowed it),
    // and the consumer holds NOTHING. This is the exact configuration that used
    // to reach through the library without ever asking the user.
    expect(listLibraryRealms()[0].capabilities).toEqual(["bi.query"]);
    expect(consumer.handle.grants.has("bi.query")).toBe(false);
    expect(promptLog).toEqual([]);

    await expect(consumer.imports.q.runQuery()).resolves.toBe("rows");

    expect(promptLog).toHaveLength(1);
    expect(promptLog[0]).toMatchObject({
      scriptId: "declares-only",
      capability: "bi.query",
      viaLibrary: "acme.query@1.0.0",
    });
    // HONEST CONSENT: the rendered sentence must say both what the permission
    // does and that a library is why it is being asked now.
    expect(promptLog[0].description).toMatch(/BI queries/);
    expect(promptLog[0].description).toMatch(/acme\.query@1\.0\.0/);
    expect(consumer.handle.grants.has("bi.query")).toBe(true);
  });

  it("DENYING the prompt stops the call — the library is not reached at all", async () => {
    await installQuery();
    promptAnswer = "deny";
    const consumer = await mountConsumer({
      id: "denier",
      source: USES_QUERY,
      capabilities: ["bi.query"],
    });
    await expect(consumer.imports.q.runQuery()).rejects.toMatchObject({
      name: "BrokerError",
      code: "CapabilityRequired",
      capability: "bi.query",
    });
  });

  it("a denial is remembered for the session: it does not re-ask, and it keeps failing", async () => {
    await installQuery();
    promptAnswer = "deny";
    const consumer = await mountConsumer({
      id: "denier",
      source: USES_QUERY,
      capabilities: ["bi.query"],
    });
    await expect(consumer.imports.q.runQuery()).rejects.toThrow(/bi\.query/);
    await expect(consumer.imports.q.runQuery()).rejects.toThrow(/bi\.query/);
    expect(promptLog).toHaveLength(1);
  });

  it("grants once and then stops asking — the prompt is per capability, not per call", async () => {
    await installQuery();
    const consumer = await mountConsumer({
      id: "granted",
      source: USES_QUERY,
      capabilities: ["bi.query"],
    });
    await expect(consumer.imports.q.runQuery()).resolves.toBe("rows");
    await expect(consumer.imports.q.runQuery()).resolves.toBe("rows");
    await expect(consumer.imports.q.runQuery()).resolves.toBe("rows");
    expect(promptLog).toHaveLength(1);
  });

  it("asks nothing when the consumer already holds the grant", async () => {
    await installQuery();
    recordCapabilityGrant("pre-granted", "bi.query");
    const consumer = await mountConsumer({
      id: "pre-granted",
      source: USES_QUERY,
      capabilities: ["bi.query"],
    });
    await expect(consumer.imports.q.runQuery()).resolves.toBe("rows");
    expect(promptLog).toEqual([]);
  });

  it("asks nothing for a library that holds no capabilities at all", async () => {
    await installLibrary({
      pkg: "acme.stats",
      version: "1.2.4",
      modules: [{ id: "stats", source: STATS_SOURCE }],
    });
    const consumer = await mountConsumer({
      id: "plain",
      source: "// @uses stats acme.stats@^1.2.4\nfunction setup(context) {}\n",
      capabilities: ["bi.query", "net.fetch"],
    });
    await expect(consumer.imports.stats.mean([1, 2, 3])).resolves.toBe(2);
    // The consumer DECLARED two capabilities. The library holds neither, so
    // asking about them here would be a prompt for reach this call cannot have.
    expect(promptLog).toEqual([]);
  });

  it("a DISTRIBUTED consumer is never JIT-prompted — it must already hold the grant", async () => {
    await installQuery();
    const consumer = await mountConsumer({
      id: "packaged",
      source: USES_QUERY,
      capabilities: ["bi.query"],
      provenance: "distributed",
      packageName: "acme.report",
    });
    // Package consent is the only way a distributed script acquires anything;
    // this path must not become a second one.
    await expect(consumer.imports.q.runQuery()).rejects.toMatchObject({
      code: "CapabilityRequired",
      capability: "bi.query",
    });
    expect(promptLog).toEqual([]);

    recordCapabilityGrant("packaged", "bi.query");
    await expect(consumer.imports.q.runQuery()).resolves.toBe("rows");
    expect(promptLog).toEqual([]);
  });
});

describe("net.fetch through a library is capped per ORIGIN", () => {
  const ORIGIN_LIB = [
    "// @capability net.fetch https://a.example",
    "// @capability net.fetch https://b.example",
    "// @export get",
    "function library(context) { return { get: () => 'body' }; }",
  ].join("\n");

  beforeEach(async () => {
    await installLibrary({
      pkg: "acme.http3",
      version: "1.0.0",
      modules: [{ id: "http", source: ORIGIN_LIB }],
    });
  });

  const USES_HTTP = "// @uses h acme.http3@^1.0.0\nfunction setup(context) {}\n";

  it("prompts the consumer for the exact origin the realm was granted", async () => {
    const consumer = await mountConsumer({
      id: "fetcher",
      source: USES_HTTP,
      capabilities: ["net.fetch"],
      netOrigins: ["https://a.example"],
    });
    expect(listLibraryRealms()[0].netOrigins).toEqual(["https://a.example"]);

    await expect(consumer.imports.h.get()).resolves.toBe("body");
    expect(promptLog).toHaveLength(1);
    expect(promptLog[0]).toMatchObject({
      capability: "net.fetch",
      origin: "https://a.example",
      viaLibrary: "acme.http3@1.0.0",
    });
    // The origin the consumer never declared was already dropped from the realm,
    // so it is never asked about either.
    expect(promptLog.some((p) => p.origin === "https://b.example")).toBe(false);
  });

  it("denying the origin stops the call and names the host", async () => {
    promptAnswer = "deny";
    const consumer = await mountConsumer({
      id: "fetcher",
      source: USES_HTTP,
      capabilities: ["net.fetch"],
      netOrigins: ["https://a.example"],
    });
    await expect(consumer.imports.h.get()).rejects.toMatchObject({
      code: "CapabilityRequired",
      capability: "net.fetch",
    });
    await expect(consumer.imports.h.get()).rejects.toThrow(/https:\/\/a\.example/);
  });

  it("asks per origin: a realm granted TWO hosts asks about both", async () => {
    const consumer = await mountConsumer({
      id: "fetcher",
      source: USES_HTTP,
      capabilities: ["net.fetch"],
      netOrigins: ["https://a.example", "https://b.example"],
    });
    await expect(consumer.imports.h.get()).resolves.toBe("body");
    expect(promptLog.map((p) => p.origin).sort()).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("a net.fetch realm with NO resolved origins asks nothing — it can reach no host", async () => {
    const consumer = await mountConsumer({
      id: "originless",
      source: USES_HTTP,
      capabilities: ["net.fetch"],
      netOrigins: ["https://c.example"], // intersects with neither of the library's
    });
    expect(listLibraryRealms()[0].netOrigins).toEqual([]);
    await expect(consumer.imports.h.get()).resolves.toBe("body");
    // Nothing to consent to: the Rust gate matches per origin, and the realm has
    // none, so no fetch it attempts can succeed.
    expect(promptLog).toEqual([]);
  });
});

describe("the transitive chain narrows at every hop, at CALL time too", () => {
  const LEAF = [
    "// @capability net.fetch https://leaf.example",
    "// @capability bi.query",
    "// @export leafCall",
    "function library(context) { return { leafCall: () => 'leaf' }; }",
  ].join("\n");
  const MIDDLE = [
    "// @capability bi.query",
    "// @uses leaf acme.leaf2@^1.0.0",
    "// @export middleCall",
    "function library(context) {",
    "  return { middleCall: async () => await imports.leaf.leafCall() };",
    "}",
  ].join("\n");

  beforeEach(async () => {
    await installLibrary({
      pkg: "acme.leaf2",
      version: "1.0.0",
      modules: [{ id: "leaf", source: LEAF }],
      requiredBy: ["acme.middle2"],
    });
    await installLibrary({
      pkg: "acme.middle2",
      version: "1.0.0",
      modules: [{ id: "middle", source: MIDDLE }],
      uses: [{ alias: "leaf", package: "acme.leaf2", pin: "^1.0.0", isolated: false }],
    });
  });

  it("prompts only for what the REALM holds, never for everything the consumer declared", async () => {
    const consumer = await mountConsumer({
      id: "root",
      source: "// @uses mid acme.middle2@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["net.fetch", "bi.query"],
      netOrigins: ["https://leaf.example"],
    });
    await expect(consumer.imports.mid.middleCall()).resolves.toBe("leaf");

    // The middle library declares only bi.query, so the leaf's net.fetch was
    // already narrowed away two hops down. The consumer must therefore be asked
    // about bi.query and NOTHING else — asking for net.fetch here would be
    // consent text that does not match the call's real reach.
    expect(promptLog.map((p) => p.capability)).toEqual(["bi.query"]);
    expect(listLibraryRealms().find((r) => r.package === "acme.leaf2")!.capabilities).toEqual([
      "bi.query",
    ]);
    expect(listLibraryRealms().find((r) => r.package === "acme.leaf2")!.netOrigins).toEqual([]);
  });

  it("a dep realm resolves through the PARENT REALM's own import table", async () => {
    const consumer = await mountConsumer({
      id: "root",
      source: "// @uses mid acme.middle2@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["bi.query"],
    });
    await expect(consumer.imports.mid.middleCall()).resolves.toBe("leaf");

    const middle = listLibraryRealms().find((r) => r.package === "acme.middle2")!;
    const leaf = listLibraryRealms().find((r) => r.package === "acme.leaf2")!;
    // The middle realm is a CONSUMER in its own right: its "leaf" alias lives in
    // the host table keyed by ITS scriptId, not the root's. The root has no
    // entry for "leaf" and so can never address the leaf directly.
    expect(listScriptImports(middle.scriptId).map((b) => b.alias)).toEqual(["leaf"]);
    expect(listScriptImports(middle.scriptId)[0].libraryScriptId).toBe(leaf.scriptId);
    expect(listScriptImports("root").map((b) => b.alias)).toEqual(["mid"]);
    await expect(
      authorizeImportCall({
        handle: consumer.handle,
        consumerSource: "",
        alias: "leaf",
        methodName: "leafCall",
      }),
    ).rejects.toThrow(/did not declare a library aliased 'leaf'/);
  });

  it("releasing the root revokes every table in the chain", async () => {
    const consumer = await mountConsumer({
      id: "root",
      source: "// @uses mid acme.middle2@^1.0.0\nfunction setup(context) {}\n",
      capabilities: ["bi.query"],
    });
    const middle = listLibraryRealms().find((r) => r.package === "acme.middle2")!;
    consumer.release();
    expect(listLibraryRealms()).toEqual([]);
    expect(listScriptImports("root")).toEqual([]);
    expect(listScriptImports(middle.scriptId)).toEqual([]);
  });
});

describe("the import table is host state, and only trusted code writes it", () => {
  it("registerScriptImports replaces a script's table wholesale (a relink is not a merge)", () => {
    const binding = {
      alias: "a",
      package: "p",
      version: "1.0.0",
      libraryScriptId: "lib-1",
      objectType: "workbook",
      instanceId: "__lib_1",
      entryMethod: `${HOST_ONLY_EXPOSED_PREFIX}callImport`,
      exports: ["x"],
      capabilities: [],
      netOrigins: [],
    };
    registerScriptImports("s", [binding]);
    registerScriptImports("s", [{ ...binding, alias: "b" }]);
    expect(listScriptImports("s").map((b) => b.alias)).toEqual(["b"]);
  });

  it("a registered binding is frozen — mutating the linker's object cannot widen it", () => {
    const caps: string[] = [];
    const exports: string[] = ["x"];
    registerScriptImports("s", [
      {
        alias: "a",
        package: "p",
        version: "1.0.0",
        libraryScriptId: "lib-1",
        objectType: "workbook",
        instanceId: "__lib_1",
        entryMethod: `${HOST_ONLY_EXPOSED_PREFIX}callImport`,
        exports,
        capabilities: caps as never,
        netOrigins: [],
      },
    ]);
    // Late mutation of the arrays the caller still holds.
    caps.push("net.fetch");
    exports.push("y");
    const stored = listScriptImports("s")[0];
    expect(stored.capabilities).toEqual([]);
    expect(stored.exports).toEqual(["x"]);
  });
});
